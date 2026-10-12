import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cm2w, isMobile } from './util.js';
import {
  carGeometry, busGeometry, scooterGeometry, riderGeometry, torsoGeometry, headGeometry, hairGeometry, capGeometry,
  legGeometry, armGeometry, wheelchairGeometry, dogGeometry,
} from './figures.js';

// 車輛：依 config/roads.json（20261008_車流.pdf 的汽車／機車／遊覽車路線）行駛，方向照圖上箭頭。
// 同類車輛用 InstancedMesh 一次畫完；夜間開頭燈、尾燈，地面有車燈光暈。
const ball = (r, x, y, z) => new THREE.SphereGeometry(r, 8, 6).translate(x, y, z);
const TYPES = {
  car: {
    body: carGeometry,
    head: () => mergeGeometries([ball(0.1, -0.62, 0.72, -2.2), ball(0.1, 0.62, 0.72, -2.2)]),
    tail: () => mergeGeometries([ball(0.08, -0.66, 0.78, 2.17), ball(0.08, 0.66, 0.78, 2.17)]),
    glow: [5, -4.6], colors: ['#f4f4f2', '#1d1f22', '#b9bdc2', '#6d7278', '#26364f', '#8e1f22', '#e7e2d6', '#f4f4f2', '#b9bdc2'],
  },
  scooter: {
    body: scooterGeometry, rider: riderGeometry,
    head: () => ball(0.07, 0, 0.98, -0.68),
    tail: () => ball(0.05, 0, 0.7, 0.72),
    glow: [2.6, -2.0], colors: ['#2b2d30', '#3c4a63', '#7a2a2a', '#c9c6be', '#4e5a3a', '#e9e6df'],
    riderColors: ['#2f4a6d', '#8a3b3b', '#3f6b4a', '#555b63', '#1f1f1f', '#c9a227', '#e8e4dc'],
  },
  bus: {
    body: busGeometry,
    head: () => mergeGeometries([ball(0.14, -1.0, 0.8, -6.05), ball(0.14, 1.0, 0.8, -6.05)]),
    tail: () => mergeGeometries([ball(0.12, -1.05, 1.0, 6.02), ball(0.12, 1.05, 1.0, 6.02)]),
    glow: [7, -9], colors: ['#f2f2ee', '#e9eef4', '#f7f5ef'],
  },
};

export class Vehicles {
  constructor(scene, cfg, lightCfg) {
    this.list = []; this.groups = {}; this.visible = true;
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
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.headMat = headMat; this.tailMat = tailMat; this.glowMat = glowMat;
    this.headBase = headMat.color.clone(); this.tailBase = tailMat.color.clone();
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25 });
    for (const [t, vs] of Object.entries(byType)) {
      const T = TYPES[t] || TYPES.car, n = vs.length;
      const c = new THREE.Color();
      const body = new THREE.InstancedMesh(T.body(), bodyMat, n);
      body.castShadow = true; body.receiveShadow = true;
      vs.forEach((v, i) => body.setColorAt(i, c.set(T.colors[(Math.random() * T.colors.length) | 0])));
      const meshes = [body];
      if (T.rider) {
        const rider = new THREE.InstancedMesh(T.rider(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), n);
        rider.castShadow = true;
        vs.forEach((v, i) => rider.setColorAt(i, c.set(T.riderColors[(Math.random() * T.riderColors.length) | 0])));
        meshes.push(rider);
      }
      const head = new THREE.InstancedMesh(T.head(), headMat, n);
      const tail = new THREE.InstancedMesh(T.tail(), tailMat, n);
      const [gs, gz] = T.glow;
      const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(gs * 0.8, gs * 1.4).rotateX(-Math.PI / 2).translate(0, 0.06, gz), glowMat, n);
      meshes.push(head, tail, glow);
      for (const m of meshes) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
      this.groups[t] = { vs, meshes };
    }
    this._m = new THREE.Matrix4(); this._p = new THREE.Vector3(); this._q = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0); this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  setVisible(v) { this.visible = v; for (const g of Object.values(this.groups)) g.meshes.forEach((m) => (m.visible = v)); }
  update(dt, night) {
    if (!this.headMat || !this.visible) return;
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

// ---------- 行人 ----------
// 在 config/walk.json（人流圖層的導航網格）上漫步，只走相鄰節點，不穿過草坪、廳院或車道。
// 組成：成人、小孩（多半跟著大人）、長者（較慢、微駝）、輪椅使用者、牽狗巡邏的保全。
// 每種零件一個 InstancedMesh（軀幹、頭、頭髮／帽子、左右腿、左右手、輪椅、狗），走路時手腳擺動。
const SHIRTS = ['#2f4a6d', '#8a3b3b', '#3f6b4a', '#c9a227', '#555b63', '#e8e4dc', '#6b4f8a', '#d98c5f', '#3a5f7a', '#f2f0ea', '#b04a6a', '#4d7f8c'];
const PANTS = ['#2d3440', '#3b3f45', '#5a4a3a', '#1f2328', '#6f7f8f', '#c8bfae'];
const HAIR = ['#2a211c', '#1c1a18', '#4a3426', '#6b4a2f'];
const pick = (a) => a[(Math.random() * a.length) | 0];

export class People {
  constructor(scene, cfg) {
    this.list = []; this.visible = true;
    if (!cfg?.enabled || !cfg.nodes?.length) return;
    this.P = cfg.nodes.map((p) => cm2w([p[0], p[1], p[2] ?? 0]));
    this.adj = cfg.adj;
    const N = Math.round((cfg.count || 160) * (isMobile ? 0.5 : 1));
    // 組成比例（可在 walk.json 的 mix 調整）
    const mix = { adult: 0.55, child: 0.17, elder: 0.15, wheelchair: 0.06, guard: 0.04, ...(cfg.mix || {}) };
    const kinds = [];
    for (const [k, r] of Object.entries(mix)) for (let i = 0; i < Math.round(N * r); i++) kinds.push(k);
    while (kinds.length < N) kinds.push('adult');
    kinds.length = N;

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    const mk = (geo, n) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.castShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = n;
      scene.add(im); return im;
    };
    const nChair = kinds.filter((k) => k === 'wheelchair').length, nDog = kinds.filter((k) => k === 'guard').length;
    this.parts = {
      torso: mk(torsoGeometry(), N), head: mk(headGeometry(), N), hair: mk(hairGeometry(), N), cap: mk(capGeometry(), N),
      legL: mk(legGeometry(), N), legR: mk(legGeometry(), N), armL: mk(armGeometry(), N), armR: mk(armGeometry(), N),
      chair: mk(wheelchairGeometry(), nChair), dog: mk(dogGeometry(), nDog),
    };
    this.meshes = Object.values(this.parts);
    const c = new THREE.Color();
    let ci = 0, di = 0;
    const adults = [];
    kinds.forEach((kind, i) => {
      const a = (Math.random() * this.P.length) | 0;
      const b = this.adj[a][(Math.random() * this.adj[a].length) | 0] ?? a;
      const p = {
        kind, a, b, t: Math.random(), wait: Math.random() < 0.2 ? Math.random() * 15 : 0, ph: Math.random() * 6, yaw: 0, lean: 0,
        v: kind === 'elder' ? 0.65 + Math.random() * 0.2 : kind === 'child' ? 1.1 + Math.random() * 0.3 : kind === 'wheelchair' ? 0.8 : 1.05 + Math.random() * 0.35,
        s: kind === 'child' ? 0.58 + Math.random() * 0.12 : kind === 'elder' ? 0.94 : 0.95 + Math.random() * 0.1,
        pos: new THREE.Vector3(),
      };
      const shirt = kind === 'guard' ? '#1f2a44' : pick(SHIRTS);
      const pants = kind === 'guard' ? '#1b2236' : pick(PANTS);
      this.parts.torso.setColorAt(i, c.set(shirt)); this.parts.armL.setColorAt(i, c); this.parts.armR.setColorAt(i, c);
      this.parts.legL.setColorAt(i, c.set(pants)); this.parts.legR.setColorAt(i, c);
      this.parts.hair.setColorAt(i, c.set(kind === 'elder' ? pick(['#c9c6c0', '#e2e0dc', '#9c9893']) : pick(HAIR)));
      this.parts.cap.setColorAt(i, c.set(kind === 'guard' ? '#1b2236' : '#ffffff'));
      p.capOn = kind === 'guard';
      if (kind === 'wheelchair') p.chair = ci++;
      if (kind === 'guard') { p.dog = di++; this.parts.dog.setColorAt(p.dog, c.set(pick(['#2a2420', '#c08a4a', '#1c1a18', '#d9c7a0']))); }
      if (kind === 'adult') adults.push(p);
      this.list.push(p);
    });
    // 一半的小孩跟著大人走（家庭）
    for (const p of this.list) if (p.kind === 'child' && adults.length && Math.random() < 0.6) {
      p.follow = adults[(Math.random() * adults.length) | 0]; p.side = Math.random() < 0.5 ? -0.55 : 0.55;
    }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._one = new THREE.Vector3(1, 1, 1);
    this._sv = new THREE.Vector3(); this._lm = new THREE.Matrix4(); this._tmp = new THREE.Matrix4(); this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  get body() { return this.parts?.torso; }
  setVisible(v) { this.visible = v; (this.meshes || []).forEach((m) => (m.visible = v)); }

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
    if (!(p.run > 0) && Math.random() < (p.kind === 'elder' ? 0.06 : 0.03)) p.wait = 3 + Math.random() * 12;
  }

  // 手指／滑鼠點到行人：他（和旁邊 4 m 內的人、狗）會跑起來幾秒
  tap(cx, cy, camera, rect) {
    if (!this.parts || !this.visible) return false;
    const v = new THREE.Vector3(), base = isMobile ? 40 : 26; let best = -1, bd = Infinity;
    this.list.forEach((p, i) => {
      v.copy(p.pos); v.y += 0.9 * p.s;
      const dist = v.distanceTo(camera.getWorldPosition(new THREE.Vector3()));
      v.project(camera);
      if (v.z > 1) return;
      const x = rect.left + (v.x + 1) / 2 * rect.width, y = rect.top + (1 - v.y) / 2 * rect.height;
      const r = Math.max(base, 300 / dist);
      const d = Math.hypot(x - cx, y - cy);
      if (d < r && d < bd) { best = i; bd = d; }
    });
    if (best < 0) return false;
    const c = this.list[best].pos;
    this.list.forEach((p) => { if (p.pos.distanceTo(c) < 4) { p.run = 4 + Math.random() * 3; p.wait = 0; } });
    return true;
  }

  update(dt) {
    if (!this.parts || !this.visible) return;
    dt = Math.min(dt, 0.1);
    const P = this.parts, m = this._m, q = this._q, e = this._e, lm = this._lm, tmp = this._tmp;
    const setPart = (mesh, i, lx, ly, lz, rx) => {
      lm.makeRotationX(rx); lm.setPosition(lx, ly, lz);
      tmp.multiplyMatrices(m, lm); mesh.setMatrixAt(i, tmp);
    };
    this.list.forEach((p, i) => {
      const run = p.run > 0; if (run) p.run -= dt;
      let moving = false;
      if (p.follow) {
        // 跟著大人：在大人身旁，稍微落後
        const f = p.follow, fy = f.yaw;
        const tx = f.pos.x + Math.cos(fy) * p.side - Math.sin(fy) * 0.3, tz = f.pos.z - Math.sin(fy) * p.side - Math.cos(fy) * 0.3;
        const dx = tx - p.pos.x, dz = tz - p.pos.z, d = Math.hypot(dx, dz);
        moving = d > 0.05 || f.moving;
        p.pos.x += dx * Math.min(1, dt * 4); p.pos.z += dz * Math.min(1, dt * 4); p.pos.y += (f.pos.y - p.pos.y) * Math.min(1, dt * 4);
        let dy = fy - p.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); p.yaw += dy * Math.min(1, dt * 5);
        if (moving) p.ph += dt * (run || f.run > 0 ? 18 : 11);
      } else {
        if (p.wait > 0) p.wait -= dt;
        else {
          const A = this.P[p.a], B = this.P[p.b], L = Math.max(0.01, A.distanceTo(B));
          const sp = run ? (p.kind === 'wheelchair' ? 2.2 : p.kind === 'elder' ? 1.6 : 4.6) : p.v;
          p.t += (sp * dt) / L; p.ph += dt * (run ? 17 : p.kind === 'elder' ? 7 : 9) * (p.kind === 'child' ? 1.25 : 1);
          if (p.t >= 1) this.next(p);
          moving = true;
        }
        const A2 = this.P[p.a], B2 = this.P[p.b];
        p.pos.copy(A2).lerp(B2, Math.min(p.t, 1));
        const want = Math.atan2(B2.x - A2.x, B2.z - A2.z);
        let d = want - p.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += d * Math.min(1, dt * (run ? 10 : 5));
      }
      p.moving = moving;
      const sw = moving ? Math.sin(p.ph) * (run ? 0.9 : 0.45) : 0;                 // 手腳擺動角度
      const bob = moving && p.kind !== 'wheelchair' ? Math.abs(Math.sin(p.ph)) * (run ? 0.08 : 0.025) : 0;
      const leanT = (run ? 0.25 : 0) + (p.kind === 'elder' ? 0.14 : 0);
      p.lean += (leanT - p.lean) * Math.min(1, dt * 6);
      const s = p.s;
      // 人的整體變換
      e.set(p.lean, p.yaw, 0, 'YXZ'); q.setFromEuler(e);
      const seated = p.kind === 'wheelchair';
      this._sv.set(p.pos.x, p.pos.y + bob, p.pos.z);
      m.compose(this._sv, q, this._one.set(s, s, s));
      if (seated) {
        // 坐姿：整個人下降 0.42，腿往前平伸，手推輪子
        const mm = m.clone(); m.multiply(lm.makeTranslation(0, -0.42, 0));
        P.torso.setMatrixAt(i, m); P.head.setMatrixAt(i, m); P.hair.setMatrixAt(i, m);
        P.cap.setMatrixAt(i, this._zero);
        setPart(P.legL, i, -0.1, 0.92, 0.02, -1.45); setPart(P.legR, i, 0.1, 0.92, 0.02, -1.45);
        const push = moving ? Math.sin(p.ph * 0.8) * 0.5 - 0.4 : -0.3;
        setPart(P.armL, i, -0.23, 1.42, 0, push); setPart(P.armR, i, 0.23, 1.42, 0, push);
        P.chair.setMatrixAt(p.chair, mm);
        m.copy(mm);
      } else {
        P.torso.setMatrixAt(i, m); P.head.setMatrixAt(i, m);
        P.hair.setMatrixAt(i, p.capOn ? this._zero : m); P.cap.setMatrixAt(i, p.capOn ? m : this._zero);
        setPart(P.legL, i, -0.1, 0.9, 0, sw); setPart(P.legR, i, 0.1, 0.9, 0, -sw);
        // 保全右手牽繩，手臂固定往前
        setPart(P.armL, i, -0.23, 1.44, 0, -sw * 0.8);
        setPart(P.armR, i, 0.23, 1.44, 0, p.kind === 'guard' ? -0.5 : sw * 0.8);
      }
      if (p.dog != null) {
        // 狗在保全右前方
        const dx = Math.cos(p.yaw) * -0.85 + Math.sin(p.yaw) * 0.5, dz = -Math.sin(p.yaw) * -0.85 + Math.cos(p.yaw) * 0.5;
        const dogBob = moving ? Math.abs(Math.sin(p.ph * 1.6)) * 0.04 : 0;
        e.set(0, p.yaw, 0, 'YXZ'); q.setFromEuler(e);
        this._sv.set(p.pos.x + dx, p.pos.y + dogBob, p.pos.z + dz);
        tmp.compose(this._sv, q, this._one.set(1, 1, 1)); P.dog.setMatrixAt(p.dog, tmp);
      }
    });
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}
