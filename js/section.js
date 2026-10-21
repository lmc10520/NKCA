import * as THREE from 'three';

// ---------- 剖面（X／Y／Z 三個方向的裁切面） ----------
// 只切「建築」：模型裡不屬於地面的物件（site.json 的 section.keep，預設和 groundMatch 相同）。
// 地面、道路、人車、鋼琴、天空、地平線、標籤都不切。
// 做法：GPU 裁切平面（material.clippingPlanes），不改幾何、不重算，移動剖面只是更新數字。
// 切口填色：模型材質是雙面的，切開後看到的「背面」直接塗成單色，看起來像實心的剖面（不畫剖面線）。
// 座標：滑桿數值是 Fusion 模型座標（m）。X → 網頁 x、Y → 網頁 -z、Z → 網頁 y。
const AX = ['x', 'y', 'z'];

export class Section {
  constructor({ model, cfg = {}, isCut, scene }) {
    this.cfg = cfg;
    this.isCut = isCut;
    this.planes = AX.map(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e7));   // 未啟用的軸：永遠不切
    this.active = [];          // 套用在材質上的陣列（同一個陣列，開關時才換）
    this.mats = new Set();
    this.on = false;
    this.capOn = cfg.capFill === true;   // 切口填色預設關（site.json 的 section.capFill）
    this.capU = { on: { value: 0 }, col: { value: new THREE.Color(cfg.capColor || '#7a7e84') } };
    this.state = { x: { on: false, v: 0, flip: false }, y: { on: false, v: 0, flip: false }, z: { on: false, v: 0, flip: false } };
    // 建築範圍（模型座標 m）
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const m of model.meshes) if (isCut(m)) box.union(b.setFromObject(m));
    this.range = {
      x: [box.min.x, box.max.x], y: [-box.max.z, -box.min.z], z: [Math.max(0, box.min.y), box.max.y],
    };
    for (const a of AX) this.state[a].v = (this.range[a][0] + this.range[a][1]) / 2;
    this.state.z.v = Math.min(this.range.z[1], (this.range.z[0] + this.range.z[1]) * 0.35);
    // 拖滑桿時顯示淡藍色的剖面位置，放開 1.2 秒後淡出
    this.guide = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: 0x1a73e8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    this.guide.renderOrder = 5; this.guide.visible = false; this.guide.raycast = () => {};
    this.guideBox = box.clone().expandByScalar(4);
    scene.add(this.guide);
    this.guideT = 0;
    // 剖面底板：建築下方原本沒有地面，切掉榕樹廣場地坪後會直接看到天空；剖面開啟時在所有建築物件最低點下方鋪一層，
    // 像剖開後露出的土層。之後加入地下樓層，高度會自動跟著往下。
    this.baseY = box.min.y - 0.05;
    this.base = null;
    this.installRaycastFilter();
  }

  // rect：基地範圍（網頁座標 m，同 horizon.js 的 siteRect）
  addBase(scene, rect, color) {
    if (!rect) return;
    const w = rect.x1 - rect.x0, d = rect.z1 - rect.z0;
    this.baseMat = new THREE.MeshLambertMaterial({ color: color || '#b9b3a8', side: THREE.DoubleSide });
    this.base = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), this.baseMat);
    this.base.position.set((rect.x0 + rect.x1) / 2, this.baseY, (rect.z0 + rect.z1) / 2);
    this.base.name = 'SectionBase'; this.base.visible = false; this.base.raycast = () => {};
    this.base.receiveShadow = true;
    scene.add(this.base);
  }

  // 建築會用到的材質都要登記（模型材質、樣式材質、線條材質）
  register(mat, { cap = true } = {}) {
    if (!mat || this.mats.has(mat)) return;
    this.mats.add(mat);
    mat.clipShadows = true;
    if (this.on) { mat.clippingPlanes = this.active; mat.needsUpdate = true; }
    if (!cap || mat.transparent || !(mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshBasicMaterial || mat.isMeshPhongMaterial)) return;
    // 切口填色：背面像素塗成單色（只在剖面開啟且切口填色開啟時）
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    const U = this.capU;
    mat.onBeforeCompile = function (sh, r) {
      prev.call(this, sh, r);
      sh.uniforms.uCapOn = U.on; sh.uniforms.uCapCol = U.col;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uCapOn; uniform vec3 uCapCol;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tif (uCapOn > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uCapCol, 1.0);');
    };
    mat.customProgramCacheKey = function () { return 'cap1|' + prevKey.call(this) + '|' + prev.toString(); };
    mat.needsUpdate = true;
  }

  setOn(v) {
    v = !!v;
    if (v && !AX.some((a) => this.state[a].on)) this.state.x.on = true;   // 打開時至少切一個方向
    if (v === this.on) { this.update(); return; }
    this.on = v;
    this.active = v ? this.planes : [];
    // 開關時才重新編譯著色器（之後移動剖面不必）
    for (const m of this.mats) { m.clippingPlanes = v ? this.active : null; m.needsUpdate = true; }
    this.update();
  }
  setCap(v) { this.capOn = !!v; this.update(); }
  setCapColor(c) { this.capU.col.value.set(c); }
  set(axis, patch, showGuide) {
    Object.assign(this.state[axis], patch);
    this.update();
    if (showGuide && this.on && this.state[axis].on) this.showGuide(axis);
  }
  update() {
    AX.forEach((a, i) => {
      const s = this.state[a], p = this.planes[i];
      if (!this.on || !s.on) { p.normal.set(0, 1, 0); p.constant = 1e7; return; }
      const sg = s.flip ? 1 : -1;   // 預設保留數值較小的一側（切掉 +方向），翻轉則相反
      if (a === 'x') { p.normal.set(sg, 0, 0); p.constant = -sg * s.v; }
      if (a === 'y') { p.normal.set(0, 0, -sg); p.constant = -sg * s.v; }        // 模型 Y = 網頁 -z
      if (a === 'z') { p.normal.set(0, sg, 0); p.constant = -sg * s.v; }
    });
    this.capU.on.value = this.on && this.capOn ? 1 : 0;
    if (this.base) this.base.visible = this.on;
  }
  showGuide(axis) {
    const b = this.guideBox, s = this.state[axis], g = this.guide;
    const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
    const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
    g.rotation.set(0, 0, 0);
    if (axis === 'x') { g.position.set(s.v, cy, cz); g.rotation.y = Math.PI / 2; g.scale.set(sz, sy, 1); }
    if (axis === 'y') { g.position.set(cx, cy, -s.v); g.scale.set(sx, sy, 1); }
    if (axis === 'z') { g.position.set(cx, s.v, cz); g.rotation.x = -Math.PI / 2; g.scale.set(sx, sz, 1); }
    this.guideT = 1.2;
  }
  tick(dt) {
    this.guideT = Math.max(0, this.guideT - dt);
    const o = Math.min(1, this.guideT / 0.4) * 0.16;
    this.guide.material.opacity = o; this.guide.visible = o > 0.005;
  }
  // 簡報代碼
  toCode() {
    if (!this.on) return null;
    const o = { c: this.capOn ? 1 : 0 };
    for (const a of AX) { const s = this.state[a]; if (s.on) o[a] = [Math.round(s.v * 100) / 100, s.flip ? 1 : 0]; }
    return o;
  }
  fromCode(o) {
    if (!o) { this.setOn(false); return; }
    for (const a of AX) { const v = o[a]; this.state[a].on = !!v; if (v) { this.state[a].v = v[0]; this.state[a].flip = !!v[1]; } }
    if (o.c != null) this.capOn = !!o.c;
    this.setOn(true);
  }

  // 射線（點選、標籤遮擋）忽略被切掉的部分
  installRaycastFilter() {
    if (THREE.Mesh.prototype.raycast.__section) return;
    const orig = THREE.Mesh.prototype.raycast;
    const f = function (rc, out) {
      const cp = this.material?.clippingPlanes;
      if (!cp || !cp.length) return orig.call(this, rc, out);
      const n0 = out.length, fho = rc.firstHitOnly;
      rc.firstHitOnly = false;
      orig.call(this, rc, out);
      rc.firstHitOnly = fho;
      let keep = out.splice(n0).filter((h) => cp.every((p) => p.distanceToPoint(h.point) >= -1e-3));
      if (fho && keep.length > 1) keep = [keep.reduce((a, b) => (a.distance < b.distance ? a : b))];
      out.push(...keep);
    };
    f.__section = true;
    THREE.Mesh.prototype.raycast = f;
  }
}
