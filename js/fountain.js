import * as THREE from 'three';
import { cm2w } from './util.js';

// 旱地噴泉：整點演出，水柱高度起伏 + LED 變色（夜間更明顯）
export class Fountain {
  constructor(scene, cfg) {
    this.cfg = cfg; this.forced = false;
    const n = cfg.nozzles.length;
    const r = (cfg.jet?.radius_cm ?? 3) / 100;
    const g = new THREE.CylinderGeometry(r * 0.6, r * 1.6, 1, 8, 1, true);
    g.translate(0, 0.5, 0);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(g, this.mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.base = cfg.nozzles.map((p) => cm2w([p.x_cm, p.y_cm, p.z_cm ?? 1.5]));
    this.rc = cfg.nozzles.map((p) => [p.row, p.col]);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    // 水柱底部的 LED 光點
    const lg = new THREE.CircleGeometry(0.16, 16); lg.rotateX(-Math.PI / 2);
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    this.leds = new THREE.InstancedMesh(lg, this.ledMat, n);
    this.leds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const m = new THREE.Matrix4();
    this.base.forEach((p, i) => { m.makeTranslation(p.x, p.y + 0.02, p.z); this.leds.setMatrixAt(i, m); });
    scene.add(this.mesh, this.leds);
    this.H = (cfg.jet?.height_cm ?? 260) / 100;
  }

  isShowTime(date) {
    if (this.forced) return true;
    const s = this.cfg.schedule || { minute: 0, duration_min: 10 };
    const tp = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const m = tp.getMinutes();
    return m >= s.minute && m < s.minute + s.duration_min;
  }

  update(t, date, night) {
    const on = this.isShowTime(date);
    this.mesh.visible = on;
    this.ledMat.opacity = on ? 0.4 + 0.6 * night : 0;
    this.leds.visible = on;
    if (!on) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color();
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
      h = Math.max(0.05, h) * this.H;
      s.set(1, h, 1);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(i, m);
      c.setHSL(((t * 0.05) + d * 0.04) % 1, 0.9, 0.6);
      const w = new THREE.Color(0xe8f4ff).lerp(c, night);
      this.mesh.setColorAt(i, w);
      this.leds.setColorAt(i, c);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.leds.instanceColor.needsUpdate = true;
  }
}
