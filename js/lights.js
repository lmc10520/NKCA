import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { cm2w, makeMatcher, isMobile } from './util.js';

// 夜間燈光：玻璃、天窗、露臺輪廓、戶外劇場燈條、廣場天花崁燈、屋頂投射燈、草坪光環
function radial() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cv);
}

// 先替要打射線的物件建 BVH（加速結構），否則上千條射線逐一比對三角形會讓載入多花好幾秒
const bvh = (list) => { for (const m of list) if (!m.geometry.boundsTree) m.geometry.computeBoundsTree?.(); };

export class NightLights {
  // opts.spots／opts.area：設為 false 可關掉真的光源（每個像素都要計算），只留自發光
  constructor(scene, model, cfg, lawns, opts = {}) {
    this.scene = scene; this.cfg = cfg; this.items = [];
    model.root.updateMatrixWorld(true);
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
      const mk = (c.markings || []).find((x) => new RegExp(x.match).test(n));
      if (mk) { col = mk.color; k = mk.intensity; }
      else if (sm(n)) { col = c.skylights.color; k = c.skylights.intensity; }
      else if ((m.userData.isGlass || gm(n)) && !gx(n)) { col = c.glass.color; k = c.glass.intensity; }
      if (!col) continue;
      // 每個 mesh 用自己的材質，避免同材質的物件互相影響
      m.material = m.material.clone();
      m.userData.origMaterial = m.material;
      m.material.emissive = new THREE.Color(col);
      this.glow.push({ mat: m.material, k, city: !!mk });
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
        mat.userData.k = spec.intensity ?? 1;
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
      if (c.plaza.area && opts.area !== false) {
        RectAreaLightUniformsLib.init();
        const a = c.plaza.area;
        const L = new THREE.RectAreaLight(new THREE.Color(c.plaza.color), 0, a.size_cm[0] / 100, a.size_cm[1] / 100);
        L.position.copy(cm2w(a.center_cm));
        L.lookAt(L.position.clone().add(new THREE.Vector3(0, -1, 0)));
        this.group.add(L);
        this.area = { light: L, k: a.intensity };
      }
    }

    // 3b. 樹冠大廳、廳院內的地板：整片均勻的暖光（只處理朝上的面，不建光源、不畫光點）。
    // 做法是把地板亮度「墊高」到 底色 × 燈色 × intensity：本來就夠亮的白色座位不會再加亮（不會被 bloom 打成一片白），
    // 暗灰地板則整片提亮。依物件名稱＋材質自動判斷，Fusion 重新匯出只要命名不變就會套用
    if (c.floors?.rules?.length) {
      const rules = c.floors.rules.map((r) => ({ name: makeMatcher(r.match), mat: r.material ? new RegExp(r.material) : null }));
      const col = new THREE.Color(c.floors.color), u = this.ceilUniform, k = c.floors.intensity ?? 0.6;
      const frag = `float upF=smoothstep(0.55,0.85,normalize(vFWN).y);
        outgoingLight=max(outgoingLight,diffuseColor.rgb*vec3(${col.r.toFixed(3)},${col.g.toFixed(3)},${col.b.toFixed(3)})*(upF*uNight*${k.toFixed(3)}));`;
      const clones = new Map();   // 同一個原材質只複製一次，地板共用同一個 shader
      for (const m of model.meshes) {
        const n = m.userData.fname, mn = m.material?.name || '';
        if (m.userData.isGlass || !rules.some((r) => r.name(n) && (!r.mat || r.mat.test(mn)))) continue;
        let mat = clones.get(m.material);
        if (!mat) {
          // 先保留原材質的 shader 修改（廳院裝修紋理，js/finishes.js），再加照明
          const prev = m.material.onBeforeCompile, prevKey = m.material.customProgramCacheKey?.() || '';
          mat = m.material.clone();
          mat.onBeforeCompile = (sh, r) => {
            prev?.call(mat, sh, r);
            sh.uniforms.uNight = u;
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFWN;')
              .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvFWN=mat3(modelMatrix)*objectNormal;');
            sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFWN;uniform float uNight;')
              .replace('#include <opaque_fragment>', frag + '\n#include <opaque_fragment>');
          };
          mat.customProgramCacheKey = () => prevKey + 'floorGlow';
          clones.set(m.material, mat);
        }
        m.material = mat; m.userData.origMaterial = mat;
      }
      this.floorMats = clones.size;
    }

    // 4. 屋頂投射燈（有方向性）：貼在屋面上，低角度掠過屋頂凸顯起伏
    this.spots = [];
    const rs = c.roofSpots;
    if (rs?.items?.length && opts.spots !== false) {
      const roofM = model.meshes.filter((m) => /^Roof_|^Seam_Roof/.test(m.userData.fname));
      bvh(roofM);
      const ray = new THREE.Raycaster();
      const surf = (x, z) => {
        ray.set(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0));
        const h = ray.intersectObjects(roofM, false)[0];
        return h ? h.point.y : 15;
      };
      let list = rs.items;
      const max = isMobile ? Math.ceil((rs.max ?? 12) / 2) : (rs.max ?? 12);
      if (list.length > max) { const st = list.length / max; list = Array.from({ length: max }, (_, i) => list[Math.floor(i * st)]); }
      for (const it of list) {
        const p = cm2w([it.pos_cm[0], it.pos_cm[1], 0]);
        p.y = it.pos_cm[2] != null ? it.pos_cm[2] / 100 : surf(p.x, p.z) + 0.6;
        const a = THREE.MathUtils.degToRad(it.dir_deg ?? 0), reach = (it.reach_cm ?? 4500) / 100;
        const t = new THREE.Vector3(p.x + Math.cos(a) * reach, 0, p.z - Math.sin(a) * reach);
        t.y = surf(t.x, t.z);
        const s = new THREE.SpotLight(rs.color, 0, reach * 1.6, THREE.MathUtils.degToRad(it.angle_deg ?? 22), 0.55, 1.1);
        s.position.copy(p); s.target.position.copy(t);
        this.group.add(s, s.target); this.spots.push({ light: s, k: rs.intensity ?? 900 });
      }
    }

    // 5. 北側、東側圓形草坪的光環
    this.rings = [];
    if (lawns?.lawns?.length) {
      const mat = new THREE.MeshBasicMaterial({ color: lawns.color, transparent: true, opacity: 0, toneMapped: false });
      // 光環貼著地面走：每隔約 0.8 m 往下打射線找地面（草坪、鋪面、土丘），再往上抬 height_cm
      const groundM = model.meshes.filter((m) => /^Site_(Grass|Campus_Paving|Park_Paving|North_Mound|Sidewalk)/.test(m.userData.fname));
      bvh(groundM);
      const ray = new THREE.Raycaster(), up = (lawns.height_cm ?? 8) / 100;
      const down = new THREE.Vector3(0, -1, 0);
      for (const l of lawns.lawns) {
        const base = new THREE.CatmullRomCurve3(l.pts.map((p) => cm2w([p[0], p[1], 0])), true, 'centripetal');
        const n = Math.max(48, Math.round(base.getLength() / 0.8));
        const pts = base.getSpacedPoints(n).slice(0, n).map((p) => {
          ray.set(new THREE.Vector3(p.x, 60, p.z), down);
          const h = ray.intersectObjects(groundM, false)[0];
          return p.setY((h ? h.point.y : 0) + up);
        });
        const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
        const g = new THREE.TubeGeometry(curve, n * 2, 0.06, 6, true);
        const mesh = new THREE.Mesh(g, mat);
        this.group.add(mesh); this.rings.push(mesh);
      }
      this.ringMat = mat;
    }
  }

  // 路燈：模型沒有畫，這裡用 InstancedMesh 補簡單燈桿＋燈頭＋地面光暈（不是真的光源，效能負擔小）
  addStreetLights(cfg) {
    if (!cfg?.enabled || !cfg.lamps?.length) return;
    const n = cfg.lamps.length, H = cfg.height_m ?? 8, R = cfg.pool_radius_m ?? 7;
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, H, 6).translate(0, H / 2, 0),
      new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.6, metalness: 0.4 }), n);
    const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.08, 0.08).translate(0.8, H, 0),
      pole.material, n);
    const headMat = new THREE.MeshBasicMaterial({ color: cfg.color, toneMapped: false });
    const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.12, 0.28).translate(1.45, H - 0.08, 0), headMat, n);
    const poolMat = new THREE.MeshBasicMaterial({ map: radial(), color: cfg.color, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(2 * R, 2 * R).rotateX(-Math.PI / 2).translate(1.4, 0.06, 0), poolMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    cfg.lamps.forEach((l, i) => {
      // 燈頭朝向角度：0 = 東（+x），90 = 北（-z）
      q.setFromAxisAngle(up, THREE.MathUtils.degToRad(l[3] ?? 0));
      m.compose(cm2w([l[0], l[1], l[2] ?? 0]), q, one);
      for (const im of [pole, arm, head, pool]) im.setMatrixAt(i, m);
    });
    pole.castShadow = arm.castShadow = true;
    this.group.add(pole, arm, head, pool);
    this.street = { headMat, poolMat, base: new THREE.Color(cfg.color), pool };
  }

  // night：天色（0 白天 → 1 夜晚）；venue：建築燈光（night × 營運時間，熄燈後為 0）
  update(night, venue = night) {
    if (this.street) {
      this.street.headMat.color.copy(this.street.base).multiplyScalar(0.25 + night * 2.2);
      this.street.poolMat.opacity = night * 0.32; this.street.pool.visible = night > 0.02;
    }
    for (const g of this.glow) g.mat.emissiveIntensity = (g.city ? night : venue) * g.k;
    for (const l of this.lines) { l.material.opacity = venue * l.material.userData.k; l.visible = venue > 0.02 && l.userData.owner.visible; }
    this.ceilUniform.value = venue;
    // 白天把燈關掉（visible=false），燈不進 shader，白天效能不受影響
    const on = venue > 0.05;
    if (this.area) { this.area.light.visible = on; this.area.light.intensity = venue * this.area.k; }
    // 屋頂隱藏（樹冠大廳、榕樹廣場模式）時投射燈一起關掉，不然光會照進室內
    for (const s of this.spots) { s.light.visible = on && this.roofOn !== false; s.light.intensity = venue * s.k; }
    if (this.ringMat) { this.ringMat.opacity = venue; this.rings.forEach((r) => (r.visible = venue > 0.02)); }
  }
}
