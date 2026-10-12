import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 車輛與行人的低面數造型。每個零件帶頂點顏色：白色(1,1,1)的部分會套用每個個體的顏色（instanceColor），
// 深色部分（車窗、輪胎、皮膚…）維持固定顏色。合併成一個幾何，同類只要一次繪製。

function paint(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const merge = (parts) => { const g = mergeGeometries(parts); g.computeVertexNormals(); return g; };
const box = (w, h, l, x, y, z, col) => paint(new THREE.BoxGeometry(w, h, l).translate(x, y, z), col);
const cyl = (r1, r2, h, x, y, z, col, seg = 10) => paint(new THREE.CylinderGeometry(r1, r2, h, seg).translate(x, y, z), col);
const ball = (r, x, y, z, col, sx = 1, sy = 1, sz = 1) => paint(new THREE.SphereGeometry(r, 10, 8).scale(sx, sy, sz).translate(x, y, z), col);
// 側面輪廓擠出：pts 為 [前後(z，前方為負), 高度]，沿寬度擠出
function profile(pts, width, col, bevel = 0.04) {
  const s = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.rotateY(Math.PI / 2).translate(-(width - 2 * bevel) / 2, 0, 0);
  return paint(g, col);
}
function wheel(r, w, x, y, z) {
  return paint(new THREE.CylinderGeometry(r, r, w, 12).rotateZ(Math.PI / 2).translate(x, y, z), 0x1b1c1e);
}

const GLASS = 0x26303a, TIRE = 0x1b1c1e, CHROME = 0x9aa0a6;

export function carGeometry() {
  const L = 4.4, W = 1.78;
  const body = profile([[-2.2, 0.32], [-2.22, 0.62], [-2.05, 0.82], [-1.05, 0.95], [-0.45, 1.4], [0.85, 1.43], [1.65, 1.0], [2.15, 0.92], [2.2, 0.62], [2.18, 0.32]], W, 0xffffff);
  const win = profile([[-0.98, 0.98], [-0.42, 1.36], [0.83, 1.38], [1.55, 1.0]], W + 0.02, GLASS, 0.01);
  const wheels = [[-1, -1.4], [1, -1.4], [-1, 1.35], [1, 1.35]].map(([sx, z]) => wheel(0.33, 0.24, sx * (W / 2 - 0.08), 0.33, z));
  const bumpers = [box(W - 0.1, 0.12, 0.08, 0, 0.42, -2.22, CHROME), box(W - 0.1, 0.12, 0.08, 0, 0.42, 2.2, 0x3a3d40)];
  return merge([body, win, ...wheels, ...bumpers]);
}
export function busGeometry() {
  const W = 2.5;
  const body = profile([[-6, 0.45], [-6.05, 2.9], [-5.85, 3.3], [5.9, 3.3], [6.0, 3.0], [6.0, 0.45]], W, 0xffffff, 0.08);
  const win = profile([[-6.07, 1.55], [-6.07, 2.85], [5.6, 2.85], [5.6, 1.85], [-4.0, 1.85], [-4.0, 1.55]], W + 0.03, GLASS, 0.01);
  const stripe = box(W + 0.02, 0.18, 11.6, 0, 1.2, 0, 0x2f5e9e);
  const wheels = [[-1, -3.9], [1, -3.9], [-1, 3.6], [1, 3.6]].map(([sx, z]) => wheel(0.5, 0.32, sx * (W / 2 - 0.1), 0.5, z));
  return merge([body, win, stripe, ...wheels]);
}
export function scooterGeometry() {
  return merge([
    box(0.36, 0.3, 1.3, 0, 0.42, 0.05, 0xffffff),            // 車身
    box(0.42, 0.75, 0.22, 0, 0.75, -0.55, 0xffffff),        // 前擋
    box(0.34, 0.14, 0.62, 0, 0.72, 0.3, 0x2a2c2f),          // 坐墊
    box(0.62, 0.04, 0.04, 0, 1.12, -0.6, CHROME),           // 把手
    wheel(0.24, 0.12, 0, 0.24, -0.62), wheel(0.24, 0.12, 0, 0.24, 0.62),
  ]);
}
export function riderGeometry() {
  // 騎士：上衣（個體顏色）＋深色褲子＋安全帽
  return merge([
    paint(new THREE.CapsuleGeometry(0.19, 0.42, 3, 8).translate(0, 1.18, 0.2), 0xffffff),
    box(0.34, 0.16, 0.5, 0, 0.84, 0.05, 0x2d3440),
    box(0.3, 0.42, 0.14, 0, 0.62, -0.18, 0x2d3440),
    ball(0.16, 0, 1.62, 0.16, 0xf2f2f0),
    ball(0.12, 0, 1.58, 0.06, 0x2b2f35, 1, 0.7, 0.6),   // 面罩
  ]);
}

// ---------- 行人零件（原點在腳底，面向 +z） ----------
// 身高 1.7 m 的成人比例；小孩、長者用縮放
export function torsoGeometry() {
  return merge([
    paint(new THREE.CapsuleGeometry(0.17, 0.44, 3, 10).scale(1, 1, 0.72).translate(0, 1.2, 0), 0xffffff),
    box(0.3, 0.12, 0.2, 0, 0.92, 0, 0xffffff),
    cyl(0.055, 0.06, 0.1, 0, 1.49, 0, 0xd9b49b, 8),        // 脖子
  ]);
}
export function headGeometry() { return merge([ball(0.115, 0, 1.6, 0.01, 0xd9b49b, 0.92, 1.05, 1)]); }
export function hairGeometry() { return merge([ball(0.122, 0, 1.635, -0.015, 0xffffff, 0.95, 0.85, 1.02)]); }
export function capGeometry() {
  return merge([cyl(0.13, 0.125, 0.07, 0, 1.69, 0, 0xffffff, 12), box(0.2, 0.02, 0.1, 0, 1.665, 0.12, 0xffffff)]);
}
// 腿與手臂：原點在髖、肩，向下延伸（擺動時繞 X 軸旋轉）
export function legGeometry() {
  return merge([paint(new THREE.CapsuleGeometry(0.075, 0.7, 3, 8).translate(0, -0.42, 0), 0xffffff), box(0.11, 0.07, 0.24, 0, -0.84, 0.05, 0x2a2b2e)]);
}
export function armGeometry() {
  return merge([paint(new THREE.CapsuleGeometry(0.055, 0.5, 3, 8).translate(0, -0.3, 0), 0xffffff), ball(0.05, 0, -0.6, 0, 0xd9b49b)]);
}
export function wheelchairGeometry() {
  const parts = [
    box(0.48, 0.06, 0.46, 0, 0.5, 0, 0x30343a),             // 座墊
    box(0.48, 0.5, 0.05, 0, 0.78, -0.24, 0x30343a),          // 椅背（人面向 +z）
    box(0.04, 0.5, 0.04, -0.24, 0.3, 0.2, CHROME), box(0.04, 0.5, 0.04, 0.24, 0.3, 0.2, CHROME),
    box(0.4, 0.03, 0.14, 0, 0.12, 0.34, CHROME),             // 腳踏
  ];
  for (const sx of [-1, 1]) {
    parts.push(paint(new THREE.TorusGeometry(0.29, 0.025, 6, 20).rotateY(Math.PI / 2).translate(sx * 0.29, 0.3, -0.08), 0x1b1c1e));
    parts.push(wheel(0.07, 0.04, sx * 0.2, 0.07, 0.3));
  }
  return merge(parts);
}
export function dogGeometry() {
  // 中型犬（個體顏色），面向 +z
  return merge([
    paint(new THREE.CapsuleGeometry(0.13, 0.45, 3, 8).rotateX(Math.PI / 2).translate(0, 0.42, 0), 0xffffff),
    ball(0.11, 0, 0.6, 0.36, 0xffffff), box(0.08, 0.07, 0.12, 0, 0.56, 0.47, 0x2a2420),
    box(0.04, 0.09, 0.03, -0.06, 0.7, 0.33, 0xffffff), box(0.04, 0.09, 0.03, 0.06, 0.7, 0.33, 0xffffff),
    ...[[-0.08, 0.2], [0.08, 0.2], [-0.08, -0.2], [0.08, -0.2]].map(([x, z]) => box(0.06, 0.32, 0.06, x, 0.16, z, 0xffffff)),
    box(0.03, 0.03, 0.2, 0, 0.56, -0.33, 0xffffff),          // 尾巴
  ]);
}
