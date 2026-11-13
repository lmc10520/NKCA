import * as THREE from 'three';

// 周邊地景：基地外的建築量體（灰白半透明）與樹（多邊形擬合的低面數樹）。
// 資料由 tools/context_to_data.py 產生（Overture Maps 建築＋ESA WorldCover 衛星樹冠覆蓋），座標已對齊 OSM 地圖：
//   model/context_buildings.bin：'NKCB'、數量，每棟 [高度 dm（uint16）、點數（uint16）、點 (x, z) × 0.25 m（int16）]
//   model/context_trees.bin：'NKCT'、數量，每棵 [x, z × 0.25 m（int16）、樹冠半徑 × 0.05 m（uint8）、顏色（uint8）]
// 第一次開啟時才下載（手機預設關閉，不浪費流量）。
// 基地（模型）內的樹另外放在 model/context_site_trees.bin（tools/site_trees.py，'NKCS'，多一個高度 cm（int16）），
// 長在草地、土丘與人行道上，數量少，不受「周邊地景」開關影響，一開始就載入。
const Q = 0.25;

export class Context {
  constructor(scene, cfg = {}) {
    this.cfg = cfg;
    this.group = new THREE.Group(); this.group.name = 'Context'; this.group.visible = false;
    scene.add(this.group);
    this.on = false; this.loading = null;
    this.onMaterials = null;   // (材質[]) => void：載入後交給主程式，套用晝夜的環境反射與夜間降彩度
  }
  // 基地內的樹：一直顯示
  async loadSite(scene) {
    try {
      const r = await fetch('model/context_site_trees.bin'); if (!r.ok) return;
      const objs = this.trees(new DataView(await r.arrayBuffer()), true);
      const g = new THREE.Group(); g.name = 'SiteTrees'; g.add(...objs); scene.add(g);
      this.onMaterials?.(objs.map((o) => o.material));
    } catch (e) { console.warn('[context] 讀不到基地內的樹', e); }
  }
  // 自發光只在白天（量體偏亮白）；晚上關掉，不然整片建築會發亮
  update(night) {
    if (!this.bMat) return;
    this.bMat.emissiveIntensity = this.glow * Math.max(0, 1 - night * 1.5);
  }
  setOn(v) {
    this.on = v;
    if (v && !this.loading) this.loading = this.load().catch((e) => console.warn('[context] 讀不到周邊地景', e));
    this.group.visible = v;
  }
  async load() {
    const [b, t] = await Promise.all(['model/context_buildings.bin', 'model/context_trees.bin'].map(async (u) => {
      const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return new DataView(await r.arrayBuffer());
    }));
    const objs = [this.buildings(b), ...this.trees(t)];
    this.group.add(...objs);
    this.onMaterials?.(objs.map((o) => o.material));
  }

  // 建築：外牆＋平屋頂合成一個網格；牆面朝外、屋頂朝上（半透明時只看到外側）
  buildings(dv) {
    const n = dv.getUint32(4, true), pos = [];
    const tri = (a, b, c, out) => {
      // 依期望的朝向（out）決定頂點順序
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.dot(out) < 0) [b, c] = [c, b];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    const up = new THREE.Vector3(0, 1, 0);
    let o = 8;
    for (let i = 0; i < n; i++) {
      const h = dv.getUint16(o, true) / 10, k = dv.getUint16(o + 2, true); o += 4;
      const P = [];
      for (let j = 0; j < k; j++, o += 4) P.push(new THREE.Vector2(dv.getInt16(o, true) * Q, dv.getInt16(o + 2, true) * Q));
      const cx = P.reduce((s, p) => s + p.x, 0) / k, cz = P.reduce((s, p) => s + p.y, 0) / k;
      for (let j = 0; j < k; j++) {
        const p = P[j], q = P[(j + 1) % k];
        const a = new THREE.Vector3(p.x, 0, p.y), b = new THREE.Vector3(q.x, 0, q.y);
        const a2 = a.clone().setY(h), b2 = b.clone().setY(h);
        const out = new THREE.Vector3((p.x + q.x) / 2 - cx, 0, (p.y + q.y) / 2 - cz);
        // 邊的法線（垂直於邊、朝離中心的方向），凹多邊形時比「指向中心」準
        const en = new THREE.Vector3(q.y - p.y, 0, -(q.x - p.x)); if (en.dot(out) < 0) en.negate();
        tri(a, b, b2, en); tri(a, b2, a2, en);
      }
      for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(P, [])) {
        tri(new THREE.Vector3(P[i0].x, h, P[i0].y), new THREE.Vector3(P[i1].x, h, P[i1].y), new THREE.Vector3(P[i2].x, h, P[i2].y), up);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const c = this.cfg.buildings || {};
    const mat = new THREE.MeshStandardMaterial({
      color: c.color || '#f6efec', roughness: 0.95, metalness: 0,
      transparent: true, opacity: c.opacity ?? 0.82, emissive: c.color || '#f6efec', emissiveIntensity: c.glow ?? 0.12,
    });
    this.bMat = mat; this.glow = c.glow ?? 0.12;
    const m = new THREE.Mesh(g, mat);
    m.name = 'Context_Buildings'; m.castShadow = true; m.renderOrder = 1;
    return m;
  }

  // 樹：低面數樹冠（二十面體）＋樹幹，InstancedMesh 一次畫完；顏色幾種柔和的綠
  trees(dv, withY = false) {
    const n = dv.getUint32(4, true), c = this.cfg.trees || {};
    const greens = (c.colors || ['#9fd3a0', '#b6dca2', '#8cc7a0', '#c4e0a8']).map((x) => new THREE.Color(x));
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), n);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 1, 5).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: c.trunk || '#b39b8e', roughness: 0.9 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    let o = 8;
    const step = withY ? 8 : 6;
    for (let i = 0; i < n; i++, o += step) {
      const x = dv.getInt16(o, true) * Q, z = dv.getInt16(o + 2, true) * Q, y = withY ? dv.getInt16(o + 4, true) / 100 : 0;
      const r = dv.getUint8(o + step - 2) / 20, v = dv.getUint8(o + step - 1);
      const th = r * 0.9;                                    // 樹幹高度
      q.setFromEuler(e.set(0, (i * 2.399) % (Math.PI * 2), 0));
      crown.setMatrixAt(i, m.compose(p.set(x, y + th + r * 0.75, z), q, s.set(r, r * 0.9, r)));
      crown.setColorAt(i, greens[v % greens.length]);
      trunk.setMatrixAt(i, m.compose(p.set(x, y - 0.1, z), q, s.set(r / 3, th + r * 0.3 + 0.1, r / 3)));
    }
    for (const im of [crown, trunk]) { im.castShadow = true; im.instanceMatrix.needsUpdate = true; }
    crown.name = 'Context_Trees'; trunk.name = 'Context_Trunks';
    return [crown, trunk];
  }
}
