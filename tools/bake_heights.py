# 把 config/roads.json 的路線點、config/walk.json 的節點，依模型地面高度寫入 z（cm）
# 用法：python3 tools/bake_heights.py <Fusion 匯出的 nkca.glb>
import sys, re, json, os, numpy as np, trimesh
from shapely.geometry import LineString
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = trimesh.load(sys.argv[1], force='scene')
def ground(pat):
    ms = []
    for n in s.graph.nodes_geometry:
        if re.match(pat, n):
            T, g = s.graph[n]; m = s.geometry[g].copy(); m.apply_transform(T); ms.append(m)
    return trimesh.util.concatenate(ms)
def heights(mesh, xy_cm, ymax):
    # glb：x = X/100, y = 高度, z = -Y/100
    o = np.array([[x / 100, 40.0, -y / 100] for x, y in xy_cm]); d = np.tile([0, -1.0, 0], (len(o), 1))
    loc, ri, _ = mesh.ray.intersects_location(o, d, multiple_hits=True)
    h = np.full(len(o), np.nan)
    for p, r in zip(loc, ri):
        if p[1] < ymax and (np.isnan(h[r]) or p[1] > h[r]): h[r] = p[1]
    return np.nan_to_num(h, nan=0.0)
veh = ground(r'^(Site_Road_Base|Site_Moto_Parking|Site_Sidewalk|Site_Campus_Paving|Site_Park_Paving|Plaza_Ground)')
ped = ground(r'^(Site_Road_Base|Site_Moto_Parking|Site_Sidewalk|Site_Campus_Paving|Site_Park_Paving|Site_Grass|Site_North_Mound|Site_Dry_Fountain|Plaza_Ground|Plaza_Wall_Patch)')
R = json.load(open(os.path.join(root, 'config/roads.json')))
for r in R['routes']:
    ls = LineString([p[:2] for p in r['pts_cm']]); n = max(2, int(ls.length / 300) + 1)
    xy = [ls.interpolate(i / (n - 1), normalized=True).coords[0] for i in range(n)]
    h = heights(veh, xy, 3.0)
    r['pts_cm'] = [[round(x), round(y), round(z * 100)] for (x, y), z in zip(xy, h)]
json.dump(R, open(os.path.join(root, 'config/roads.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
W = json.load(open(os.path.join(root, 'config/walk.json')))
h = heights(ped, [p[:2] for p in W['nodes']], 8.0)
W['nodes'] = [[p[0], p[1], round(z * 100)] for p, z in zip(W['nodes'], h)]
json.dump(W, open(os.path.join(root, 'config/walk.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('ok', sum(len(r['pts_cm']) for r in R['routes']), len(W['nodes']))
