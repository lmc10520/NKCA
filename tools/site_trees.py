# 基地（模型範圍）內的樹 → model/context_site_trees.bin
#
# 候選位置：
#   - ESA WorldCover 10 m 樹冠覆蓋（類別 10）落在基地內的格子，每格 1～2 棵、隨機偏移（同 context_to_data.py）
#   - OpenStreetMap 的行道樹（natural=tree_row）沿線每 7 m 一棵、natural=tree 單棵
# 高度與篩選：用 Fusion 原始匯出的模型（raw/nkca.glb.gz.part* 還原）從上往下打射線，取最上層的面：
#   樹冠覆蓋的樹只能長在草地／土丘上；行道樹另外可以在人行道、鋪面上。屋頂、道路、廣場內部等其他面都不放。
# 檔案格式：'NKCS'、數量，每棵 [x, z × 0.25 m（int16）、高度 cm（int16）、樹冠半徑 × 0.05 m（uint8）、顏色（uint8）]
#
# 用法：python3 tools/site_trees.py <nkca.glb（原始匯出）> <osm xml 資料夾> <wc.npy> <wc_tf.txt>
import glob, json, math, os, random, re, struct, sys
import xml.etree.ElementTree as ET
import numpy as np, trimesh

ROOT = os.path.join(os.path.dirname(__file__), '..')
site = json.load(open(os.path.join(ROOT, 'config/site.json'), encoding='utf-8'))
M = site['map']
LAT0, LON0 = M['anchor']['lat'], M['anchor']['lon']
AX, AZ = M['anchor']['at_cm'][0] / 100, -M['anchor']['at_cm'][1] / 100
A = math.radians(site.get('northOffset_deg', 0) + M.get('rotate_deg', 0))
S = M.get('scale', 1); SE, SN = M.get('shift_m', [0, 0]); R = 6378137
C, SA = math.cos(A), math.sin(A)
SITE = (-108.7, 408.3, -418.1, 18.1)
LAWN = re.compile(r'^(Site_Grass|Site_Grass_RampCover|Site_North_Mound_Solid)$')
STREET = re.compile(r'^(Site_Grass|Site_Grass_RampCover|Site_North_Mound_Solid|Site_Sidewalk|Site_Park_Paving|Site_Campus_Paving)$')


def ll2w(lat, lon):
    e = math.radians(lon - LON0) * R * math.cos(math.radians(LAT0)); n = math.radians(lat - LAT0) * R
    u, v = (e + SE) / S, (n + SN) / S
    return AX + u * C + v * SA, AZ + u * SA - v * C


def in_site(x, z): return SITE[0] < x < SITE[1] and SITE[2] < z < SITE[3]


rnd = random.Random(11)
cand = []                                   # (x, z, 半徑, 是否行道樹)
wc = np.load(sys.argv[3]); ta, tb, tc, td, te, tf = map(float, open(sys.argv[4]).read().split())
for r, c in zip(*np.nonzero(wc == 10)):
    for k in range(1 if rnd.random() < 0.55 else 2):
        x, z = ll2w(tf + (r + rnd.random()) * te, tc + (c + rnd.random()) * ta)
        if in_site(x, z): cand.append((x, z, rnd.uniform(2.2, 4.0), False))
done = set()                                # 同一條行道樹會出現在相鄰的幾個圖塊裡
for f in sorted(glob.glob(os.path.join(sys.argv[2], '*.xml'))):
    root = ET.parse(f).getroot(); nodes = {}
    for el in root:
        if el.tag == 'node':
            nodes[el.get('id')] = (float(el.get('lat')), float(el.get('lon')))
            if el.get('id') not in done and any(t.get('k') == 'natural' and t.get('v') == 'tree' for t in el.findall('tag')):
                done.add(el.get('id')); x, z = ll2w(*nodes[el.get('id')])
                if in_site(x, z): cand.append((x, z, rnd.uniform(1.8, 2.8), True))
        elif el.tag == 'way' and 'w' + el.get('id') not in done and any(t.get('k') == 'natural' and t.get('v') == 'tree_row' for t in el.findall('tag')):
            done.add('w' + el.get('id'))
            P = [ll2w(*nodes[nd.get('ref')]) for nd in el.findall('nd') if nd.get('ref') in nodes]
            for (x1, z1), (x2, z2) in zip(P, P[1:]):
                L = math.dist((x1, z1), (x2, z2))
                for i in range(int(L // 7) + 1):
                    t = (i * 7 + 3.5) / max(L, 1e-6)
                    if t > 1: break
                    x, z = x1 + (x2 - x1) * t, z1 + (z2 - z1) * t
                    if in_site(x, z): cand.append((x, z, rnd.uniform(1.8, 2.8), True))
print('candidates', len(cand))

# 模型：所有物件合成一個網格，記錄每個面屬於哪個物件
scene = trimesh.load(sys.argv[1], force='scene')
parts, names = [], []
for n in scene.graph.nodes_geometry:
    T, g = scene.graph[n]
    m = scene.geometry[g].copy(); m.apply_transform(T)
    parts.append(m); names.append(n)
counts = np.cumsum([len(m.faces) for m in parts])
mesh = trimesh.util.concatenate(parts)
o = np.array([[x, 60.0, z] for x, z, _, _ in cand]); d = np.tile([0, -1.0, 0], (len(o), 1))
tri = mesh.ray.intersects_first(o, d)
out = []
for (x, z, r, street), fi in zip(cand, tri):
    if fi < 0: continue
    name = names[int(np.searchsorted(counts, fi, side='right'))]
    if not (STREET if street else LAWN).match(name): continue
    hit = mesh.ray.intersects_location([[x, 60.0, z]], [[0, -1.0, 0]], multiple_hits=False)[0]
    y = float(hit[0][1]) if len(hit) else 0.0
    if y > 10: continue
    out.append((x, z, y, r, rnd.randrange(4)))
print('trees in site', len(out), 'street', sum(1 for c in cand if c[3]))
buf = bytearray(b'NKCS') + struct.pack('<I', len(out))
for x, z, y, r, v in out: buf += struct.pack('<hhhBB', round(x / 0.25), round(z / 0.25), round(y * 100), round(r * 20), v)
open(os.path.join(ROOT, 'model/context_site_trees.bin'), 'wb').write(buf)
print('context_site_trees.bin', len(buf), 'bytes')
