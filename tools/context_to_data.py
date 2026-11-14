# 周邊地景（建築量體＋樹）→ model/context_buildings.bin、model/context_trees.bin
#
# 建築：Overture Maps 建築（theme=buildings/type=building，含 OpenStreetMap 與 Microsoft 衛星影像判釋的外框，ODbL），
#   用 pyarrow 依 bbox 從 s3://overturemaps-us-west-2/release/<版本>/ 讀出這一塊，存成 parquet（geometry 為 WKB）。
#   高度：height → 直接用；num_floors → 層數 × 3.3 m＋1 m；都沒有時依面積估算（見 est_height）。
# 樹：ESA WorldCover 10 m（2021 v200，Sentinel 衛星影像分類）的 Tree cover（類別 10）格子，每格 1～2 棵、位置隨機偏移。
#   讀取方式見 README 段落（rasterio 讀 COG 的一小塊，存成 wc.npy＋wc_tf.txt）。
# 座標：與 js/horizon.js 的 OSM 地圖對位相同（site.json 的 map.anchor／rotate_deg／scale／shift_m 與 northOffset_deg），
#   輸出為網頁座標（m，x 東西、z 南北），以 0.25 m 為單位存成 int16。
# 範圍：最遠縮放時畫面看得到的範圍（以基地中心為準 ±1150 m × ±650 m）；基地（模型地坪）範圍內不放，避免蓋到模型。
#
# 行道樹：另外給 OSM XML 資料夾（api.openstreetmap.org/api/0.6/map 下載）時，natural=tree_row 沿線每 7 m 加一棵、natural=tree 單棵。
# 用法：python3 tools/context_to_data.py <overture_buildings.parquet> <wc.npy> <wc_tf.txt> [osm xml 資料夾]
import json, math, os, random, struct, sys, glob
import xml.etree.ElementTree as ET
import numpy as np, pyarrow.parquet as pq, shapely

ROOT = os.path.join(os.path.dirname(__file__), '..')
site = json.load(open(os.path.join(ROOT, 'config/site.json'), encoding='utf-8'))
M = site['map']
LAT0, LON0 = M['anchor']['lat'], M['anchor']['lon']
AX, AZ = M['anchor']['at_cm'][0] / 100, -M['anchor']['at_cm'][1] / 100
A = math.radians(site.get('northOffset_deg', 0) + M.get('rotate_deg', 0))
S = M.get('scale', 1); SE, SN = M.get('shift_m', [0, 0])
R = 6378137
C, SNA = math.cos(A), math.sin(A)
CX, CZ, HX, HZ = 137, -153, 1150, 650                    # 顯示範圍（網頁座標 m）
SITE = (-108.7, 408.3, -418.1, 18.1)                     # 基地地坪範圍（horizon.js 的 siteRect）
Q = 0.25                                                 # 座標單位（m）


def ll2w(lat, lon):
    """經緯度 → 網頁座標 (x, z)（horizon.js worldToLL 的反函數）"""
    e = math.radians(lon - LON0) * R * math.cos(math.radians(LAT0))
    n = math.radians(lat - LAT0) * R
    u, v = (e + SE) / S, (n + SN) / S
    return AX + u * C + v * SNA, AZ + u * SNA - v * C


def in_view(x, z): return abs(x - CX) < HX and abs(z - CZ) < HZ
def in_site(x, z, pad=0): return SITE[0] - pad < x < SITE[1] + pad and SITE[2] - pad < z < SITE[3] + pad


def area(P):
    return 0.5 * sum(P[i][0] * P[i - 1][1] - P[i - 1][0] * P[i][1] for i in range(len(P)))


def est_height(tags, a):
    h = tags.get('height', '').replace('m', '').strip()
    try:
        if h: return max(3, min(200, float(h)))
    except ValueError: pass
    lv = tags.get('building:levels', '').strip()
    try:
        if lv: return max(3, min(200, float(lv) * 3.3 + 1))
    except ValueError: pass
    if tags.get('building') in ('roof', 'carport', 'kiosk', 'shed', 'hut', 'garage', 'toilets'): return 3.5
    # 依面積估算（高雄常見：小屋 2F、透天 4F、公寓 5F、大樓 7～11F）
    for lim, hh in ((40, 6), (150, 13), (400, 16), (1200, 22), (3000, 30)):
        if a < lim: return hh
    return 36


def simplify(P, tol=0.3):
    """去掉重複點與幾乎共線的點"""
    out = []
    for p in P:
        if out and math.dist(out[-1], p) < 0.2: continue
        out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) < 0.2: out.pop()
    ch = True
    while ch and len(out) > 3:
        ch = False
        for i in range(len(out)):
            a, b, c = out[i - 1], out[i], out[(i + 1) % len(out)]
            L = math.dist(a, c)
            d = abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L if L > 1e-6 else 0
            if d < tol: out.pop(i); ch = True; break
    return out


# ---------- 建築 ----------
tb = pq.read_table(sys.argv[1]).to_pydict()
blds = []
for g, hh, nf, cl in zip(tb['geometry'], tb['height'], tb['num_floors'], tb['class']):
    geom = shapely.from_wkb(g)
    for poly in getattr(geom, 'geoms', [geom]):
        P = simplify([ll2w(y, x) for x, y in list(poly.exterior.coords)[:-1]])
        if len(P) < 3: continue
        cx, cz = sum(p[0] for p in P) / len(P), sum(p[1] for p in P) / len(P)
        if not in_view(cx, cz) or in_site(cx, cz): continue
        a = area(P)
        if abs(a) < 8: continue
        if a < 0: P = P[::-1]
        tags = {'building': cl or ''}
        if hh: tags['height'] = str(hh)
        if nf: tags['building:levels'] = str(nf)
        blds.append((est_height(tags, abs(a)), P))
# ---------- 指標建築（資料庫裡沒有或只有工地範圍；依照片與衛星空拍粗略建構，網頁座標 m） ----------
def rect(cx, cz, w, d, deg):
    a = math.radians(deg); ca, sa = math.cos(a), math.sin(a)
    return [(cx + u * ca - v * sa, cz + u * sa + v * ca) for u, v in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
def inside(x, z, P):
    c = False
    for i in range(len(P)):
        (x1, z1), (x2, z2) = P[i - 1], P[i]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1: c = not c
    return c
# 基地範圍（OSM）：範圍內原有的量體先移除
O10 = [(28.9, -460.3), (189.1, -520.0), (216.8, -443.2), (217.4, -439.4), (214.2, -435.3), (107.1, -378.7), (98.9, -395.4), (90.9, -400.6), (59.3, -385.2)]
TZUCHI = [(297, -339), (263, -409), (346, -454), (401, -354), (391, -342)]
LALA = [(339, -469), (484, -546), (502, -511), (544, -533), (562, -487), (568, -464), (570, -452), (569, -435), (539, -325), (439, -285), (414, -334), (391, -342), (401, -354), (346, -454)]
TZUCHI_HALL = [(279.1, -413.0), (336.6, -441.7), (365.2, -384.5), (361.6, -382.7), (363.7, -378.5), (311.0, -352.2), (298.4, -377.4), (305.3, -380.8), (308.4, -374.5), (314.0, -377.2), (315.5, -374.2), (324.0, -378.4), (321.8, -382.8), (336.1, -389.9), (338.0, -386.2), (345.7, -390.0), (331.7, -418.2), (324.3, -414.5), (326.4, -410.3), (311.4, -402.8), (309.5, -406.5), (302.5, -403.0), (304.4, -399.2), (300.8, -397.3), (303.5, -392.0), (292.3, -386.4)]
F = 3.45                                                  # 住宅大樓層高（m）
LANDMARKS = [
    # 衛武營藝術之丘（捷運 O10／Y18 衛武營站土地開發案）：四棟 38～52 層（由西到東 52、42、38、46）＋西南角旅館棟＋低層裙樓
    (8, [(44, -452), (182, -503), (203, -447), (112, -398), (100, -410), (88, -413), (64, -402)]),
    (52 * F, rect(84, -436, 30, 40, -22)), (42 * F, rect(118, -449, 28, 38, -22)),
    (38 * F, rect(150, -461, 28, 38, -22)), (46 * F, rect(182, -472, 28, 40, -22)),
    (48, rect(80, -410, 22, 20, -22)),
    # 慈濟鳳山靜思堂：OSM 外框 4 層＋中央挑高的講堂
    (20, TZUCHI_HALL), (27, rect(322, -397, 44, 26, 26.5)),
    # LaLaport 高雄（鳳山）：商場主量體＋中央較高的影城／機房量體＋西北側立體停車場
    (27, [(352, -458), (480, -528), (497, -496), (538, -517), (553, -480), (556, -440), (530, -338), (445, -303), (424, -345), (400, -360)]),
    (38, rect(478, -420, 70, 50, -20)), (33, rect(392, -452, 60, 34, 28)),
]
blds = [(h, P) for h, P in blds if not any(inside(sum(p[0] for p in P) / len(P), sum(p[1] for p in P) / len(P), S_) for S_ in (O10, TZUCHI, LALA))]
for h, P in LANDMARKS:
    if area(P) < 0: P = P[::-1]
    blds.append((h, P))
print('buildings', len(blds), 'verts', sum(len(p) for _, p in blds))

out = bytearray(b'NKCB') + struct.pack('<I', len(blds))
for h, P in blds:
    out += struct.pack('<HH', round(h * 10), len(P))
    for x, z in P: out += struct.pack('<hh', round(x / Q), round(z / Q))
open(os.path.join(ROOT, 'model/context_buildings.bin'), 'wb').write(out)
print('context_buildings.bin', len(out), 'bytes')

# ---------- 樹 ----------
wc = np.load(sys.argv[2])
ta, tb, tc, td, te, tf = map(float, open(sys.argv[3]).read().split())
# 建築佔用格（2 m 格）：樹不要長在建築裡
occ = set()
for h, P in blds:
    xs, zs = [p[0] for p in P], [p[1] for p in P]
    for gx in range(int(min(xs) // 2), int(max(xs) // 2) + 1):
        for gz in range(int(min(zs) // 2), int(max(zs) // 2) + 1):
            x, z = gx * 2 + 1, gz * 2 + 1
            ins = False
            for i in range(len(P)):
                (x1, z1), (x2, z2) = P[i - 1], P[i]
                if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1: ins = not ins
            if ins: occ.add((gx, gz))
rnd = random.Random(7)
trees = []
for r, c in zip(*np.nonzero(wc == 10)):
    for k in range(1 if rnd.random() < 0.55 else 2):
        lon = tc + (c + rnd.random()) * ta; lat = tf + (r + rnd.random()) * te
        x, z = ll2w(lat, lon)
        if not in_view(x, z) or in_site(x, z, 2) or (int(x // 2), int(z // 2)) in occ: continue
        size = rnd.uniform(2.2, 4.4)                       # 樹冠半徑（m）
        trees.append((x, z, size, rnd.randrange(4)))
# 行道樹（OSM）
if len(sys.argv) > 4:
    done = set()                                       # 同一條行道樹／同一棵樹會出現在相鄰的幾個圖塊裡
    for f in sorted(glob.glob(os.path.join(sys.argv[4], '*.xml'))):
        root = ET.parse(f).getroot(); nodes = {}
        pts = []
        for el in root:
            if el.tag == 'node':
                nodes[el.get('id')] = (float(el.get('lat')), float(el.get('lon')))
                if el.get('id') not in done and any(t.get('k') == 'natural' and t.get('v') == 'tree' for t in el.findall('tag')):
                    done.add(el.get('id')); pts.append(ll2w(*nodes[el.get('id')]))
            elif el.tag == 'way' and 'w' + el.get('id') not in done and any(t.get('k') == 'natural' and t.get('v') == 'tree_row' for t in el.findall('tag')):
                done.add('w' + el.get('id'))
                P = [ll2w(*nodes[nd.get('ref')]) for nd in el.findall('nd') if nd.get('ref') in nodes]
                for (x1, z1), (x2, z2) in zip(P, P[1:]):
                    L = math.dist((x1, z1), (x2, z2))
                    for i in range(int(L // 7) + 1):
                        t = (i * 7 + 3.5) / max(L, 1e-6)
                        if t <= 1: pts.append((x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
        for x, z in pts:
            if in_view(x, z) and not in_site(x, z, 2) and (int(x // 2), int(z // 2)) not in occ:
                trees.append((x, z, rnd.uniform(1.8, 2.8), rnd.randrange(4)))
print('trees', len(trees))
out = bytearray(b'NKCT') + struct.pack('<I', len(trees))
for x, z, s, v in trees: out += struct.pack('<hhBB', round(x / Q), round(z / Q), round(s * 20), v)
open(os.path.join(ROOT, 'model/context_trees.bin'), 'wb').write(out)
print('context_trees.bin', len(out), 'bytes')
