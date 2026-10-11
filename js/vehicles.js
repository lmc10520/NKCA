import * as THREE from 'three';
import { cm2w } from './util.js';

// 車輛：沿 config/roads.json 的路線移動，夜間開頭燈、尾燈
export class Vehicles {
  constructor(scene, cfg, lightCfg) {
    this.list = [];
    if (!cfg?.enabled) return;
    const head = new THREE.MeshBasicMaterial({ color: lightCfg?.headlight || '#fff6dd', toneMapped: false });
    const tail = new THREE.MeshBasicMaterial({ color: lightCfg?.taillight || '#ff3b2f', toneMapped: false });
    this.lampMats = [head, tail];
    const glowTex = makeGlow();
    for (const r of cfg.routes || []) {
      const pts = r.pts_cm.map((p) => cm2w(p).setY(0.45));
      const curve = new THREE.CatmullRomCurve3(pts, !!r.loop, 'catmullrom', 0.01);
      const len = curve.getLength();
      const car = r.type === 'scooter';
      for (let i = 0; i < (r.count || 4); i++) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(car ? 0.7 : 1.8, car ? 1.1 : 1.4, car ? 1.8 : 4.4),
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.2, 0.25 + Math.random() * 0.5), roughness: 0.4 }));
        body.position.y = car ? 0.55 : 0.7;
        g.add(body);
        const zf = car ? -0.95 : -2.25, zb = -zf;
        for (const x of car ? [0] : [-0.6, 0.6]) {
          const h = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), head); h.position.set(x, 0.7, zf); g.add(h);
          const t = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), tail); t.position.set(x, 0.75, zb); g.add(t);
        }
        const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff1cc, transparent: true, depthWrite: false, opacity: 0 }));
        beam.scale.set(car ? 3 : 6, car ? 3 : 6, 1); beam.position.set(0, 0.4, zf - (car ? 1.2 : 2.5));
        g.add(beam);
        scene.add(g);
        this.list.push({ g, beam, curve, len, u: i / (r.count || 4), v: (r.speed_kmh || 30) / 3.6 });
      }
    }
  }
  update(dt, night) {
    for (const c of this.list) {
      c.u = (c.u + (c.v * dt) / c.len) % 1;
      const p = c.curve.getPointAt(c.u), p2 = c.curve.getPointAt((c.u + 0.001) % 1);
      c.g.position.copy(p);
      c.g.lookAt(p.clone().multiplyScalar(2).sub(p2));
      c.beam.material.opacity = night * 0.8;
    }
  }
}

function makeGlow() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
