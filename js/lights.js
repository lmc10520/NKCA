import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { cm2w, makeMatcher } from './util.js';

// 夜間燈光：玻璃、天窗、露臺輪廓、戶外劇場燈條、廣場天花崁燈、屋頂投射燈、草坪光環
export class NightLights {
  constructor(scene, model, cfg, lawns) {
    this.scene = scene; this.cfg = cfg; this.items = [];
    this.group = new THREE.Group(); this.group.name = 'NightLights';
    scene.add(this.group);
    const c = cfg;

    // 1. 玻璃帷幕：自發光暖黃
    const gm = makeMatcher(c.glass?.match), gx = makeMatcher(c.glass?.exclude);
    const sm = makeMatcher(c.skylights?.match);
    this.glow = [];
    for (const m of model.meshes) {
      const n = m.userData.fname;
      let col = null, k = 0;
      if (sm(n)) { col = c.skylights.color; k = c.skylights.intensity; }
      else if ((m.userData.isGlass || gm(n)) && !gx(n)) { col = c.glass.color; k = c.glass.intensity; }
      if (!col) continue;
      // 每個 mesh 用自己的材質，避免同材質的物件互相影響
      m.material = m.material.clone();
      m.userData.origMaterial = m.material;
      m.material.emissive = new THREE.Color(col);
      this.glow.push({ mat: m.material, k });
    }

    // 2. 露臺輪廓、戶外劇場燈條：用線段 + bloom
    this.lines = [];
    const addEdges = (spec, filter) => {
      if (!spec) return;
      const mm = makeMatcher(spec.match);
      for (const m of model.meshes.filter((x) => mm(x.userData.fname))) {
        const eg = new THREE.EdgesGeometry(m.geometry, spec.thresholdAngle ?? 40);
        const g = filter ? filter(eg, m) : eg;
        const mat = new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: 0, toneMapped: false });
        const ls = new THREE.LineSegments(g, mat);
        ls.matrixAutoUpdate = false;
        m.updateWorldMatrix(true, false);
        ls.matrix.copy(m.matrixWorld);
        ls.userData.owner = m;
        this.group.add(ls); this.lines.push(ls);
      }
    };
    addEdges(c.terraces);
    // 戶外劇場：只留水平、夠長的邊（每階的階鼻與踢面底）
    addEdges({ ...c.theaterSteps, thresholdAngle: 60 }, (eg, m) => {
      const p = eg.attributes.position, keep = [];
      const a = new THREE.Vector3(), b = new THREE.Vector3(), s = m.getWorldScale(new THREE.Vector3());
      const minL = (c.theaterSteps?.minLength_m ?? 1.2);
      for (let i = 0; i < p.count; i += 2) {
        a.fromBufferAttribute(p, i).multiply(s); b.fromBufferAttribute(p, i + 1).multiply(s);
        const d = b.clone().sub(a), L = d.length();
        if (L >= minL && Math.abs(d.y) < 0.02 * L) keep.push(p.getX(i), p.getY(i), p.getZ(i), p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
      return g;
    });

    // 3. 榕樹廣場：天花崁燈點（shader 畫在天花上）+ 一盞大面光打地面
    this.ceilUniform = { value: 0 };
    if (c.plaza) {
      const cm = makeMatcher(c.plaza.ceilingMatch);
      const col = new THREE.Color(c.plaza.color);
      for (const m of model.meshes.filter((x) => cm(x.userData.fname))) {
        m.material = m.material.clone(); m.userData.origMaterial = m.material;
        const u = this.ceilUniform, sp = c.plaza.dotSpacing_m, r = c.plaza.dotRadius_m;
        m.material.onBeforeCompile = (sh) => {
          sh.uniforms.uNight = u;
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWP;uniform float uNight;`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              vec2 cell=fract(vWP.xz/${sp.toFixed(2)})-0.5; float d=length(cell)*${sp.toFixed(2)};
              float dotm=1.0-smoothstep(${(r * 0.6).toFixed(3)},${r.toFixed(3)},d);
              totalEmissiveRadiance+=vec3(${col.r.toFixed(3)},${col.g.toFixed(3)},${col.b.toFixed(3)})*dotm*uNight*6.0;`);
        };
        m.material.needsUpdate = true;
      }
      if (c.plaza.area) {
        RectAreaLightUniformsLib.init();
        const a = c.plaza.area;
        const L = new THREE.RectAreaLight(new THREE.Color(c.plaza.color), 0, a.size_cm[0] / 100, a.size_cm[1] / 100);
        L.position.copy(cm2w(a.center_cm));
        L.lookAt(L.position.clone().add(new THREE.Vector3(0, -1, 0)));
        this.group.add(L);
        this.area = { light: L, k: a.intensity };
      }
    }

    // 4. 屋頂投射燈（有方向性）
    this.spots = [];
    const rs = c.roofSpots;
    for (const it of (rs?.items || []).slice(0, rs.max ?? 12)) {
      const s = new THREE.SpotLight(rs.color, 0, 120, THREE.MathUtils.degToRad(it.angle_deg ?? 25), 0.6, 1.2);
      s.position.copy(cm2w(it.pos_cm)); s.target.position.copy(cm2w(it.aim_cm));
      this.group.add(s, s.target); this.spots.push({ light: s, k: it.intensity ?? 400 });
    }

    // 5. 北側、東側圓形草坪的光環
    this.rings = [];
    if (lawns?.lawns?.length) {
      const mat = new THREE.MeshBasicMaterial({ color: lawns.color, transparent: true, opacity: 0, toneMapped: false });
      for (const l of lawns.lawns) {
        const pts = l.pts.map((p) => cm2w([p[0], p[1], lawns.height_cm ?? 8]));
        const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
        const g = new THREE.TubeGeometry(curve, Math.max(60, pts.length * 3), 0.06, 6, true);
        const mesh = new THREE.Mesh(g, mat);
        this.group.add(mesh); this.rings.push(mesh);
      }
      this.ringMat = mat;
    }
  }

  update(night) {
    for (const g of this.glow) g.mat.emissiveIntensity = night * g.k;
    for (const l of this.lines) { l.material.opacity = night; l.visible = night > 0.02 && l.userData.owner.visible; }
    this.ceilUniform.value = night;
    if (this.area) this.area.light.intensity = night * this.area.k;
    for (const s of this.spots) s.light.intensity = night * s.k;
    if (this.ringMat) { this.ringMat.opacity = night; this.rings.forEach((r) => (r.visible = night > 0.02)); }
  }
}
