# 地下停車場 B1／B2 的車流 → 寫進 config/roads.json
#
# 地面上原本的進出停車場路線（car_00、car_08 西側；car_09、car_10 東側）只開到坡道上蓋底下就消失，
# 在 B1／B2 模式上蓋收起來後會看到車開到一半懸空消失，所以：
#   - 這四條加上 hideModes: ["b1", "b2"]（地下停車場模式時不出現）
#   - 另外產生 pk_* 路線（modes: ["b1"] 或 ["b2"]），車輛持續進出（不在停車場內消失）：
#     地面道路（原本進場路線）→ 坡道下到該層 → 停車場內依車流動線圖行駛 → 坡道上來 → 地面道路（原本出場路線）
#
# 停車場內動線：tools/data/parking_flow.json（20261023 地下停車場車流動線 PDF 的黑線，B1 4 條、B2 5 條，繪製方向＝行車方向）。
# PDF 與 img/parking_B1／B2.svg 同一張畫板：x 66～1124 pt ＝ Fusion 2620～24871 cm；y 由畫板上緣 105（B1）／94（B2）往下，
# 726 pt ＝ 15687 cm（與 config/modes.json 的 plan.viewBox／frame 相同）。
#
# 坡道（右側通行，坡道牆位置由模型量測）：
#   西側：進場從西邊斜坡下來。到 B1 的車靠內側（東北側）、從島的南邊進 B1；到 B2 的車靠外側、走南側坡道（Ramp_W_B2_Down）往東下。
#         出場：B1 從島的北邊出、在島與北側 B2 坡道西牆之間往北；B2 走北側坡道（Ramp_W_B2_Up）往西再往北爬；
#         兩者在坡道頂端會合，沿北邊車道東側（東牆內）往北接回地面。
#   東側：進場從北邊車道下來。到 B2 的車進北側坡道（Ramp_E_B2_Up，兩側有牆）往南再往西下；到 B1 的車走坡道東牆與島之間，
#         從島尾的北半邊往西進 B1。出場：B1 從島尾的南半邊往東、繞過南側 B2 坡道北牆；B2 走南側坡道（Ramp_E_B2_Down）往東爬；
#         兩者在島的東側會合往北，接東邊車道回地面。
#
# 坡道路面高度：tools/data/ramp_heights.json（由網頁模型量測）；建築內 B1 地板 -450、B2 地板 -800（cm）。
# 用法：python3 tools/parking_routes.py（tools/traffic_to_config.py 重新產生 roads.json 後要再執行一次）
import json, math, os

ROOT = os.path.join(os.path.dirname(__file__), '..')
H = json.load(open(os.path.join(ROOT, 'tools/data/ramp_heights.json'), encoding='utf-8'))
FLOW = json.load(open(os.path.join(ROOT, 'tools/data/parking_flow.json'), encoding='utf-8'))
FLOOR = {'B1': -450, 'B2': -800}
BX0, BX1 = 2620, 24871          # 建築（停車場）東西邊界
PLAN_Y0 = {'B1': 105, 'B2': 94}


def ramp_z(x, y, k):
    """坡道路面高度：取最近的量測格；找不到時往外找 3 格"""
    side = H['W'] if x < 14000 else H['E']
    g, st = side['g'][k], H['step']
    c, r = round((x - side['x0']) / st), round((side['y1'] - y) / st)
    for rad in range(4):
        best = None
        for dr in range(-rad, rad + 1):
            for dc in range(-rad, rad + 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < len(g) and 0 <= cc < len(g[0]) and g[rr][cc] is not None:
                    d = dr * dr + dc * dc
                    if best is None or d < best[0]: best = (d, g[rr][cc])
        if best: return best[1]
    return None


def catmull(pts, step=250):
    """2D centripetal Catmull-Rom，約每 step cm 取一點；回傳 (x, y, 所屬航點序號)"""
    P = [p[:2] for p in pts]
    P = [P[0]] + P + [P[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        def tj(ti, a, b): return ti + max(1e-6, math.dist(a, b)) ** 0.5
        t0 = 0; t1 = tj(t0, p0, p1); t2 = tj(t1, p1, p2); t3 = tj(t2, p2, p3)
        n = max(1, round(math.dist(p1, p2) / step))
        for s in range(n):
            t = t1 + (t2 - t1) * s / n
            def lerp(a, b, ta, tb): return [(tb - t) / (tb - ta) * a[k] + (t - ta) / (tb - ta) * b[k] for k in (0, 1)]
            A1 = lerp(p0, p1, t0, t1); A2 = lerp(p1, p2, t1, t2); A3 = lerp(p2, p3, t2, t3)
            B1 = lerp(A1, A2, t0, t2); B2 = lerp(A2, A3, t1, t3)
            C = lerp(B1, B2, t1, t2)
            out.append((C[0], C[1], i - 1))
    out.append((P[-2][0], P[-2][1], len(pts) - 1))
    return out


def build(way, level):
    """航點 (x, y, 路面) → [x, y, z]；路面：F／D／U＝坡道、數字＝沿用該高度、None＝建築內該層地板"""
    smp = catmull(way)
    res = []
    for x, y, i in smp:
        tag = way[i][2] if i < len(way) else way[-1][2]
        if BX0 <= x <= BX1: z = FLOOR[level]
        elif tag in ('F', 'D', 'U'): z = ramp_z(x, y, tag)
        elif isinstance(tag, (int, float)): z = tag
        else: z = None
        res.append([round(x), round(y), z])
    # 量不到的點：前後內插
    for k, p in enumerate(res):
        if p[2] is None:
            a = next((j for j in range(k - 1, -1, -1) if res[j][2] is not None), None)
            b = next((j for j in range(k + 1, len(res)) if res[j][2] is not None), None)
            if a is None: p[2] = res[b][2]
            elif b is None: p[2] = res[a][2]
            else: p[2] = round(res[a][2] + (res[b][2] - res[a][2]) * (k - a) / (b - a))
    # 坡道上的高度稍微平滑（不同坡面交接處不會突然折一下，車身才不會猛抬頭）；建築內地板與兩端不動
    for _ in range(4):
        z = [p[2] for p in res]
        for k in range(1, len(res) - 1):
            if not (BX0 <= res[k][0] <= BX1): res[k][2] = round((z[k - 1] + 2 * z[k] + z[k + 1]) / 4)
    return res


def flow_path(level, color, trim=700):
    """車流動線（PDF pt）→ Fusion cm；去掉靠近出入口的頭尾（由坡道航點接上），直角轉彎修圓（約 3 m）"""
    y0 = PLAN_Y0[level]
    P = [(BX0 + (u - 66) / 1058 * (BX1 - BX0), 23206 - (v - y0) / 726 * 15687) for u, v in FLOW[level][color]]
    near = lambda p: p[0] < BX0 + trim or p[0] > BX1 - trim
    a = next(i for i, p in enumerate(P) if not near(p))
    b = len(P) - next(i for i, p in enumerate(reversed(P)) if not near(p))
    P = P[a:b]
    # 每 50 cm 重新取樣 → 高斯平滑（σ 約 2.5 m）→ 每 250 cm 取一點
    L = [0]
    for i in range(1, len(P)): L.append(L[-1] + math.dist(P[i - 1], P[i]))
    def at(s):
        j = max(1, min(len(P) - 1, next((k for k in range(1, len(L)) if L[k] >= s), len(L) - 1)))
        t = (s - L[j - 1]) / max(1e-6, L[j] - L[j - 1])
        return (P[j - 1][0] + (P[j][0] - P[j - 1][0]) * t, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * t)
    S = [at(i * 50) for i in range(int(L[-1] // 50) + 1)]
    sig = 5; w = [math.exp(-k * k / (2 * sig * sig)) for k in range(-3 * sig, 3 * sig + 1)]
    sm = []
    for i in range(len(S)):
        sx = sy = sw = 0
        for k, wk in enumerate(w):
            j = min(len(S) - 1, max(0, i + k - 3 * sig)); sx += S[j][0] * wk; sy += S[j][1] * wk; sw += wk
        sm.append((sx / sw, sy / sw))
    sm = sm[::5] + [sm[-1]]
    return [(round(x), round(y), None) for x, y in sm]


roads_f = os.path.join(ROOT, 'config/roads.json')
roads = json.load(open(roads_f, encoding='utf-8'))
R = {r['id']: r for r in roads['routes']}
ROAD = {'w_in': R['car_00']['pts_cm'], 'w_out': R['car_08']['pts_cm'], 'e_in': R['car_09']['pts_cm'], 'e_out': R['car_10']['pts_cm']}

# ---------- 坡道航點（Fusion cm）：進場到建築邊界為止、出場從建築邊界開始 ----------
W_DIAG = [(-1750, 11650, 'F'), (-1300, 11150, 'F'), (-800, 10550, 'F')]
RAMP = {
    # 西側進場：B1 靠內側（東北），從島尾南邊進；B2 靠外側，進南側坡道
    ('w_in', 'B1'): W_DIAG + [(-300, 9950, 'F'), (200, 9500, 'F'), (600, 9200, 'F'), (900, 8990, 'F'), (1300, 8820, 'F'), (1700, 8740, 'F'), (2620, 8730, None)],
    ('w_in', 'B2'): W_DIAG + [(-380, 9880, 'F'), (80, 9330, 'F'), (450, 9000, 'F'), (750, 8760, 'D'), (1100, 8590, 'D'), (1600, 8460, 'D'), (2620, 8420, None)],
    # 西側出場：B1 從島尾北邊往西、在島與 B2 坡道西牆（x≈1020）之間往北；B2 走北側坡道往西再往北；坡道頂端沿北邊車道東側往北
    ('w_out', 'B1'): [(2620, 9130, None), (2000, 9120, 'F'), (1350, 9150, 'F'), (950, 9350, 'F'), (860, 9750, 'F'), (860, 10350, 'F'),
                      (930, 10700, 'F'), (1100, 10980, 'F'), (1200, 11400, 'F'), (1250, 11900, 'F'), (1310, 12250, 'F')],
    ('w_out', 'B2'): [(2620, 9450, None), (2000, 9450, 'U'), (1500, 9460, 'U'), (1260, 9650, 'U'), (1230, 10100, 'U'), (1220, 10600, 'U'),
                      (1210, 11000, 'F'), (1240, 11450, 'F'), (1260, 11900, 'F'), (1310, 12250, 'F')],
    # 東側進場：B2 進北側坡道（兩側牆之間）往南再往西；B1 走坡道東牆與島之間，從島尾北半邊往西
    ('e_in', 'B1'): [(26200, 12550, 'F'), (26350, 12000, 'F'), (26550, 11400, 'F'), (26620, 10700, 'F'), (26620, 10000, 'F'), (26520, 9550, 'F'),
                     (26250, 9220, 'F'), (25800, 9050, 'F'), (24871, 9030, None)],
    ('e_in', 'B2'): [(26200, 12550, 'F'), (26300, 12000, 'F'), (26300, 11300, 'F'), (26280, 10600, 'U'), (26280, 10000, 'U'), (26200, 9650, 'U'),
                     (25900, 9450, 'U'), (25400, 9420, 'U'), (24871, 9420, None)],
    # 東側出場：B2 沿南側坡道往東爬（使用者標示的黃線）；B1 從島尾南半邊往東、繞到 B2 坡道北牆的北邊；兩者在島的東側會合往北
    ('e_out', 'B1'): [(24871, 8690, None), (25500, 8690, 'F'), (26150, 8720, 'F'), (26600, 8930, 'F'), (27000, 9200, 'F'), (27330, 9500, 'F'),
                      (27480, 10000, 'F'), (27600, 10700, 'F'), (27780, 11250, 'F'), (28250, 11750, 'F')],
    ('e_out', 'B2'): [(24871, 8270, None), (25500, 8290, 'D'), (26100, 8330, 'D'), (26680, 8580, 'D'), (27180, 8920, 'F'), (27430, 9330, 'F'),
                      (27520, 10000, 'F'), (27620, 10700, 'F'), (27780, 11250, 'F'), (28250, 11750, 'F')],
}

# ---------- 停車場內動線（PDF 顏色）：從哪側進、從哪側出 ----------
FLOWS = {
    'B1': {'red': ('e', 'w'), 'green': ('w', 'e'), 'blue': ('w', 'w'), 'magenta': ('e', 'w')},
    'B2': {'red': ('e', 'e'), 'green': ('w', 'e'), 'blue': ('e', 'w'), 'magenta': ('w', 'w'), 'orange': ('e', 'w')},
}


def route(level, color, side_in, side_out):
    rin, rout = ROAD[side_in + '_in'], ROAD[side_out + '_out']
    way = ([tuple(rin[-2]), tuple(rin[-1])] + RAMP[(side_in + '_in', level)] + flow_path(level, color)
           + RAMP[(side_out + '_out', level)] + [tuple(rout[0]), tuple(rout[1])])
    pts = build(way, level)
    return rin[:-2] + pts[:-2] + rout


roads['routes'] = [r for r in roads['routes'] if not r['id'].startswith('pk_')]
for k in ('car_00', 'car_08', 'car_09', 'car_10'): R[k]['hideModes'] = ['b1', 'b2']
for level, fl in FLOWS.items():
    for color, (si, so) in fl.items():
        pts = route(level, color, si, so)
        rid = f'pk_{level.lower()}_{color}'
        roads['routes'].append({'id': rid, 'type': 'car', 'kind': 'road', 'count': 3, 'speed_kmh': 15, 'modes': [level.lower()], 'pts_cm': pts})
        print(rid, f'{si}→{so}', len(pts), 'pts', 'zmin', min(p[2] for p in pts))

NOTE = '地下停車場：modes＝只在這些模式出現（pk_* 進出 B1／B2 的路線）、hideModes＝在這些模式隱藏，由 tools/parking_routes.py 產生（重新執行 traffic_to_config.py 後要再執行一次）。'
if NOTE not in roads['_說明']: roads['_說明'] += NOTE
open(roads_f, 'w', encoding='utf-8').write(json.dumps(roads, ensure_ascii=False))
