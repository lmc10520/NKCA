import * as THREE from 'three';

// ---------- 地平線 ----------
// 基地（Site_* 物件的範圍）外面鋪一片大地坪，從基地邊緣的淺色漸漸變成地平線的霧色，
// 再加一圈跟著鏡頭的「地平線霧帶」（圓筒內側，下緣不透明、往上漸淡），把地面和天空分開，
// 鳥瞰時就看不到四方形的基地邊緣。夜晚地坪在遠處漸漸變透明、霧帶淡出，四周就是延伸到地平線以下的星空。
// 白模／線稿／網點樣式隱藏（背景本來就是白色）。
// 顏色在 site.json 的 horizon：dayNear／dayFar（白天近處／遠處）、nightNear／nightFar（夜晚）。
// 地坪上可以貼 OpenStreetMap 圖磚（site.json 的 map）：圖磚畫進兩張畫布（近處細、遠處粗），
// 由地坪原本的 shader 取樣，不另外增加 shader。對位用 map.anchor（一個模型點的經緯度）＋ northOffset_deg，
// 網址加 ?mapcal 可用鍵盤微調位置、旋轉、比例，再把面板上的數值貼回 site.json。
const VS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vW; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;

export class Horizon {
  constructor(scene, rect, cfg = {}) {
    this.cfg = cfg;
    this.col = {
      dayNear: new THREE.Color(cfg.dayNear || '#eeeeeb'), dayFar: new THREE.Color(cfg.dayFar || '#d9e2e8'),
      nightNear: new THREE.Color(cfg.nightNear || '#5a647b'), nightFar: new THREE.Color(cfg.nightFar || '#2c3854'),
    };
    const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
    const R = cfg.radius_m ?? 6000;
    this.u = {
      uNear: { value: new THREE.Color() }, uFar: { value: new THREE.Color() },
      uC: { value: new THREE.Vector2(cx, cz) }, uR0: { value: cfg.fadeStart_m ?? 250 }, uR1: { value: cfg.fadeEnd_m ?? 2600 },
      uN: { value: 0 }, uA0: { value: cfg.nightFadeStart_m ?? 420 }, uA1: { value: cfg.nightFadeEnd_m ?? 1100 },
      // 地圖：uMap0 近處（細）、uMap1 遠處（粗）；uM*a／uM*b 是網頁座標 (x, z, 1) → 貼圖 uv 的仿射係數
      uMapOn: { value: 0 }, uMap0: { value: null }, uMap1: { value: null },
      uM0a: { value: new THREE.Vector3() }, uM0b: { value: new THREE.Vector3() },
      uM1a: { value: new THREE.Vector3() }, uM1b: { value: new THREE.Vector3() },
      uMF0: { value: 1500 }, uMF1: { value: 4500 }, uSat: { value: 0.55 }, uLight: { value: 0.2 }, uMapNight: { value: 0.75 },
    };
    // 地坪：中間挖掉基地範圍（往內縮 0.3 m，邊緣塞在基地底下），高度略低於基地最低的地面
    const s = new THREE.Shape(); s.absarc(cx, -cz, R, 0, Math.PI * 2, false);
    const h = new THREE.Path(), i = 0.3;
    h.moveTo(rect.x0 + i, -(rect.z0 + i)); h.lineTo(rect.x1 - i, -(rect.z0 + i)); h.lineTo(rect.x1 - i, -(rect.z1 - i)); h.lineTo(rect.x0 + i, -(rect.z1 - i)); h.closePath();
    s.holes.push(h);
    const g = new THREE.ShapeGeometry(s, 96); g.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VS, fog: false, transparent: true,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uNear, uFar; uniform vec2 uC; uniform float uR0, uR1, uN, uA0, uA1; varying vec3 vW;
        uniform float uMapOn, uMF0, uMF1, uSat, uLight, uMapNight;
        uniform sampler2D uMap0, uMap1; uniform vec3 uM0a, uM0b, uM1a, uM1b;
        // 取一張地圖：超出畫布或圖磚還沒載入（透明）時權重為 0，畫布邊緣淡出
        vec4 mapAt(sampler2D tx, vec3 ma, vec3 mb, vec3 p) {
          vec2 uv = vec2(dot(ma, p), dot(mb, p));
          vec2 e = min(uv, 1.0 - uv);
          float w = smoothstep(0.0, 0.03, min(e.x, e.y));
          if (w <= 0.0) return vec4(0.0);
          vec4 c = texture2D(tx, uv);
          return vec4(c.rgb, c.a * w);
        }
        void main() {
          #include <logdepthbuf_fragment>
          float d = distance(vW.xz, uC);
          float t = smoothstep(uR0, uR1, d);
          float a = mix(1.0, 1.0 - smoothstep(uA0, uA1, d), uN);
          if (a < 0.01) discard;
          vec3 col = mix(uNear, uFar, t);
          if (uMapOn > 0.5) {
            vec3 p = vec3(vW.xz, 1.0);
            vec4 m0 = mapAt(uMap0, uM0a, uM0b, p), m1 = mapAt(uMap1, uM1a, uM1b, p);
            float ma = m0.a + m1.a * (1.0 - m0.a);
            if (ma > 0.001) {
              vec3 mc = (m0.rgb * m0.a + m1.rgb * m1.a * (1.0 - m0.a)) / ma;
              float l = dot(mc, vec3(0.2126, 0.7152, 0.0722));
              mc = mix(vec3(l), mc, uSat);                 // 降低彩度
              mc = mix(mc, uNear, uLight);                 // 往地坪顏色提亮，和基地的淺色調接得起來
              mc = mix(mc, uNear * (0.45 + 0.9 * l), uN * uMapNight);   // 夜晚：轉成夜色，只留明暗
              col = mix(col, mc, ma * (1.0 - smoothstep(uMF0, uMF1, d)));
            }
          }
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.ground.position.y = cfg.y_m ?? -0.2;
    this.ground.name = 'HorizonGround'; this.ground.raycast = () => {};
    this.ground.renderOrder = -0.5;   // 透明物件中最先畫（在夜空之後、玻璃之前）
    // 地平線霧帶：半徑 5 km 的圓筒內側，跟著鏡頭水平移動
    const H = 600, below = 60;
    this.skirtR = 5000;
    const sg = new THREE.CylinderGeometry(this.skirtR, this.skirtR, H, 96, 1, true);
    sg.translate(0, H / 2 - below, 0);
    this.skirt = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      uniforms: { uFar: this.u.uFar, uG: { value: below / H }, uN: this.u.uN }, vertexShader: VS,
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uFar; uniform float uG, uN; varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float a = 1.0 - smoothstep(uG, 0.85, vUv.y);
          a *= a * (1.0 - uN);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uFar, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.skirt.name = 'HorizonSkirt'; this.skirt.raycast = () => {}; this.skirt.frustumCulled = false;
    scene.add(this.ground, this.skirt);
  }

  // night：0 白天 → 1 夜晚；plain：白模／線稿／網點（隱藏）
  update(camPos, night, plain) {
    const on = !plain;
    this.ground.visible = this.skirt.visible = on;
    if (this.attrEl) this.attrEl.classList.toggle('hidden', !on);
    if (!on) return;
    const c = this.col;
    this.u.uNear.value.lerpColors(c.dayNear, c.nightNear, night);
    this.u.uFar.value.lerpColors(c.dayFar, c.nightFar, night);
    this.u.uN.value = THREE.MathUtils.smoothstep(night, 0.15, 0.85);
    this.skirt.position.set(camPos.x, 0, camPos.z);
  }

  // ---------- OpenStreetMap 地圖 ----------
  // m：site.json 的 map；northDeg：site.json 的 northOffset_deg；maxAniso：renderer 的最大異向過濾
  setMap(m, northDeg, maxAniso = 8) {
    if (!m || m.enabled === false) return;
    this.map = m; this.northDeg = northDeg;
    const u = this.u;
    u.uMF0.value = m.fadeStart_m ?? 1500; u.uMF1.value = m.fadeEnd_m ?? 4500;
    u.uSat.value = m.saturation ?? 0.55; u.uLight.value = m.lighten ?? 0.2; u.uMapNight.value = m.night ?? 0.75;
    this.cal = { rotate_deg: m.rotate_deg ?? 0, scale: m.scale ?? 1, shift_m: [...(m.shift_m || [0, 0])] };
    const layers = (m.layers || [{ z: 16, tiles: 8 }, { z: 14, tiles: 6 }]).slice(0, 2);
    const a = m.anchor || {};
    this.anchorW = { x: (a.at_cm?.[0] ?? 0) / 100, z: -(a.at_cm?.[1] ?? 0) / 100 };
    this.anchorLL = { lat: a.lat, lon: a.lon };
    // 畫布中心放在地坪中心（基地中心）：先用對位換成經緯度，再找要抓哪些圖磚
    const c = this.u.uC.value, ll = this.worldToLL(c.x, c.y);
    this.layers = layers.map((L, i) => {
      const n = L.tiles, gp = this.llToPx(ll.lat, ll.lon, L.z);
      const tx0 = Math.round(gp.x / 256 - n / 2), ty0 = Math.round(gp.y / 256 - n / 2);
      const cv = document.createElement('canvas'); cv.width = cv.height = n * 256;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = maxAniso;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      u[`uMap${i}`].value = tex;
      return { ...L, n, tx0, ty0, cv, tex, i };
    });
    if (this.layers.length === 1) { u.uMap1.value = this.layers[0].tex; this.layers.push(null); }
    this.updateMapMatrix();
    u.uMapOn.value = 1;
    // 授權標示（OSM 規定要顯示）
    const at = document.createElement('a');
    at.id = 'mapAttrib'; at.className = 'ui'; at.target = '_blank'; at.rel = 'noopener';
    at.href = m.attributionUrl || 'https://www.openstreetmap.org/copyright';
    at.textContent = m.attribution || '© OpenStreetMap 貢獻者';
    (document.getElementById('app') || document.body).appendChild(at);
    this.attrEl = at;
    // 圖磚：近處先抓；同時最多 6 個連線（OSM 圖磚使用規範：不要大量平行下載）
    const jobs = [];
    for (const L of this.layers) if (L) {
      const mid = (L.n - 1) / 2;
      for (let y = 0; y < L.n; y++) for (let x = 0; x < L.n; x++) jobs.push({ L, x, y, k: L.i * 1000 + Math.hypot(x - mid, y - mid) });
    }
    jobs.sort((p, q) => p.k - q.k);
    const url = m.url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const subs = m.subdomains || 'abc';
    let dirty = new Set(), timer = 0;
    const flush = () => { timer = 0; for (const L of dirty) L.tex.needsUpdate = true; dirty = new Set(); };
    const one = (j) => new Promise((res) => {
      const { L, x, y } = j, tx = L.tx0 + x, ty = L.ty0 + y;
      const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = () => {
        L.cv.getContext('2d').drawImage(img, x * 256, y * 256);
        dirty.add(L); if (!timer) timer = setTimeout(flush, 250);
        res();
      };
      img.onerror = () => res();
      img.src = url.replace('{z}', L.z).replace('{x}', tx).replace('{y}', ty)
        .replace('{s}', subs[(tx + ty) % subs.length]).replace('{r}', devicePixelRatio > 1.5 ? '@2x' : '');
    });
    let k = 0;
    const worker = async () => { while (k < jobs.length) await one(jobs[k++]); };
    for (let i = 0; i < 6; i++) worker();
    if (new URLSearchParams(location.search).has('mapcal')) this.calibrate();
  }

  // 網頁座標（m）→ 東、北（m，相對對位點）
  worldToEN(x, z) {
    const A = THREE.MathUtils.degToRad(this.northDeg + this.cal.rotate_deg), s = this.cal.scale;
    const dx = x - this.anchorW.x, dz = z - this.anchorW.z;
    return { e: (dx * Math.cos(A) + dz * Math.sin(A)) * s - this.cal.shift_m[0], n: (dx * Math.sin(A) - dz * Math.cos(A)) * s - this.cal.shift_m[1] };
  }
  worldToLL(x, z) {
    const { e, n } = this.worldToEN(x, z), R = 6378137, la = this.anchorLL.lat;
    return { lat: la + THREE.MathUtils.radToDeg(n / R), lon: this.anchorLL.lon + THREE.MathUtils.radToDeg(e / (R * Math.cos(THREE.MathUtils.degToRad(la)))) };
  }
  // 經緯度 → Web Mercator 全球像素（圖磚 256 px）
  llToPx(lat, lon, z) {
    const W = 256 * 2 ** z, f = THREE.MathUtils.degToRad(lat);
    return { x: (lon + 180) / 360 * W, y: (1 - Math.log(Math.tan(f) + 1 / Math.cos(f)) / Math.PI) / 2 * W };
  }
  // 小範圍內 Web Mercator 視為等比例：像素 = 對位點像素 + k ×（東, −北），k = 每公尺幾像素
  updateMapMatrix() {
    const A = THREE.MathUtils.degToRad(this.northDeg + this.cal.rotate_deg), s = this.cal.scale;
    const c = Math.cos(A), sn = Math.sin(A), { x: ax, z: az } = this.anchorW, [sE, sN] = this.cal.shift_m;
    const R = 6378137, cosf = Math.cos(THREE.MathUtils.degToRad(this.anchorLL.lat));
    for (const L of this.layers) if (L) {
      const S = L.n * 256, k = 256 * 2 ** L.z / (2 * Math.PI * R * cosf);
      const P = this.llToPx(this.anchorLL.lat, this.anchorLL.lon, L.z);
      const ox = P.x - L.tx0 * 256 - k * sE, oy = P.y - L.ty0 * 256 + k * sN, ks = k * s;
      // px = ox + ks·(dx·c + dz·sn)；py = oy − ks·(dx·sn − dz·c)
      this.u[`uM${L.i}a`].value.set(ks * c / S, ks * sn / S, (ox - ks * (ax * c + az * sn)) / S);
      this.u[`uM${L.i}b`].value.set(-ks * sn / S, ks * c / S, (oy + ks * (ax * sn - az * c)) / S);
    }
    if (!this.layers[1]) { this.u.uM1a.value.copy(this.u.uM0a.value); this.u.uM1b.value.copy(this.u.uM0b.value); }
  }

  // ?mapcal：鍵盤微調地圖對位（方向鍵移動 1 m、加 Shift 10 m；Q／E 旋轉 0.1°；－／＝ 比例 0.1%）
  calibrate() {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:50;background:rgba(32,33,36,.88);color:#fff;font:12px/1.5 monospace;padding:8px 12px;border-radius:10px;white-space:pre;user-select:text';
    document.body.appendChild(box);
    const show = () => {
      const c = this.cal;
      box.textContent = '地圖對位：方向鍵移動（Shift×10）、Q／E 旋轉、－／＝ 比例\n貼回 site.json 的 map：\n' +
        `"rotate_deg": ${+c.rotate_deg.toFixed(2)}, "scale": ${+c.scale.toFixed(4)}, "shift_m": [${+c.shift_m[0].toFixed(1)}, ${+c.shift_m[1].toFixed(1)}]`;
    };
    // 方向鍵以畫面方向為準不容易，這裡用真北：↑ 地圖往北移、→ 往東移
    addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 10 : 1, c = this.cal;
      const k = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }[e.key];
      if (k) { c.shift_m[0] += k[0] * st; c.shift_m[1] += k[1] * st; }
      else if (e.key === 'q' || e.key === 'Q') c.rotate_deg += 0.1 * st;
      else if (e.key === 'e' || e.key === 'E') c.rotate_deg -= 0.1 * st;
      else if (e.key === '=' || e.key === '+') c.scale *= 1 + 0.001 * st;
      else if (e.key === '-' || e.key === '_') c.scale /= 1 + 0.001 * st;
      else return;
      e.preventDefault(); e.stopPropagation();
      this.updateMapMatrix(); show();
    }, true);
    show();
  }
}

// 從模型的 Site_* 物件算出基地範圍（網頁座標 m）
export function siteRect(model, re = /^Site_(Road_Base|City_Blocks|Sidewalk|Grass|Campus_Paving)/) {
  const box = new THREE.Box3(), b = new THREE.Box3();
  for (const m of model.meshes) if (re.test(m.userData.fname)) box.union(b.setFromObject(m));
  if (box.isEmpty()) return null;
  return { x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z };
}
