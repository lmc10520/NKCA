import * as THREE from 'three';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { cm2w } from './util.js';

// 用 BVH 加速射線：標籤遮擋判斷、點選、取座標都靠它
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 資料卡內容：card = { h1, h2, p, sections: [{ title, items: [...] , p }] } 或 card.html
function cardHTML(l) {
  const c = l.card;
  if (c.html) return c.html;
  let h = `<h1>${esc(c.h1 ?? l.text)}</h1>`;
  if (c.h2) h += `<h2>${esc(c.h2)}</h2>`;
  if (c.p) h += `<p>${esc(c.p)}</p>`;
  for (const s of c.sections || []) {
    if (s.title) h += `<h3>${esc(s.title)}</h3>`;
    if (s.p) h += `<p>${esc(s.p)}</p>`;
    if (s.items?.length) h += '<ul>' + s.items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
  }
  if (c.img) h += `<img src="${esc(c.img)}" alt="">`;
  return h;
}

export class Labels {
  // model：用來判斷「看不看得到」（射線被建築擋住就隱藏）
  constructor(cfg, model) {
    this.model = model;
    this.root = document.getElementById('labels');
    this.ray = new THREE.Raycaster(); this.ray.firstHitOnly = true;
    this.items = (cfg?.labels || []).filter((l) => l.show !== false).map((l, i) => {
      const el = document.createElement('div'); el.className = 'lbl';
      el.innerHTML = `<span class="lblText">${esc(l.text)}</span>`;
      const it = { id: l.id || 'L' + i, cfg: l, el, base: cm2w(l.pos_cm), p: cm2w(l.pos_cm), seen: true, open: false };
      // card：展開資料卡；lift：顯示樓層選單（"core:SW"、"hall:RH"）
      if (l.card || l.lift) {
        el.classList.add(l.card ? 'clickable' : 'liftable');
        el.querySelector('.lblText').onclick = (e) => {
          e.stopPropagation();
          if (l.lift) this.onLift?.(l.lift);
          if (l.card) this.toggle(it);
        };
      }
      this.root.appendChild(el);
      return it;
    });
    this.on = true; this.cam = null; this.lastTest = 0;
    this.buildBVH();
  }

  // 在背景慢慢替大型物件建 BVH（每次最多約 25 ms），不卡畫面
  buildBVH() {
    // 超大的物件（榕樹廣場天花、地面，上百萬面）跳過：建 BVH 會卡住畫面 1–2 秒，而且幾乎不會擋住標籤
    const big = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3 > 800000;
    const queue = this.model.meshes.filter((m) => !m.geometry.boundsTree && !big(m)).sort((a, b) => a.geometry.attributes.position.count - b.geometry.attributes.position.count);
    const step = () => {
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 25) {
        const m = queue.shift();
        try { m.geometry.computeBoundsTree(); } catch { /* 略過無法建立的 */ }
      }
      if (queue.length) setTimeout(step, 16); else { this.ready = true; this.reanchor(); }
    };
    setTimeout(step, 300);
  }

  occluders() {
    return this.model.meshes.filter((m) => m.visible && !m.userData.isGlass && m.geometry.boundsTree);
  }

  // 依目前模式（哪些物件看得到）把標籤放到該位置最上層的表面上方
  reanchor() {
    if (!this.ready) return;
    const occ = this.occluders();
    for (const it of this.items) {
      it.p.copy(it.base);
      if (it.cfg.anchor === false) continue;
      this.ray.set(new THREE.Vector3(it.base.x, 250, it.base.z), new THREE.Vector3(0, -1, 0));
      const hit = this.ray.intersectObjects(occ, false)[0];
      if (hit) it.p.y = Math.max(it.base.y, hit.point.y + 1.5);
    }
    this.lastTest = 0;
  }

  set visible(v) { this.on = v; this.root.style.display = v ? '' : 'none'; if (!v) this.close(); }

  toggle(it) {
    const was = it.open;
    this.close();
    if (was) return;
    it.open = true; it.el.classList.add('open');
    const card = document.createElement('div'); card.className = 'lblCard';
    card.innerHTML = `<button class="x ms" aria-label="關閉">close</button>${cardHTML(it.cfg)}`;
    card.querySelector('.x').onclick = (e) => { e.stopPropagation(); this.close(); };
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    it.el.appendChild(card);
    this.onChange?.();
  }
  close() {
    for (const it of this.items) if (it.open) { it.open = false; it.el.classList.remove('open', 'up'); it.el.querySelector('.lblCard')?.remove(); }
    this.onChange?.();
  }
  openId() { return this.items.find((i) => i.open)?.id || null; }
  openById(id) { this.close(); const it = this.items.find((i) => i.id === id); if (it?.cfg.card) this.toggle(it); }

  update(camera, w, h) {
    if (!this.on) return;
    const now = performance.now();
    // 每 150 ms 檢查一次是否被建築擋住
    if (this.ready && now - this.lastTest > 150) {
      this.lastTest = now;
      const occ = this.occluders(), cp = new THREE.Vector3();
      camera.getWorldPosition(cp);
      for (const it of this.items) {
        const dir = it.p.clone().sub(cp); const d = dir.length();
        if (camera.isOrthographicCamera) {
          // 平行投影：從標籤往鏡頭方向打射線
          const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
          this.ray.set(it.p.clone().addScaledVector(back, 0.8), back); this.ray.far = 5000;
          it.seen = !this.ray.intersectObjects(occ, false)[0];
        } else {
          this.ray.set(cp, dir.normalize()); this.ray.far = Math.max(0, d - 0.8);
          it.seen = !this.ray.intersectObjects(occ, false)[0];
        }
      }
      this.ray.far = Infinity;
    }
    const v = new THREE.Vector3();
    for (const it of this.items) {
      v.copy(it.p).project(camera);
      const inView = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      const show = inView && (it.seen || it.open);
      it.el.classList.toggle('gone', !show);
      if (!inView) continue;
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      it.el.style.transform = `translate(${x}px,${y}px)`;
      if (it.open) it.el.classList.toggle('up', y > h * 0.55);
    }
  }
}

// ---------- 室內標示（pois.json）：小圖示或地點文字，立在樓面上（細桿＋圖示），只在指定模式／廳院樓層出現 ----------
export class Pois {
  constructor(cfg, model, labels) {
    this.model = model; this.labels = labels;     // 借用 Labels 的 BVH 與遮擋判斷
    this.root = document.getElementById('labels');
    this.ray = new THREE.Raycaster(); this.ray.firstHitOnly = true;
    this.icons = cfg?.icons || {};
    this.pole = cfg?.pole_m ?? 3;
    this.within = cfg?.showWithin_m ?? 220;
    this.items = (cfg?.items || []).filter((p) => p.show !== false && p.pos_cm).map((p) => {
      const el = document.createElement('div'); el.className = 'poi gone';
      const src = p.icon && (this.icons[p.icon] || `img/icons/${p.icon}.svg`);
      el.innerHTML = '<div class="poiPole"></div>' + (src
        ? `<div class="poiTile" title="${esc(p.text || p.icon)}"><img src="${esc(src)}" alt="${esc(p.text || p.icon)}"></div>`
        : `<div class="poiText">${esc(p.text)}</div>`);
      this.root.appendChild(el);
      const a = cm2w(p.pos_cm);
      return { cfg: p, el, a, b: a.clone().add(new THREE.Vector3(0, p.pole_m ?? this.pole, 0)), on: false, seen: true };
    });
    this.on = true; this.lastTest = 0;
  }
  set visible(v) { this.on = v; for (const it of this.items) it.el.style.display = v ? '' : 'none'; }
  // 依模式與廳院樓層決定哪些標示出現
  setContext(state) {
    for (const it of this.items) {
      const c = it.cfg;
      let on = !c.modes || c.modes.includes(state.mode);
      if (c.hall) on = on && state.halls?.[c.hall] === (c.floor ?? state.halls?.[c.hall]);
      it.on = on;
    }
    this.lastTest = 0;
  }
  update(camera, w, h) {
    if (!this.on) return;
    const cp = new THREE.Vector3(); camera.getWorldPosition(cp);
    const now = performance.now();
    if (this.labels.ready && now - this.lastTest > 200) {
      this.lastTest = now;
      const occ = this.labels.occluders();
      for (const it of this.items) {
        if (!it.on) continue;
        const dir = it.b.clone().sub(cp), d = dir.length();
        this.ray.set(cp, dir.normalize()); this.ray.far = Math.max(0, d - 0.5);
        it.seen = !this.ray.intersectObjects(occ, false)[0];
      }
      this.ray.far = Infinity;
    }
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    for (const it of this.items) {
      const near = camera.isOrthographicCamera ? (camera.top - camera.bottom) < this.within : it.b.distanceTo(cp) < this.within;
      A.copy(it.a).project(camera); B.copy(it.b).project(camera);
      const inView = B.z < 1 && B.z > -1 && Math.abs(B.x) < 1.05 && Math.abs(B.y) < 1.05;
      const show = it.on && near && inView && it.seen;
      it.el.classList.toggle('gone', !show);
      if (!show) continue;
      const bx = (B.x * 0.5 + 0.5) * w, by = (-B.y * 0.5 + 0.5) * h, ax = (A.x * 0.5 + 0.5) * w, ay = (-A.y * 0.5 + 0.5) * h;
      it.el.style.transform = `translate(${bx}px,${by}px)`;
      const pole = it.el.firstChild, L = Math.hypot(ax - bx, ay - by);
      pole.style.height = L + 'px';
      pole.style.transform = `rotate(${Math.atan2(-(ax - bx), ay - by)}rad)`;
    }
  }
}
