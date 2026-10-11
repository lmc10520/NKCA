# 由 20261008_車流.pdf 萃取出的路線（tools/data/traffic_20261008.json，模型 cm 座標）
# 產生 config/roads.json（汽車、機車、遊覽車）與 config/walk.json（行人可走區域的導航網格）
import json, math, os
from shapely.geometry import LineString, Polygon, Point
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = json.load(open(os.path.join(root, 'tools/data/traffic_20261008.json')))

# ---- 車輛 ----
spec = {'car': ('car', 32), 'moto': ('scooter', 28), 'bus': ('bus', 22)}
routes = []
for key, lst in src['routes'].items():
    typ, v = spec[key]
    for i, r in enumerate(lst):
        pts = r['pts'] if isinstance(r, dict) else r
        kind = r.get('kind', 'road') if isinstance(r, dict) else 'road'
        ls = LineString(pts).simplify(25)
        L = ls.length / 100  # m
        if L < 8: continue
        speed = v if kind == 'road' else 12
        if typ == 'scooter' and L < 120: speed = 15        # 進出機車停車格
        # 數量：道路約每 45 m 一台（機車 60 m、遊覽車 250 m），進出停車場 1–2 台
        per = {'car': 45, 'scooter': 60, 'bus': 250}[typ]
        cnt = max(1, round(L / per)) if kind == 'road' else (2 if L > 150 else 1)
        routes.append({'id': f'{key}_{i:02d}', 'type': typ, 'kind': kind, 'count': cnt, 'speed_kmh': speed,
                       'pts_cm': [[round(x), round(y)] for x, y in ls.coords]})
json.dump({'_說明': '車輛路線（cm），依 20261008_車流.pdf 的汽車／機車／遊覽車圖層，方向依圖上箭頭。'
           '由 tools/traffic_to_config.py 產生；手動微調可直接改 pts_cm。',
           'enabled': True, 'routes': routes},
          open(os.path.join(root, 'config/roads.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('routes', len(routes), sum(r['count'] for r in routes))

# ---- 行人：人流圖層（可走區域）→ 網格導航 ----
w = src['walk'][0]
poly = Polygon(w[0], w[1:]).buffer(0).buffer(-80)   # 往內縮 0.8 m，避免貼邊
S = 650
x0, y0, x1, y1 = poly.bounds
from shapely.prepared import prep
P = prep(poly)
idx = {}; nodes = []
for gx in range(int(x0 // S), int(x1 // S) + 1):
    for gy in range(int(y0 // S), int(y1 // S) + 1):
        p = (gx * S, gy * S)
        if P.contains(Point(p)): idx[(gx, gy)] = len(nodes); nodes.append(p)
adj = [[] for _ in nodes]
for (gx, gy), i in idx.items():
    for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
        j = idx.get((gx + dx, gy + dy))
        if j is not None and P.contains(LineString([nodes[i], nodes[j]])):
            adj[i].append(j); adj[j].append(i)
# 只留最大的連通區
seen = [-1] * len(nodes); comps = []
for s in range(len(nodes)):
    if seen[s] >= 0: continue
    st = [s]; seen[s] = len(comps); c = [s]
    while st:
        u = st.pop()
        for v in adj[u]:
            if seen[v] < 0: seen[v] = len(comps); st.append(v); c.append(v)
    comps.append(c)
keep = sorted(max(comps, key=len))
remap = {o: n for n, o in enumerate(keep)}
out_nodes = [list(nodes[o]) for o in keep]
out_adj = [[remap[v] for v in adj[o] if v in remap] for o in keep]
json.dump({'_說明': '行人可走區域（20261008_車流.pdf 人流圖層）的網格，間距 %d cm；nodes 為 cm 座標，adj 為相鄰節點。' % S,
           'enabled': True, 'spacing_cm': S, 'count': 160, 'nodes': out_nodes, 'adj': out_adj},
          open(os.path.join(root, 'config/walk.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('walk nodes', len(out_nodes), 'of', len(nodes), 'comps', len(comps))
