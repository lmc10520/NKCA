# 地下停車場 B1／B2 的車輛進出路線 → 寫進 config/roads.json
#
# 地面上原本的進出停車場路線（car_00、car_08 西側；car_09、car_10 東側）只開到坡道上蓋底下就消失，
# 在 B1／B2 模式上蓋收起來後會看到車開到一半懸空消失，所以：
#   - 這四條加上 hideModes: ["b1", "b2"]（地下停車場模式時不出現）
#   - 另外產生 pk_* 路線（modes: ["b1"] 或 ["b2"]）：接在原本路線後面，沿坡道開進該層，再沿停車場車道開到停車位附近；
#     出場則反過來，從車道開出、爬坡道，接回原本的出場路線。
#
# 行車方向（右側通行，依停車場平面圖入口箭頭與坡道位置）：
#   西側：進場走南側（往東），出場走北側（往西）。B1 坡道從地面兩條車道下來：西邊斜坡＝進、北邊＝出；
#         B2：南側坡道（Ramp_W_B2_Down）往東下到 B2＝進，北側坡道（Ramp_W_B2_Up）往西爬回 B1＝出。
#   東側：進場走北側（往西），出場走南側（往東）。B1 坡道：北邊車道＝進、東邊車道＝出；
#         B2：北側坡道（Ramp_E_B2_Up）往南再往西下到 B2＝進，南側坡道（Ramp_E_B2_Down）往東爬回 B1＝出。
#
# 停車場內雙向車道：進場、出場各靠自己的右側（相距約 3 m）。
# 坡道路面高度：tools/data/ramp_heights.json（由網頁模型量測）；建築內 B1 地板 -450、B2 地板 -800（cm）。
# 用法：python3 tools/parking_routes.py（tools/traffic_to_config.py 重新產生 roads.json 後要再執行一次）
import json, math, os

ROOT = os.path.join(os.path.dirname(__file__), '..')
H = json.load(open(os.path.join(ROOT, 'tools/data/ramp_heights.json'), encoding='utf-8'))
FLOOR = {'B1': -450, 'B2': -800}
BX0, BX1 = 2620, 24871          # 建築（停車場）東西邊界


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
    """航點 (x, y, 路面) → [x, y, z]；路面：F／D／U＝坡道、None＝建築內（該層地板）或沿用給定高度"""
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


roads_f = os.path.join(ROOT, 'config/roads.json')
roads = json.load(open(roads_f, encoding='utf-8'))
R = {r['id']: r for r in roads['routes']}
w_in, w_out, e_in, e_out = (R[k]['pts_cm'] for k in ('car_00', 'car_08', 'car_09', 'car_10'))

# ---------- 航點（Fusion cm）----------
# 西側坡道：進場（西邊斜坡往東南下到 B1 平台，從島的南側進）
W_RAMP_IN = [(-1750, 11650, 'F'), (-1300, 11150, 'F'), (-800, 10550, 'F'), (-350, 9950, 'F'), (50, 9450, 'F')]
W_B1_IN = [(450, 9000, 'F'), (1000, 8790, 'F'), (1800, 8750, 'F'),
           (2620, 8750, None), (3200, 8620, None), (3800, 8450, None), (6000, 8450, None), (10000, 8450, None), (14500, 8450, None)]
W_B2_IN = [(400, 9050, 'F'), (750, 8730, 'D'), (1200, 8520, 'D'), (1800, 8460, 'D'),
           (2620, 8450, None), (3500, 8420, None), (7500, 8420, None), (8800, 8550, None), (9370, 9150, None), (9370, 12000, None), (9370, 15000, None)]
# 西側出場：從 B1 西側車道往南、往西出，經島與北側 B2 坡道之間往北爬，接原本出場路線
W_RAMP_OUT = [(870, 9750, 'F'), (870, 10350, 'F'), (900, 10900, 'F'), (980, 11500, 'F'), (1080, 12000, 'F'), (1250, 12350, 'F')]
W_B1_OUT = [(3400, 15500, None), (3400, 12000, None), (3400, 10300, None), (3300, 9700, None), (3000, 9250, None),
            (2620, 9130, None), (2000, 9120, 'F'), (1350, 9150, 'F'), (950, 9350, 'F')]
W_B2_OUT = [(9070, 15000, None), (9070, 9300, None), (8700, 8720, None), (7500, 8620, None), (3600, 8620, None), (3050, 9100, None),
            (2620, 9470, None), (2000, 9460, 'U'), (1500, 9470, 'U'), (1250, 9700, 'U'), (1200, 10150, 'U'), (1160, 10600, 'U'),
            (1060, 11100, 'F')]
# 東側坡道：進場（北邊車道往南下）
E_RAMP_IN = [(26200, 12550, 'F'), (26300, 12000, 'F'), (26500, 11400, 'F')]
E_B1_IN = [(26650, 10800, 'F'), (26650, 10100, 'F'), (26550, 9550, 'F'), (26150, 9170, 'F'), (25500, 9120, 'F'),
           (24871, 9120, None), (24300, 9250, None), (23970, 9800, None), (23970, 12000, None), (23970, 15500, None)]
E_B2_IN = [(26350, 10800, 'F'), (26300, 10300, 'U'), (26280, 9850, 'U'), (26050, 9500, 'U'), (25500, 9440, 'U'), (25100, 9430, 'U'),
           (24871, 9450, None), (24000, 9470, None), (21000, 9470, None), (18600, 9470, None), (18000, 9850, None), (17950, 11000, None), (17950, 13500, None)]
# 東側出場：從南側出、沿島的東側往北爬到東邊車道
E_RAMP_OUT = [(27250, 9500, 'F'), (27400, 10200, 'F'), (27600, 10900, 'F'), (27900, 11400, 'F'), (28250, 11750, 'F')]
E_B1_OUT = [(14000, 8350, None), (20000, 8350, None), (23000, 8380, None), (23900, 8550, None),
            (24871, 8700, None), (25500, 8700, 'F'), (26300, 8700, 'F'), (26900, 8950, 'F')]
E_B2_OUT = [(17550, 13500, None), (17550, 9300, None), (17750, 8650, None), (18600, 8400, None), (24000, 8400, None),
            (24871, 8420, None), (25500, 8450, 'D'), (26000, 8550, 'D'), (26500, 8650, 'D'), (26850, 8820, 'D'), (27100, 9150, 'F')]


def road(p): return (p[0], p[1], p[2])


def join_in(prefix, way, level):
    # 接在原本進場路線後面：用最後兩點當起始方向
    pts = build([road(prefix[-2]), road(prefix[-1])] + way, level)
    return prefix[:-2] + pts


def join_out(way, suffix, level):
    pts = build(way + [road(suffix[0]), road(suffix[1])], level)
    return pts[:-2] + suffix


ROUTES = [
    ('pk_b1_w_in', 'park_in', 'b1', join_in(w_in, W_RAMP_IN + W_B1_IN, 'B1')),
    ('pk_b1_w_out', 'park_out', 'b1', join_out(W_B1_OUT + W_RAMP_OUT, w_out, 'B1')),
    ('pk_b2_w_in', 'park_in', 'b2', join_in(w_in, W_RAMP_IN + W_B2_IN, 'B2')),
    ('pk_b2_w_out', 'park_out', 'b2', join_out(W_B2_OUT + W_RAMP_OUT[2:], w_out, 'B2')),
    ('pk_b1_e_in', 'park_in', 'b1', join_in(e_in, E_RAMP_IN + E_B1_IN, 'B1')),
    ('pk_b1_e_out', 'park_out', 'b1', join_out(E_B1_OUT + E_RAMP_OUT, e_out, 'B1')),
    ('pk_b2_e_in', 'park_in', 'b2', join_in(e_in, E_RAMP_IN + E_B2_IN, 'B2')),
    ('pk_b2_e_out', 'park_out', 'b2', join_out(E_B2_OUT + E_RAMP_OUT, e_out, 'B2')),
]

roads['routes'] = [r for r in roads['routes'] if not r['id'].startswith('pk_')]
for k in ('car_00', 'car_08', 'car_09', 'car_10'): R[k]['hideModes'] = ['b1', 'b2']
for rid, kind, mode, pts in ROUTES:
    roads['routes'].append({'id': rid, 'type': 'car', 'kind': kind, 'count': 2, 'speed_kmh': 12, 'modes': [mode], 'pts_cm': pts})
    print(rid, len(pts), 'pts', 'z', min(p[2] for p in pts), '→', pts[-1][2] if kind == 'park_in' else pts[0][2])

NOTE = '地下停車場：modes＝只在這些模式出現（pk_* 進出 B1／B2 的路線）、hideModes＝在這些模式隱藏，由 tools/parking_routes.py 產生（重新執行 traffic_to_config.py 後要再執行一次）。'
if NOTE not in roads['_說明']: roads['_說明'] += NOTE
open(roads_f, 'w', encoding='utf-8').write(json.dumps(roads, ensure_ascii=False))
