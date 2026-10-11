import * as THREE from 'three';
import { cm2w } from './util.js';

export class Labels {
  constructor(cfg) {
    this.root = document.getElementById('labels');
    this.items = (cfg?.labels || []).filter((l) => l.show !== false).map((l) => {
      const el = document.createElement('div'); el.className = 'lbl'; el.textContent = l.text;
      this.root.appendChild(el);
      return { el, p: cm2w(l.pos_cm) };
    });
    this.on = true;
  }
  set visible(v) { this.on = v; this.root.style.display = v ? '' : 'none'; }
  update(camera, w, h) {
    if (!this.on) return;
    const v = new THREE.Vector3();
    for (const it of this.items) {
      v.copy(it.p).project(camera);
      const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      it.el.style.display = show ? '' : 'none';
      if (show) it.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px,${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-120%)`;
    }
  }
}
