import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cm2w, isMobile } from './util.js';

// 車輛：依 config/roads.json（20261008_車流.pdf 的汽車／機車／遊覽車路線）行駛，方向照圖上箭頭。
// 同類車輛用 InstancedMesh 一次畫完；夜間開頭燈、尾燈，地面有車燈光暈。
const box = (w, h, l, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);
const ball = (r, x, y, z) => new THREE.SphereGeometry(r, 8, 6).translate(x, y, z);
const TYPES = {
  car: {
    body: () => mergeGeometries([box(1.8, 0.75, 4.4, 0, 0.55, 0), box(1.6, 0.6, 2.3, 0, 1.2, 0.2)]),
    head: () => mergeGeometries([ball(0.11, -0.62, 0.7, -2.2), ball(0.11, 0.62, 0.7, -2.2)]),
    tail: () => mergeGeometries([ball(0.09, -0.65, 0.75, 2.2), ball(0.09, 0.65, 0.75, 2.2)]),
    glow: [5, -4.6], colors: ['#f4f4f2', '#1d1f22', '#b9bdc2', '#6d7278', '#26364f', '#8e1f22', '#e7e2d6'],
  },
  scooter: {
    body: () => mergeGeometries([box(0.45, 0.6, 1.8, 0, 0.5, 0), box(0.4, 0.75, 0.4, 0, 1.15, 0.2), ball(0.16, 0, 1.68, 0.15)]),
    head: () => ball(0.08, 0, 1.0, -0.92),
    tail: () => ball(0.06, 0, 0.85, 0.92),
    glow: [2.6, -2.2], colors: ['#2b2d30', '#3c4a63', '#7a2a2a', '#c9c6be', '#4e5a3a', '#1f1f1f'],
  },
  bus: {
    body: () => mergeGeometries([box(2.5, 3.1, 12, 0, 1.85, 0)]),
    head: () => mergeGeometries([ball(0.15, -1.0, 0.75, -6.0), ball(0.15, 1.0, 0.75, -6.0)]),
    tail: () => mergeGeometries([ball(0.12, -1.05, 0.9, 6.0), ball(0.12, 1.05, 0.9, 6.0)]),
    glow: [7, -9], colors: ['#f2f2ee', '#e9eef4', '#2f5e9e'],
  },
};

export class Vehicles {
  constructor(scene, cfg, lightCfg) {
    this.list = []; this.groups = {};
    if (!cfg?.enabled) return;
    const k = isMobile ? 0.5 : 1;
    const byType = {};
    for (const r of cfg.routes || []) {
      const pts = r.pts_cm.map((p) => cm2w([p[0], p[1], p[2] ?? 0]).add(new THREE.Vector3(0, 0.02, 0)));
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts, !!r.loop, 'centripetal');
      const len = curve.getLength();
      curve.arcLengthDivisions = Math.max(200, Math.round(len / 2));
      curve.updateArcLengths();
      const n = Math.max(1, Math.round((r.count || 1) * k));
      for (let i = 0; i < n; i++) {
        const v = { type: r.type, curve, len, loop: !!r.loop, park: r.kind !== 'road',
          u: (i + Math.random() * 0.6) / n, speed: ((r.speed_kmh || 30) / 3.6) * (0.85 + Math.random() * 0.3), wait: 0 };
        if (v.park) { v.u = Math.random() * 0.3; v.wait = Math.random() * 20; }
        (byType[r.type] ||= []).push(v); this.list.push(v);
      }
    }
    const headMat = new THREE.MeshBasicMaterial({ color: lightCfg?.headlight || '#fff6dd', toneMapped: false });
    const tailMat = new THREE.MeshBasicMaterial({ color: lightCfg?.taillight || '#ff3b2f', toneMapped: false });
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xfff4dc, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.headMat = headMat; this.tailMat = tailMat; this.glowMat = glowMat;
    this.headBase = headMat.color.clone(); this.tailBase = tailMat.color.clone();
    for (const [t, vs] of Object.entries(byType)) {
      const T = TYPES[t] || TYPES.car, n = vs.length;
      const body = new THREE.InstancedMesh(T.body(), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 }), n);
      body.castShadow = true; body.receiveShadow = true;
      const c = new THREE.Color();
      vs.forEach((v, i) => body.setColorAt(i, c.set(T.colors[(Math.random() * T.colors.length) | 0])));
      const head = new THREE.InstancedMesh(T.head(), headMat, n);
      const tail = new THREE.InstancedMesh(T.tail(), tailMat, n);
      const [gs, gz] = T.glow;
      const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(gs * 0.8, gs * 1.4).rotateX(-Math.PI / 2).translate(0, 0.05, gz), glowMat, n);
      for (const m of [body, head, tail, glow]) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
      this.groups[t] = { vs, meshes: [body, head, tail, glow] };
    }
    this._m = new THREE.Matrix4(); this._p = new THREE.Vector3(); this._q = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0); this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  update(dt, night) {
    if (!this.headMat) return;
    dt = Math.min(dt, 0.1);
    this.headMat.color.copy(this.headBase).multiplyScalar(0.35 + night * 2.5);
    this.tailMat.color.copy(this.tailBase).multiplyScalar(0.5 + night * 2.0);
    this.glowMat.opacity = night * 0.55;
    const m = this._m, p = this._p, q = this._q;
    for (const g of Object.values(this.groups)) {
      g.vs.forEach((v, i) => {
        let hidden = false;
        if (v.wait > 0) { v.wait -= dt; hidden = true; }
        else {
          v.u += (v.speed * dt) / v.len;
          if (v.u >= 1) {
            if (v.loop) v.u -= 1;
            else { v.u = 0; v.wait = v.park ? 15 + Math.random() * 40 : Math.random() * 4; hidden = true; }
          }
        }
        if (hidden) { for (const mesh of g.meshes) mesh.setMatrixAt(i, this._zero); return; }
        v.curve.getPointAt(v.u, p);
        v.curve.getPointAt(Math.min(1, v.u + 1 / v.len), q);
        if (q.distanceToSquared(p) < 1e-6) q.set(p.x, p.y, p.z - 0.01);
        m.lookAt(p, q, this._up); m.setPosition(p);
        for (const mesh of g.meshes) mesh.setMatrixAt(i, m);
      });
      for (const mesh of g.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

function glowTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// 行人：在 config/walk.json（20261008_車流.pdf 的人流圖層，可走區域的網格）上漫步，
// 只走相鄰節點，不會穿過草坪、廳院或車道；高度已預先烘焙在節點的 z。
export class People {
  constructor(scene, cfg) {
    this.list = [];
    if (!cfg?.enabled || !cfg.nodes?.length) return;
    this.P = cfg.nodes.map((p) => cm2w([p[0], p[1], p[2] ?? 0]));
    this.adj = cfg.adj;
    const n = Math.round((cfg.count || 150) * (isMobile ? 0.5 : 1));
    const bodyG = new THREE.CapsuleGeometry(0.2, 0.9, 3, 8).translate(0, 0.65, 0);
    const headG = new THREE.SphereGeometry(0.13, 10, 8).translate(0, 1.42, 0);
    this.body = new THREE.InstancedMesh(bodyG, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    this.head = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.8 }), n);
    const palette = ['#2f4a6d', '#8a3b3b', '#3f6b4a', '#c9a227', '#555b63', '#e8e4dc', '#6b4f8a', '#1f1f1f', '#d9d4c7', '#3a5f7a'];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      this.body.setColorAt(i, c.set(palette[(Math.random() * palette.length) | 0]));
      const a = (Math.random() * this.P.length) | 0;
      const b = this.adj[a][(Math.random() * this.adj[a].length) | 0] ?? a;
      this.list.push({ a, b, t: Math.random(), v: 1.0 + Math.random() * 0.5, wait: Math.random() < 0.25 ? Math.random() * 20 : 0,
        ph: Math.random() * 6, dir: new THREE.Vector3(), yaw: 0 });
    }
    for (const m of [this.body, this.head]) { m.castShadow = true; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0); this._e = new THREE.Euler();
  }
  next(p) {
    // 傾向直走，偶爾轉彎；盡量不走回頭路
    const from = this.P[p.b], d0 = this.P[p.b].clone().sub(this.P[p.a]).normalize();
    let best = p.a, bs = -Infinity;
    for (const j of this.adj[p.b]) {
      const d = this.P[j].clone().sub(from).normalize();
      const s = d.dot(d0) * 1.2 + Math.random() * 1.4 - (j === p.a ? 3 : 0);
      if (s > bs) { bs = s; best = j; }
    }
    p.a = p.b; p.b = best; p.t = 0;
    if (!(p.run > 0) && Math.random() < 0.03) p.wait = 3 + Math.random() * 12;   // 停下來看看
  }
  // 手指／滑鼠點到行人：他（和旁邊 4 m 內的人）會跑起來幾秒
  tap(cx, cy, camera, rect) {
    if (!this.body) return false;
    const v = new THREE.Vector3(), base = isMobile ? 40 : 26; let best = -1, bd = Infinity;
    this.list.forEach((p, i) => {
      v.copy(this.P[p.a]).lerp(this.P[p.b], Math.min(p.t, 1)); v.y += 0.9;
      const dist = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1) return;
      const x = rect.left + (v.x + 1) / 2 * rect.width, y = rect.top + (1 - v.y) / 2 * rect.height;
      const r = Math.max(base, 300 / dist);          // 近的時候點人身上任何地方都算
      const d = Math.hypot(x - cx, y - cy);
      if (d < r && d < bd) { best = i; bd = d; }
    });
    if (best < 0) return false;
    const c = this.P[this.list[best].a];
    this.list.forEach((p) => {
      if (p === this.list[best] || this.P[p.a].distanceTo(c) < 4) { p.run = 4 + Math.random() * 3; p.wait = 0; }
    });
    return true;
  }
  update(dt) {
    if (!this.body) return;
    dt = Math.min(dt, 0.1);
    const m = this._m, pos = this._p;
    this.list.forEach((p, i) => {
      const A = this.P[p.a], B = this.P[p.b];
      const L = Math.max(0.01, A.distanceTo(B));
      const run = p.run > 0; if (run) p.run -= dt;
      if (p.wait > 0) p.wait -= dt;
      else { p.t += ((run ? 4.8 : p.v) * dt) / L; p.ph += dt * (run ? 17 : 9); if (p.t >= 1) this.next(p); }
      const A2 = this.P[p.a], B2 = this.P[p.b];
      pos.copy(A2).lerp(B2, Math.min(p.t, 1));
      if (p.wait <= 0) pos.y += Math.abs(Math.sin(p.ph)) * (run ? 0.12 : 0.04);
      const want = Math.atan2(B2.x - A2.x, B2.z - A2.z);
      let d = want - p.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      p.yaw += d * Math.min(1, dt * (run ? 10 : 5));
      p.lean = (p.lean || 0) + ((run ? 0.28 : 0) - (p.lean || 0)) * Math.min(1, dt * 6);   // 跑步時身體前傾
      this._e.set(p.lean, p.yaw, 0, 'YXZ'); this._q.setFromEuler(this._e);
      m.compose(pos, this._q, this._s);
      this.body.setMatrixAt(i, m); this.head.setMatrixAt(i, m);
    });
    this.body.instanceMatrix.needsUpdate = true; this.head.instanceMatrix.needsUpdate = true;
  }
}
