import * as THREE from 'three';
import { cm2w } from './util.js';

// 旱地噴泉：整點演出，水柱高度起伏 + LED 變色（夜間更明顯）
export class Fountain {
  constructor(scene, cfg) {
    this.cfg = cfg; this.forced = false;
    const n = cfg.nozzles.length;
    const r = (cfg.jet?.radius_cm ?? 5) / 100;
    // 水柱：實心的芯 + 外層水霧，頂端有水花，底部有濺起的水圈，讓水柱遠看也明顯
    const g = new THREE.CylinderGeometry(r * 0.7, r * 1.3, 1, 10, 1, true).translate(0, 0.5, 0);
    const gs = new THREE.CylinderGeometry(r * 2.6, r * 1.8, 1, 10, 1, true).translate(0, 0.5, 0);
    const gc = new THREE.IcosahedronGeometry(1, 1).scale(1, 0.75, 1);
    const gp = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const mk = (geo, op) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: op, depthWrite: false, toneMapped: false });
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      scene.add(im); return im;
    };
    this.mesh = mk(g, 0.8); this.mat = this.mesh.material;
    this.sheath = mk(gs, 0.22); this.crown = mk(gc, 0.22); this.splash = mk(gp, 0.28);
    this.parts = [this.mesh, this.sheath, this.crown, this.splash];
    this.base = cfg.nozzles.map((p) => cm2w([p.x_cm, p.y_cm, p.z_cm ?? 1.5]));
    this.rc = cfg.nozzles.map((p) => [p.row, p.col]);
    // 水柱底部的 LED 光點
    const lg = new THREE.CircleGeometry(0.16, 16); lg.rotateX(-Math.PI / 2);
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    this.leds = new THREE.InstancedMesh(lg, this.ledMat, n);
    this.leds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const m = new THREE.Matrix4();
    this.base.forEach((p, i) => { m.makeTranslation(p.x, p.y + 0.02, p.z); this.leds.setMatrixAt(i, m); });
    scene.add(this.leds);
    this.H = (cfg.jet?.height_cm ?? 650) / 100;
    this.minR = cfg.jet?.min_ratio ?? 0.3;
  }

  isShowTime(date) {
    if (this.forced) return true;
    const s = this.cfg.schedule || {};
    const hm = (t, d) => { const [h, m] = String(t ?? d).split(':').map(Number); return h * 60 + (m || 0); };
    const tp = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const now = tp.getHours() * 60 + tp.getMinutes();
    const start = tp.getHours() * 60 + (s.minute ?? 0);          // 這一小時的啟動時間
    if (start < hm(s.open, '00:00') || start >= hm(s.close, '24:00')) return false;
    return now >= start && now < start + (s.duration_min ?? 15);
  }

  update(t, date, night) {
    const on = this.isShowTime(date);
    this.parts.forEach((x) => (x.visible = on));
    this.ledMat.opacity = on ? 0.4 + 0.6 * night : 0;
    this.leds.visible = on;
    if (!on) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color(), tp = new THREE.Vector3();
    const cx = 10, cy = 6;
    this.base.forEach((p, i) => {
      const [row, col] = this.rc[i];
      const d = Math.hypot(col - cx, (row - cy) * 1.2);
      // 由中心向外擴散的波浪 + 每 20 秒換一種節奏
      const phase = Math.floor(t / 20) % 3;
      let h;
      if (phase === 0) h = 0.5 + 0.5 * Math.sin(t * 2.2 - d * 0.7);
      else if (phase === 1) h = 0.5 + 0.5 * Math.sin(t * 1.6 + col * 0.6);
      else h = (Math.sin(t * 3 + row) > 0.2 ? 1 : 0.15);
      h = (this.minR + (1 - this.minR) * Math.max(0, h)) * this.H;
      s.set(1, h, 1); m.compose(p, q, s);
      this.mesh.setMatrixAt(i, m); this.sheath.setMatrixAt(i, m);
      const cr = 0.08 + h * 0.025; tp.set(p.x, p.y + h, p.z); s.set(cr, cr, cr); m.compose(tp, q, s);
      this.crown.setMatrixAt(i, m);
      const sr = 0.3 + h * 0.07; tp.set(p.x, p.y + 0.03, p.z); s.set(sr, 1, sr); m.compose(tp, q, s);
      this.splash.setMatrixAt(i, m);
      c.setHSL(((t * 0.05) + d * 0.04) % 1, 0.9, 0.6);
      const w = new THREE.Color(0xd9ecff).lerp(c, night);
      for (const x of this.parts) x.setColorAt(i, w);
      this.leds.setColorAt(i, c);
    });
    for (const x of this.parts) { x.instanceMatrix.needsUpdate = true; x.instanceColor.needsUpdate = true; }
    this.leds.instanceColor.needsUpdate = true;
  }
}
