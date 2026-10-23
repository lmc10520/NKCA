import * as THREE from 'three';
import { cm2w } from './util.js';

// LED 電視牆、舞台貼圖、玻璃帷幕貼紙：讀 img/ 內指定檔名的圖片貼在模型上
// 兩種寫法：
//   corners_cm：四個角點（左下、右下、右上、左上，從觀看方向看）圍成的平面
//   path_cm + z_cm：沿著一條折線（例如轉角 L 型）由左到右展開，高度 z_cm = [下緣, 上緣]
//   rows_cm：弧面（例如貼著傾斜、彎曲的玻璃帷幕），[下緣點列, …, 上緣點列]，每列由左到右、點數相同，每點 [x, y, z]
// kind："led"（自己發光，沒有圖片時顯示成關機的黑色面板）或 "sticker"（透明貼紙，受光影響，沒有圖片就不顯示）
// 網址加 ?screens=test 會用 template 指定的範本圖（標出玻璃接縫）檢查位置。
export function buildScreens(scene, cfg) {
  const group = new THREE.Group(); group.name = 'Screens'; scene.add(group);
  const loader = new THREE.TextureLoader();
  const bust = '?v=' + Math.floor(Date.now() / 60000);   // 每分鐘換一次，GitHub 換圖後重新整理即可看到
  const test = /[?&]screens=test\b/.test(location.search);
  for (const s of cfg?.screens || []) {
    if (!s.enabled) continue;
    const g = s.rows_cm ? rowsGeometry(s.rows_cm) : s.path_cm ? pathGeometry(s.path_cm, s.z_cm) : quadGeometry(s.corners_cm);
    if (!g) continue;
    const sticker = s.kind === 'sticker';
    const mat = sticker
      ? new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.35, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 })
      : new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide, toneMapped: false, transparent: true });   // 透明清單＋renderOrder 3：在玻璃之後畫，玻璃夜間發光時不會蓋住螢幕
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'Screen_' + s.id; mesh.userData.fname = mesh.name; mesh.userData.label = s.label;
    mesh.renderOrder = 3;   // 貼紙與 LED 都在玻璃（renderOrder 2）之後畫
    mesh.visible = !sticker;              // 貼紙等圖片載入後才顯示
    group.add(mesh);
    const apply = (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true; mesh.visible = true; };
    const tryTemplate = () => { if (test && s.template) loader.load(s.template + bust, apply); };
    if (test && s.template) tryTemplate();
    else loader.load(s.file + bust, apply, undefined, () => { console.warn('[screen] 找不到圖片', s.file); tryTemplate(); });
  }
  return group;
}

function quadGeometry(corners) {
  if (!corners || corners.length !== 4) return null;
  const c = corners.map(cm2w);
  if (c[0].distanceTo(c[2]) < 0.01) return null;   // 尚未量測（全部 0）
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...c[0].toArray(), ...c[1].toArray(), ...c[2].toArray(), ...c[3].toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// 折線展開：u 依長度比例分配，所以 L 型貼紙在轉角處不會變形
function pathGeometry(path, z) {
  if (!path || path.length < 2 || !z) return null;
  const pts = path.map(([x, y]) => [x, y]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = len[len.length - 1];
  if (L < 1) return null;
  const pos = [], uv = [], idx = [];
  pts.forEach(([x, y], i) => {
    pos.push(...cm2w([x, y, z[0]]).toArray(), ...cm2w([x, y, z[1]]).toArray());
    uv.push(len[i] / L, 0, len[i] / L, 1);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 3, a, a + 3, a + 1); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// 弧面：多列點（下 → 上），u 依每列的弧長比例、v 依列與列的距離比例，所以圖片沿弧面平均展開不變形
function rowsGeometry(rows) {
  if (!rows || rows.length < 2 || rows.some((r) => r.length !== rows[0].length || r.length < 2)) return null;
  const P = rows.map((r) => r.map(cm2w)), n = P[0].length, m = P.length;
  const ulen = P.map((r) => { const a = [0]; for (let i = 1; i < n; i++) a.push(a[i - 1] + r[i].distanceTo(r[i - 1])); return a; });
  const vlen = [0]; for (let j = 1; j < m; j++) vlen.push(vlen[j - 1] + P[j][n >> 1].distanceTo(P[j - 1][n >> 1]));
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    pos.push(...P[j][i].toArray());
    uv.push(ulen[j][i] / ulen[j][n - 1], vlen[j] / vlen[m - 1]);
    if (i && j) { const a = (j - 1) * n + i - 1, b = a + n; idx.push(a, a + 1, b + 1, a, b + 1, b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
