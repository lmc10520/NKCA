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
    // 崁燈顏色與天花洗牆色（節慶特殊色：setPlazaColor）用 uniform，換色不必重新編譯 shader
    this.plazaCol = { value: new THREE.Color(c.plaza?.color || '#fff6ea') };
    this.plazaWash = { value: new THREE.Color(0, 0, 0) };
    // 出挑底面（soffit）平常的暖白光；節慶時 setPlazaColor 換色
    const so = c.soffit || {};
    this.soffitBase = new THREE.Color(so.color || '#fff1dc').multiplyScalar(so.intensity ?? 0);
    this.soffitCol = { value: this.soffitBase.clone() };
    this.soffitY = { value: new THREE.Vector3(so.low_m ?? 5, so.high_m ?? 14, so.topRatio ?? 0.3) };
    // 立面邊緣帶由下往上的洗牆光
    const fu = c.facadeUplight || {};
    this.facadeBase = new THREE.Color(fu.color || '#fff1dc');
    this.facadeCol = { value: this.facadeBase.clone() };
    this.facadeMix = fu.mix ?? 0.55;
    if (c.plaza) {
      const cm = makeMatcher(c.plaza.ceilingMatch);
      for (const m of model.meshes.filter((x) => cm(x.userData.fname))) {
        m.material = m.material.clone(); m.userData.origMaterial = m.material;
        const u = this.ceilUniform, sp = c.plaza.dotSpacing_m, r = c.plaza.dotRadius_m;
        // 光點只畫在朝下的面；朝上的頂面（樹冠大廳沒有 3F 樓板處往下看得到）夜間改成深色非開放區，
        // 否則從上面看會像樓板破洞透出下方燈光
        const top = new THREE.Color(c.plaza.topNightColor || '#2a2a2a');
        m.material.onBeforeCompile = (sh) => {
          sh.uniforms.uNight = u; sh.uniforms.uPlazaCol = this.plazaCol; sh.uniforms.uPlazaWash = this.plazaWash;
          sh.uniforms.uSoffit = this.soffitCol; sh.uniforms.uSoffitY = this.soffitY;
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;varying vec3 vCWN;')
            .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvCWN=mat3(modelMatrix)*objectNormal;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWP;varying vec3 vCWN;uniform float uNight;uniform vec3 uPlazaCol;uniform vec3 uPlazaWash;uniform vec3 uSoffit;uniform vec3 uSoffitY;`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              float ny=normalize(vCWN).y;
              vec2 cell=fract(vWP.xz/${sp.toFixed(2)})-0.5; float d=length(cell)*${sp.toFixed(2)};
              float dotm=(1.0-smoothstep(${(r * 0.6).toFixed(3)},${r.toFixed(3)},d))*(1.0-smoothstep(-0.6,-0.3,ny));
              float down=1.0-smoothstep(-0.6,-0.3,ny);
              float edgeF=mix(1.0,uSoffitY.z,smoothstep(uSoffitY.x,uSoffitY.y,vWP.y));   // 越低（越靠出挑邊緣）越亮
              totalEmissiveRadiance+=uPlazaCol*dotm*uNight*6.0+(uSoffit*edgeF+uPlazaWash)*down*uNight;`)
            .replace('#include <opaque_fragment>', `outgoingLight=mix(outgoingLight,vec3(${top.r.toFixed(3)},${top.g.toFixed(3)},${top.b.toFixed(3)}),smoothstep(0.3,0.6,ny)*uNight);
              #include <opaque_fragment>`);
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
        this.area = { light: L, k: a.intensity, k0: a.intensity, col0: new THREE.Color(c.plaza.color) };
      }
    }

    // 3a. 其他出挑底面（soffit.match）與立面邊緣帶（facadeUplight.match）：每個物件複製自己的材質，
    // 底面：朝下的面整片打亮（越低越亮）；立面：側面從物件底部往上 height_m 漸暗。顏色用 uniform，節慶換色不必重新編譯
    {
      const sm = makeMatcher(c.soffit?.match), fm = makeMatcher(c.facadeUplight?.match);
      const fk = c.facadeUplight?.intensity ?? 0, fh = c.facadeUplight?.height_m ?? 9;
      const box = new THREE.Box3();
      for (const m of model.meshes) {
        // 同一個物件可以兩種都有（例如屋頂：底面打亮、邊緣側面往上洗牆，頂面不受影響）
        const n = m.userData.fname, isS = sm(n), isF = fm(n) && fk > 0;
        if (!isS && !isF || m.userData.isGlass) continue;
        const y0 = box.setFromObject(m).min.y;
        const mat = m.material.clone(); m.material = mat; m.userData.origMaterial = mat;
        const uY = { value: new THREE.Vector3(y0, y0 + fh, isF ? fk : 0) }, uS = { value: isS ? 1 : 0 };
        mat.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, { uNight: this.ceilUniform, uSoffit: this.soffitCol, uSoffitY: this.soffitY, uPlazaWash: this.plazaWash, uFacade: this.facadeCol, uFY: uY, uSK: uS });
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;varying vec3 vCWN;')
            .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvCWN=mat3(modelMatrix)*objectNormal;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;varying vec3 vCWN;uniform float uNight;uniform vec3 uSoffit;uniform vec3 uSoffitY;uniform vec3 uPlazaWash;uniform vec3 uFacade;uniform vec3 uFY;uniform float uSK;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              float ny=normalize(vCWN).y, down=1.0-smoothstep(-0.6,-0.3,ny), side=1.0-smoothstep(0.35,0.6,abs(ny));
              float edgeF=mix(1.0,uSoffitY.z,smoothstep(uSoffitY.x,uSoffitY.y,vWP.y));
              float g=1.0-smoothstep(uFY.x,uFY.y,vWP.y);
              totalEmissiveRadiance+=(uSoffit*edgeF+uPlazaWash)*down*uNight*uSK+uFacade*diffuseColor.rgb*(g*g*side*uNight*uFY.z);`);
        };
        mat.customProgramCacheKey = () => 'soffitFacade';
        mat.needsUpdate = true;
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
            sh.uniforms.uNight = u; sh.uniforms.uPlazaCol = this.plazaCol; sh.uniforms.uPlazaWash = this.plazaWash;
          sh.uniforms.uSoffit = this.soffitCol; sh.uniforms.uSoffitY = this.soffitY;
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
      // intensity 大於 1：顏色超過白色，夜間會被 bloom 暈開成發光的燈帶
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(lawns.color).multiplyScalar(lawns.intensity ?? 1), transparent: true, opacity: 0, toneMapped: false });
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
        const g = new THREE.TubeGeometry(curve, n * 2, (lawns.radius_cm ?? 6) / 100, 6, true);
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
    if (on !== this.lightsOn) this.setLightsOn(on);
    if (this.area) this.area.light.intensity = venue * this.area.k;
    // 屋頂隱藏（樹冠大廳、榕樹廣場模式）時投射燈一起關掉，不然光會照進室內。
    // 只把亮度調成 0、不改 visible：燈的數量一變，所有 shader 都要重新編譯，切換模式時畫面會凍住
    const roofK = this.roofOn !== false ? venue : 0;
    for (const s of this.spots) s.light.intensity = roofK * s.k;
    if (this.ringMat) { this.ringMat.opacity = venue; this.rings.forEach((r) => (r.visible = venue > 0.02)); }
  }

  // 榕樹廣場節慶特殊色（festivals.json 的 plazaLight）：崁燈、天花洗牆、地面頂光換成指定顏色；spec＝null 恢復平常的暖白
  // spec：{ color: '#7b3cff', intensity: 1（整體強度倍數）, wash: 0.2（天花整片染色的程度） }
  setPlazaColor(spec) {
    const base = new THREE.Color(this.cfg.plaza?.color || '#fff6ea');
    const col = spec?.color ? new THREE.Color(spec.color) : base, k = spec?.intensity ?? 1;
    this.plazaCol.value.copy(col);
    this.plazaWash.value.copy(spec?.color ? col : new THREE.Color(0, 0, 0)).multiplyScalar(spec?.color ? (spec.wash ?? 0.2) * k : 0);
    // 地面頂光：七成指定色＋三成白光（白色地坪、牆面看起來是淡淡的染色，像實際打燈的照片）
    // 出挑底面：特殊色時換成指定色（亮度同平常）；立面洗牆混入一部分特殊色
    const so = this.cfg.soffit || {}, sk = (so.intensity ?? 0) * k;
    this.soffitCol.value.copy(spec?.color ? col.clone().multiplyScalar(sk * 1.6) : this.soffitBase);
    this.facadeCol.value.copy(spec?.color ? this.facadeBase.clone().lerp(col, this.facadeMix) : this.facadeBase);
    if (this.area) { this.area.light.color.copy(spec?.color ? col.clone().lerp(new THREE.Color(1, 1, 1), 0.3) : this.area.col0); this.area.k = this.area.k0 * (spec?.color ? 1.25 * k : 1); }
  }

  // 夜間真實光源（廣場面光源、屋頂投射燈）開或關，回傳原本的狀態。只在日夜交替時切換；
  // 兩種狀態的 shader 在載入時預先編譯（main.js 的 precompile），切換時直接取用、不會卡住
  setLightsOn(on) {
    const prev = this.lightsOn !== false;
    this.lightsOn = !!on;
    if (this.area) this.area.light.visible = !!on;
    for (const s of this.spots) s.light.visible = !!on;
    return prev;
  }
}
