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
      if (l.card) {
        el.classList.add('clickable');
        el.querySelector('.lblText').onclick = (e) => { e.stopPropagation(); this.toggle(it); };
      }
      this.root.appendChild(el);
      return it;
    });
    this.on = true; this.cam = null; this.lastTest = 0;
    this.buildBVH();
  }

  // 在背景慢慢替大型物件建 BVH（每次最多約 25 ms），不卡畫面
  buildBVH() {
    const queue = this.model.meshes.filter((m) => !m.geometry.boundsTree).sort((a, b) => b.geometry.index?.count - a.geometry.index?.count);
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
