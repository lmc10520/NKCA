import * as THREE from 'three';
import { cm2w } from './util.js';

// ---------- 節慶物件 ----------
// config/festivals.json 的 events：每個活動有檔期（from／to）與物件清單。
//   日期可寫 "2026-11-07"（只有那一年）或 "12-01"（每年）；以台灣時間判斷。
//   網址加 ?festival=活動id 可以不管檔期直接預覽（例如 ?festival=xmas）。
// 物件 type：
//   pumpkin   南瓜氣球（height_cm）
//   ghosts    鬼怪投影：從地面投影機把可愛的鬼影投在建築上（夜間才看得到）。projectors：[{ from_cm, to_cm, size_m }]
//   ball      大型充氣球（diameter_cm；texture 可放自己的圖檔，沒有就用 color 單色）
//   xmasTree  聖誕樹（height_cm）
// 位置 pos_cm 只要給平面 [x, y]，高度會自動貼齊地面（也可以給 [x, y, z]）。
export class Festival {
  constructor(scene, cfg, model) {
    this.scene = scene; this.cfg = cfg || {}; this.model = model;
    this.root = new THREE.Group(); this.root.name = 'Festival'; scene.add(this.root);
    this.on = true; this.k = 0; this.t = 0;
    this.items = []; this.lights = [];
    const force = new URLSearchParams(location.search).get('festival');
    const ids = force ? force.split(',') : null;   // 可以一次預覽多個：?festival=ball,xmas
    this.events = (this.cfg.events || []).filter((e) => e.enabled !== false && (ids ? ids.includes(e.id) : this.inRange(e)));
    this.ground = model.meshes.filter((m) => m.userData.isGround && !m.userData.excluded);
    this.ray = new THREE.Raycaster();
    for (const e of this.events) for (const o of e.objects || []) {
      try { this.build(o); } catch (err) { console.warn('[festival]', o.type, err); }
    }
    this.root.visible = false;
  }

  get active() { return this.events.length > 0; }
  get names() { return this.events.map((e) => e.name).join('、'); }

  inRange(e) {
    const tp = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const y = tp.getFullYear(), pad = (n) => String(n).padStart(2, '0');
    const today = `${y}-${pad(tp.getMonth() + 1)}-${pad(tp.getDate())}`;
    const full = (d) => (/^\d{2}-\d{2}$/.test(d) ? `${y}-${d}` : d);
    if (!e.from || !e.to) return false;
    const a = full(e.from), b = full(e.to);
    // 每年的檔期可以跨年（例如 12-20 到 01-05）
    if (/^\d{2}-\d{2}$/.test(e.from) && a > b) return today >= a || today <= b;
    return today >= a && today <= b;
  }

  // 地面高度（網頁座標 y，公尺）
  groundAt(x, z) {
    this.ray.set(new THREE.Vector3(x, 120, z), new THREE.Vector3(0, -1, 0));
    const h = this.ray.intersectObjects(this.ground, false)[0];
    return h ? h.point.y : 0;
  }
  place(o) {
    const p = cm2w([o.pos_cm[0], o.pos_cm[1], o.pos_cm[2] ?? 0]);
    if (o.pos_cm[2] == null) p.y = this.groundAt(p.x, p.z);
    return p;
  }

  build(o) {
    if (o.type === 'pumpkin') return this.pumpkin(o);
    if (o.type === 'ghosts') return this.ghosts(o);
    if (o.type === 'ball') return this.ball(o);
    if (o.type === 'xmasTree') return this.xmasTree(o);
  }

  // ---- 南瓜氣球：有稜的扁圓球＋莖＋發光的笑臉 ----
  pumpkin(o) {
    const H = (o.height_cm || 1200) / 100, R = H * 0.56, g = new THREE.Group();
    const geo = new THREE.SphereGeometry(1, 128, 64), pos = geo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const a = Math.atan2(v.z, v.x), rib = 1 - 0.07 * Math.pow(Math.abs(Math.sin(a * 5)), 0.6);   // 10 道稜
      const flat = 0.78 + 0.08 * (1 - Math.abs(v.y));
      v.x *= R * rib; v.z *= R * rib; v.y *= R * flat;
      v.y -= (v.y < 0 ? 0.08 : 0) * R * (1 - Math.abs(v.x / R));   // 底部微微壓扁
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    // 臉：畫在球面貼圖上（u 對應方位角），朝 face_deg 方向（0＝模型 +Y 北、90＝東）
    const tex = this.faceTexture(), emi = this.faceTexture(true);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissiveMap: emi, emissive: 0xffb000, emissiveIntensity: 0, roughness: 0.42, metalness: 0 });
    const body = new THREE.Mesh(geo, mat); body.castShadow = true;
    body.position.y = R * 0.86;
    // SphereGeometry 的 u=0.5 朝 -X；轉到 face_deg
    const face = THREE.MathUtils.degToRad(o.face_deg ?? 0);
    body.rotation.y = -Math.PI / 2 - face + Math.PI;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.07, R * 0.11, R * 0.42, 16, 4), new THREE.MeshStandardMaterial({ color: 0x4f6b2a, roughness: 0.8 }));
    stem.position.y = R * 0.86 + R * 0.86 * 0.9; stem.rotation.z = 0.18; stem.castShadow = true;
    const leaf = new THREE.Mesh(new THREE.TorusGeometry(R * 0.14, R * 0.03, 8, 24, Math.PI * 1.3), stem.material);
    leaf.position.set(R * 0.12, stem.position.y - R * 0.12, 0); leaf.rotation.set(Math.PI / 2, 0, 0.6);
    g.add(body, stem, leaf);
    g.position.copy(this.place(o));
    this.root.add(g);
    this.items.push({ type: 'pumpkin', g, body, mat, phase: Math.random() * 6 });
  }
  faceTexture(glow = false) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512;
    const x = cv.getContext('2d');
    if (!glow) {
      const gr = x.createLinearGradient(0, 0, 0, 512);
      gr.addColorStop(0, '#f08a2a'); gr.addColorStop(0.5, '#f7962e'); gr.addColorStop(1, '#de7020');
      x.fillStyle = gr; x.fillRect(0, 0, 1024, 512);
    } else { x.fillStyle = '#4a1d00'; x.fillRect(0, 0, 1024, 512); }   // 夜間整顆氣球微微發光，臉最亮
    // 臉在 u=0.5 附近（貼圖中央）；可愛的圓眼、小三角鼻、微笑
    x.fillStyle = glow ? '#ffd27a' : '#3a1a06';
    const eye = (cx) => { x.beginPath(); x.ellipse(cx, 225, 34, 44, 0, 0, Math.PI * 2); x.fill(); };
    eye(462); eye(562);
    if (!glow) { x.fillStyle = '#fff'; x.beginPath(); x.arc(472, 210, 10, 0, Math.PI * 2); x.arc(572, 210, 10, 0, Math.PI * 2); x.fill(); x.fillStyle = '#3a1a06'; }
    x.beginPath(); x.moveTo(512, 262); x.lineTo(498, 284); x.lineTo(526, 284); x.closePath(); x.fill();
    x.beginPath(); x.moveTo(442, 300); x.quadraticCurveTo(512, 372, 582, 300); x.quadraticCurveTo(512, 340, 442, 300); x.fill();
    if (!glow) { x.fillStyle = 'rgba(255,140,140,.45)'; x.beginPath(); x.ellipse(430, 280, 22, 12, 0, 0, Math.PI * 2); x.ellipse(594, 280, 22, 12, 0, 0, Math.PI * 2); x.fill(); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }

  // ---- 鬼怪投影：聚光燈投影貼圖（SpotLight.map），投在建築表面上會順著曲面 ----
  ghosts(o) {
    const list = o.projectors || [];
    list.forEach((pj, i) => {
      const L = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(pj.angle_deg || 14), 0.25, 0);
      L.map = this.ghostTexture(i);
      L.castShadow = false;   // 不需要陰影；投影矩陣每幀自己更新
      L.position.copy(cm2w(pj.from_cm)); L.target.position.copy(cm2w(pj.to_cm));
      this.root.add(L, L.target);
      this.lights.push({ L, base: L.target.position.clone(), k: pj.intensity ?? 6, phase: i * 1.7, drift: pj.drift_m ?? 3 });
    });
  }
  ghostTexture(i) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 512;
    const x = cv.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 512, 512);
    const tints = ['#d9ccff', '#c7f0ff', '#ffd9b8'];
    // 一隻可愛的小鬼：圓頭、波浪下擺、黑眼睛、腮紅；旁邊幾隻小蝙蝠
    x.save(); x.translate(256, 250); x.scale(1 + (i % 2) * 0.08, 1);
    x.shadowColor = '#b59cff'; x.shadowBlur = 40;
    x.fillStyle = tints[i % tints.length];
    x.beginPath(); x.moveTo(-110, 40); x.bezierCurveTo(-118, -170, 118, -170, 110, 40);
    for (let k = 0; k < 4; k++) { const x0 = 110 - k * 55; x.quadraticCurveTo(x0 - 14, 92, x0 - 27, 52); x.quadraticCurveTo(x0 - 41, 14, x0 - 55, 60); }
    x.closePath(); x.fill(); x.shadowBlur = 0;
    x.fillStyle = '#000'; x.beginPath(); x.ellipse(-40, -42, 16, 22, 0, 0, Math.PI * 2); x.ellipse(40, -42, 16, 22, 0, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.ellipse(0, 4, 18, i % 2 ? 22 : 12, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(255,120,170,.8)'; x.beginPath(); x.ellipse(-72, -6, 16, 9, 0, 0, Math.PI * 2); x.ellipse(72, -6, 16, 9, 0, 0, Math.PI * 2); x.fill();
    x.restore();
    x.fillStyle = '#ffb347';
    for (const [bx, by, s] of [[90, 90, 1], [420, 120, 0.8], [400, 420, 0.7]]) {
      x.save(); x.translate(bx, by); x.scale(s, s); x.beginPath();
      x.moveTo(0, 0); x.quadraticCurveTo(-20, -18, -44, -6); x.quadraticCurveTo(-30, 0, -26, 12); x.quadraticCurveTo(-12, 4, 0, 12);
      x.quadraticCurveTo(12, 4, 26, 12); x.quadraticCurveTo(30, 0, 44, -6); x.quadraticCurveTo(20, -18, 0, 0); x.fill(); x.restore();
    }
    // 外圈淡出，投出來不會有方框
    const gr = x.createRadialGradient(256, 256, 180, 256, 256, 256);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---- 大型充氣球：可放自己的貼圖（等距柱狀投影 2:1），沒有就單色 ----
  ball(o) {
    const D = (o.diameter_cm || 400) / 100;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color || '#f2c230'), roughness: 0.35, metalness: 0 });
    if (o.texture) new THREE.TextureLoader().load(o.texture, (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true; },
      undefined, () => console.warn('[festival] 找不到貼圖', o.texture));
    const m = new THREE.Mesh(new THREE.SphereGeometry(D / 2, 64, 32), mat); m.castShadow = true;
    m.position.y = D / 2 * 0.97; m.rotation.y = THREE.MathUtils.degToRad(o.rotate_deg || 0);
    const g = new THREE.Group(); g.add(m); g.position.copy(this.place(o));
    this.root.add(g);
    this.items.push({ type: 'ball', g, m, D, phase: Math.random() * 6 });
  }

  // ---- 聖誕樹：層層圓錐＋彩色燈泡（夜間閃爍、會發光暈）＋頂端星星 ----
  xmasTree(o) {
    const H = (o.height_cm || 1500) / 100, g = new THREE.Group();
    const green = new THREE.MeshStandardMaterial({ color: 0x1f5a34, roughness: 0.85 });
    const layers = 7, R0 = H * 0.33;
    for (let i = 0; i < layers; i++) {
      const f = i / layers, r = R0 * (1 - f * 0.82), h = H * 0.24;
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 40, 1, true), green);
      c.position.y = H * 0.1 + f * H * 0.78 + h / 2; c.castShadow = true; g.add(c);
      const cap = new THREE.Mesh(new THREE.CircleGeometry(r, 40), green); cap.rotation.x = Math.PI / 2; cap.position.y = c.position.y - h / 2; g.add(cap);
    }
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.03, H * 0.04, H * 0.14, 16), new THREE.MeshStandardMaterial({ color: 0x5b3a22 }));
    trunk.position.y = H * 0.07; g.add(trunk);
    // 燈泡：沿著螺旋分佈在錐面上
    const n = 900, p = [], col = [], base = [];
    const pal = [[1, 0.25, 0.2], [1, 0.82, 0.3], [0.35, 0.75, 1], [1, 1, 0.92], [0.4, 1, 0.5]];
    for (let i = 0; i < n; i++) {
      const f = Math.pow(Math.random(), 0.8), y = H * 0.12 + f * H * 0.84;
      const r = R0 * (1 - (y - H * 0.1) / (H * 0.95)) * 1.02 + 0.05, a = Math.random() * Math.PI * 2;
      p.push(Math.cos(a) * r, y, Math.sin(a) * r);
      const c = pal[i % pal.length]; col.push(...c); base.push(...c);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const bulbs = new THREE.Points(bg, new THREE.PointsMaterial({ size: 0.28, vertexColors: true, toneMapped: false, map: dotTexture(), transparent: true, depthWrite: false }));
    g.add(bulbs);
    // 彩球
    const ballGeo = new THREE.SphereGeometry(H * 0.018, 16, 12);
    const cols = [0xc81d25, 0xe6b422, 0x2f6fd0, 0xd8d8d8];
    for (let i = 0; i < 70; i++) {
      const y = H * 0.14 + Math.random() * H * 0.72, r = R0 * (1 - (y - H * 0.1) / (H * 0.95)) * 0.97, a = Math.random() * Math.PI * 2;
      const b = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.2, metalness: 0.6 }));
      b.position.set(Math.cos(a) * r, y, Math.sin(a) * r); g.add(b);
    }
    // 星星
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? H * 0.022 : H * 0.055, a = Math.PI / 2 + i * Math.PI / 5; i ? shape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    const starMat = new THREE.MeshStandardMaterial({ color: 0xffd84a, emissive: 0xffc21a, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.3 });
    const star = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: H * 0.012, bevelEnabled: false }), starMat);
    star.position.y = H * 1.0; g.add(star);
    g.position.copy(this.place(o));
    this.root.add(g);
    this.items.push({ type: 'tree', g, bulbs, base: new Float32Array(base), star, starMat });
  }

  setOn(v) { this.on = v; }

  // night：0 白天 → 1 夜晚
  update(dt, night) {
    if (!this.active) return;
    this.t += dt;
    this.k += ((this.on ? 1 : 0) - this.k) * Math.min(1, dt * 3);
    this.root.visible = this.k > 0.01;
    const t = this.t;
    for (const it of this.items) {
      it.g.scale.setScalar(Math.max(0.001, this.k));   // 開關時長出／收起
      if (it.type === 'pumpkin') {
        it.body.rotation.z = Math.sin(t * 0.5 + it.phase) * 0.015;
        it.mat.emissiveIntensity = night * 1.6;
      } else if (it.type === 'ball') {
        it.m.rotation.y += dt * 0.05;
      } else if (it.type === 'tree') {
        const c = it.bulbs.geometry.attributes.color, a = c.array, b = it.base;
        const lit = 0.35 + night * 0.9;
        for (let i = 0; i < a.length; i += 3) {
          const tw = 0.55 + 0.45 * Math.sin(t * (1.3 + (i % 7) * 0.3) + i);
          a[i] = b[i] * tw * lit; a[i + 1] = b[i + 1] * tw * lit; a[i + 2] = b[i + 2] * tw * lit;
        }
        c.needsUpdate = true;
        it.starMat.emissiveIntensity = 0.4 + night * 2.2;
        it.star.rotation.y = t * 0.4;
      }
    }
    // 投影：只有夜間看得到；鬼影緩緩左右飄、上下浮動
    for (const l of this.lights) {
      l.L.intensity = night * this.k * l.k;
      l.L.target.position.set(l.base.x + Math.sin(t * 0.25 + l.phase) * l.drift, l.base.y + Math.sin(t * 0.7 + l.phase) * l.drift * 0.25, l.base.z);
      l.L.target.updateMatrixWorld();
      l.L.shadow.updateMatrices(l.L);   // SpotLight.map 用陰影相機的矩陣做投影
    }
  }
}

function dotTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
