import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { smooth } from './util.js';

// 太陽位置（NOAA 簡化公式）。回傳仰角與方位角（弧度，方位角由北順時針）
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * rad;
  const H = lst - ra;
  const phi = lat * rad;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { alt, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

const WMO = {
  0: '晴', 1: '大致晴朗', 2: '多雲', 3: '陰', 45: '霧', 48: '霧', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  61: '小雨', 63: '雨', 65: '大雨', 80: '陣雨', 81: '陣雨', 82: '強陣雨', 95: '雷雨', 96: '雷雨', 99: '雷雨',
};

export class Environment {
  constructor(scene, renderer, site) {
    this.scene = scene; this.renderer = renderer; this.site = site;
    this.lat = site.lat ?? 22.6236; this.lon = site.lon ?? 120.3407;
    this.override = null;          // 手動時間（分鐘，0–1439）；null = 即時
    this.weatherOn = true; this.weather = null;
    this.night = 0;

    this.sky = new Sky();
    this.sky.scale.setScalar(4500);
    scene.add(this.sky);
    this.sunDir = new THREE.Vector3();

    // 夜空：藍調時刻的漸層天幕＋星星，取代全黑背景（周邊街區是工地，不模擬城市燈光）
    const nightCfg = site.night || {};
    // 月光方向（固定在東南方高空，畫面最好看）；方位角由北順時針（北 = -Z、東 = +X）
    this.moonDir = new THREE.Vector3();
    { const a = THREE.MathUtils.degToRad(nightCfg.moonAz_deg ?? 145), e = THREE.MathUtils.degToRad(nightCfg.moonAlt_deg ?? 52);
      this.moonDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); }
    this.moonI = nightCfg.moonlight ?? 1.1;
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: { uOp: { value: 0 }, uTop: { value: new THREE.Color(nightCfg.zenith || '#0b1834') },
        uMid: { value: new THREE.Color(nightCfg.sky || '#1e3260') }, uHor: { value: new THREE.Color(nightCfg.horizon || '#4a5d86') } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vD; uniform float uOp; uniform vec3 uTop, uMid, uHor;
        void main(){ float h = clamp(vD.y, -0.2, 1.0);
          vec3 c = h < 0.12 ? mix(uHor, uMid, smoothstep(-0.05, 0.12, h)) : mix(uMid, uTop, smoothstep(0.12, 0.75, h));
          gl_FragColor = vec4(c, uOp); }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), this.domeMat);
    this.dome.renderOrder = -1; this.dome.frustumCulled = false;
    const sp = [], N = 1800;
    for (let i = 0; i < N; i++) {
      const y = 0.08 + Math.random() * 0.92, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      sp.push(Math.cos(t) * r * 3900, y * 3900, Math.sin(t) * r * 3900);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.stars = new THREE.Points(sg, this.starMat); this.stars.frustumCulled = false;
    scene.add(this.dome, this.stars);

    this.hemi = new THREE.HemisphereLight(0xdfe9f2, 0x4a4438, 0.9);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 3);
    this.sun.castShadow = !!site.shadows;
    const s = this.sun.shadow;
    s.mapSize.set(4096, 4096);
    Object.assign(s.camera, { left: -180, right: 180, top: 180, bottom: -180, near: 10, far: 900 });
    s.bias = -0.0005; s.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
    this.center = new THREE.Vector3(...(site.centerWorld || [137, 0, -153]));
    this.sun.target.position.copy(this.center);

    this.fog = new THREE.FogExp2(0xbfc8cf, 0.0);
    scene.fog = this.fog;
    this.rain = null;
    this.fetchWeather();
    setInterval(() => this.fetchWeather(), 15 * 60 * 1000);
  }

  now() {
    const d = new Date();
    if (this.override == null) return d;
    // 以台北時間設定指定的時:分
    const tp = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const off = d.getTime() - tp.getTime();
    tp.setHours(Math.floor(this.override / 60), this.override % 60, 0, 0);
    return new Date(tp.getTime() + off);
  }

  async fetchWeather() {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}` +
        '&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m&timezone=Asia%2FTaipei';
      const j = await (await fetch(u)).json();
      this.weather = j.current;
    } catch (e) { this.weather = null; }
  }

  weatherText() {
    if (this.wxOverride) return '預覽：' + { clear: '晴', cloudy: '陰', rain: '雨', snow: '雪', storm: '颱風', aurora: '極光' }[this.wxOverride];
    const w = this.weather;
    if (!w) return '';
    return `${WMO[w.weather_code] ?? ''} ${Math.round(w.temperature_2m)}°C`;
  }

  update(dt) {
    const { alt, az } = sunPosition(this.now(), this.lat, this.lon);
    // 網頁座標：北 = -Z、東 = +X
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    this.sunDir.copy(dir);
    const night = smooth(0.10, -0.10, alt);      // 太陽仰角 +6° → -6° 由日轉夜
    this.night = night;
    // 天氣：即時（open-meteo）或預覽（設定中的 晴／陰／雨／雪／颱風／極光）
    const W = this.wxOverride, w = this.weather;
    let cloud = this.weatherOn && w ? w.cloud_cover / 100 : 0.1;
    let rainy = this.weatherOn && w && w.precipitation > 0;
    let snowy = false, aurora = false;
    // 即時：雷雨（WMO 95–99）有閃電；強風（> 50 km/h）雨絲斜飄
    let storm = this.weatherOn && w && w.weather_code >= 95 ? 1 : 0;
    let wind = this.weatherOn && w ? Math.min(1, Math.max(0, (w.wind_speed_10m - 30) / 50)) : 0;
    if (W) {
      cloud = { clear: 0.05, cloudy: 0.9, rain: 1, snow: 0.95, storm: 1, aurora: 0.02 }[W];
      rainy = W === 'rain' || W === 'storm'; snowy = W === 'snow'; aurora = W === 'aurora';
      storm = W === 'storm' ? 1 : 0; wind = W === 'storm' ? 1 : W === 'rain' ? 0.15 : 0;
    }
    if (storm) rainy = true;
    const wxOn = this.weatherOn || !!W;
    this.storm = storm;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = 2 + cloud * 8 + storm * 6;
    u.rayleigh.value = 1.2 + cloud * 1.5;
    u.mieCoefficient.value = 0.004 + cloud * 0.01;
    u.mieDirectionalG.value = 0.8;
    this.sky.visible = night < 0.98;

    this.scene.background = null;
    this.domeMat.uniforms.uOp.value = night;
    this.dome.visible = night > 0.01;
    this.starMat.opacity = Math.max(0, night - 0.3) * (1 - cloud) * 1.1;
    this.stars.visible = this.starMat.opacity > 0.01;

    // 白天是太陽；入夜後同一盞平行光改當月光（冷白、較弱，仍有柔和陰影）
    const moon = night > 0.5, dark = storm * 0.35;   // 颱風天整體再暗一些
    this.sun.position.copy(this.center).addScaledVector(moon ? this.moonDir : dir, 400);
    this.sun.intensity = (moon ? night * this.moonI * (1 - cloud * 0.6) : (1 - night) * (3.0 - cloud * 1.6)) * (1 - dark);
    if (moon) this.sun.color.set(0xaec0e6);
    else this.sun.color.setHSL(0.09, 0.6, 0.5 + 0.45 * Math.min(1, Math.max(0, alt * 3)));
    this.hemi.intensity = (0.48 + (1 - night) * (0.42 + cloud * 0.4)) * (1 - dark);
    this.hemi.color.lerpColors(new THREE.Color(0xdfe9f2), new THREE.Color(0x8296c4), night);
    this.hemi.groundColor.lerpColors(new THREE.Color(0x4a4438), new THREE.Color(0x30364a), night);
    this.renderer.toneMappingExposure = 0.8 + (1 - night) * 0.2;

    this.fog.density = wxOn ? (storm ? 0.0032 : rainy ? 0.0016 : snowy ? 0.0024 : cloud * 0.0006) : 0;
    this.fog.color.lerpColors(new THREE.Color(snowy ? 0xe4e8ec : storm ? 0x9aa3ab : 0xbfc8cf), new THREE.Color(0x1e2a48), night);
    this.updatePrecip(rainy ? 'rain' : snowy ? 'snow' : null, dt, wind, storm);
    this.updateLightning(dt, storm && wxOn);
    this.updateAurora(dt, aurora ? night : 0);
  }

  // 雨：細長、半透明、尾端淡出的雨絲（垂直漸層），颱風時更密、斜飄；雪：柔和的小雪花緩慢飄落
  updatePrecip(kind, dt, wind = 0, storm = 0) {
    const R = 140, H = 60;
    if (kind === 'rain' && !this.rain) {
      const n = 16000, p = new Float32Array(n * 6), c = new Float32Array(n * 8), len = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (Math.random() - 0.5) * R, y = Math.random() * H, z = (Math.random() - 0.5) * R, l = 0.5 + Math.random() * 0.7;
        len[i] = l;
        p.set([x, y, z, x, y + l, z], i * 6);
        const a = 0.18 + Math.random() * 0.22;
        c.set([0.86, 0.9, 0.95, a, 0.86, 0.9, 0.95, 0], i * 8);   // 下端看得到、上端透明
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.BufferAttribute(c, 4));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true }));
      this.rain.userData.len = len;
      this.rain.position.copy(this.center); this.rain.frustumCulled = false; this.scene.add(this.rain);
    }
    if (kind === 'snow' && !this.snow) {
      const n = 9000, p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) p.set([(Math.random() - 0.5) * R, Math.random() * H, (Math.random() - 0.5) * R], i * 3);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(0.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
      this.snow = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.32, map: new THREE.CanvasTexture(cv), transparent: true, opacity: 0.85, depthWrite: false, color: 0xffffff }));
      this.snow.position.copy(this.center); this.snow.frustumCulled = false; this.scene.add(this.snow);
    }
    // 跟著鏡頭：粒子只在鏡頭附近 140 m 的範圍內，密度才夠
    const f = this.focus || this.center;
    for (const o of [this.rain, this.snow]) if (o) o.position.set(Math.round(f.x / 20) * 20, Math.max(0, f.y - H / 2), Math.round(f.z / 20) * 20);
    if (this.rain) {
      this.rain.visible = kind === 'rain';
      if (this.rain.visible) {
        // 颱風：全部雨絲都畫（更密）並往東南斜飄；一般雨只畫約六成
        this.rain.geometry.setDrawRange(0, Math.round(this.rain.geometry.attributes.position.count * (storm ? 1 : 0.6)));
        const a = this.rain.geometry.attributes.position, arr = a.array, len = this.rain.userData.len;
        const vy = 12 + storm * 8, sx = wind * 0.55, sz = wind * 0.25;   // 每公尺落下的水平偏移
        for (let i = 0, k = 0; i < arr.length; i += 6, k++) {
          let y = arr[i + 1] - vy * dt, x = arr[i] + sx * vy * dt, z = arr[i + 2] + sz * vy * dt;
          if (y < 0) { y += H; x -= sx * H; z -= sz * H; }
          if (x > R / 2) x -= R; if (x < -R / 2) x += R; if (z > R / 2) z -= R; if (z < -R / 2) z += R;
          const l = len[k];
          arr[i] = x; arr[i + 1] = y; arr[i + 2] = z;
          arr[i + 3] = x - sx * l; arr[i + 4] = y + l; arr[i + 5] = z - sz * l;
        }
        a.needsUpdate = true;
      }
    }
    if (this.snow) {
      this.snow.visible = kind === 'snow';
      if (this.snow.visible) {
        const a = this.snow.geometry.attributes.position, arr = a.array, t = performance.now() / 1000;
        for (let i = 0; i < arr.length; i += 3) {
          let y = arr[i + 1] - (0.6 + (i % 7) * 0.06) * dt; if (y < 0) y += H;
          arr[i + 1] = y; arr[i] += Math.sin(t * 0.6 + i) * 0.3 * dt; arr[i + 2] += Math.cos(t * 0.45 + i * 0.3) * 0.25 * dt;
        }
        a.needsUpdate = true;
      }
    }
  }

  // 閃電：隨機間隔在園區周邊打下一道分岔的閃電，同時整個場景閃白兩下
  updateLightning(dt, on) {
    if (!this.flash) {
      this.flash = new THREE.DirectionalLight(0xdfe6ff, 0);
      this.flash.position.set(0, 500, 0); this.scene.add(this.flash);
      this.boltMat = new THREE.LineBasicMaterial({ color: 0xf2f5ff, transparent: true, opacity: 0, fog: false, toneMapped: false });
      this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), this.boltMat);
      this.bolt.frustumCulled = false; this.bolt.visible = false; this.scene.add(this.bolt);
      this.nextStrike = 2;
      this.strikeT = -1;
    }
    if (!on) { this.flash.intensity = 0; this.bolt.visible = false; this.flashK = 0; return; }
    this.nextStrike -= dt;
    if (this.nextStrike <= 0) {
      this.nextStrike = 3 + Math.random() * 7;
      this.strikeT = 0;
      this.makeBolt();
    }
    let k = 0;
    if (this.strikeT >= 0) {
      const t = (this.strikeT += dt);
      // 亮兩下：0–0.08 s、0.16–0.3 s
      k = t < 0.08 ? 1 : t < 0.16 ? 0.15 : t < 0.3 ? 0.8 * (1 - (t - 0.16) / 0.14) : 0;
      if (t > 0.35) this.strikeT = -1;
    }
    this.flashK = k;
    this.flash.intensity = k * 6;
    this.boltMat.opacity = Math.min(1, k * 1.4);
    this.bolt.visible = k > 0.02;
  }
  makeBolt() {
    const f = this.focus || this.center, ang = Math.random() * Math.PI * 2, dist = 250 + Math.random() * 450;
    const x0 = f.x + Math.cos(ang) * dist, z0 = f.z + Math.sin(ang) * dist, top = 420 + Math.random() * 200;
    const seg = [];
    const branch = (x, y, z, len, depth) => {
      let px = x, py = y, pz = z;
      const steps = Math.round(len / 18);
      for (let i = 0; i < steps && py > 0; i++) {
        const nx = px + (Math.random() - 0.5) * 22, ny = py - (len / steps) * (0.7 + Math.random() * 0.6), nz = pz + (Math.random() - 0.5) * 22;
        seg.push(px, py, pz, nx, Math.max(0, ny), nz);
        if (depth < 2 && Math.random() < 0.12) branch(nx, ny, nz, len * 0.35, depth + 1);
        px = nx; py = ny; pz = nz;
      }
    };
    branch(x0, top, z0, top, 0);
    this.bolt.geometry.dispose();
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.bolt.geometry = g;
    this.flash.position.set(x0, top, z0); this.flash.target.position.copy(this.center); this.flash.target.updateMatrixWorld();
  }

  // 極光：北方天空的光幕（只在夜間看得到；選「極光」預覽時若是白天，網頁會自動切到夜間）
  updateAurora(dt, k) {
    if (!this.aurora && k <= 0) return;
    if (!this.aurora) {
      const north = THREE.MathUtils.degToRad(this.site.northOffset_deg ?? 23);
      const g = new THREE.CylinderGeometry(2600, 2600, 1300, 96, 1, true, 0, Math.PI * 0.75);
      this.auroraMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        uniforms: { uT: { value: 0 }, uK: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec2 vUv; uniform float uT, uK;
          float h(float n){ return fract(sin(n)*43758.5453); }
          float nz(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(h(i),h(i+1.0),f); }
          void main(){
            float u = vUv.x, v = vUv.y;
            // 光幕下緣起伏
            float base = 0.18 + 0.10*sin(u*9.0 + uT*0.12) + 0.05*sin(u*23.0 - uT*0.2);
            float d = v - base;
            if (d < 0.0) discard;
            // 直條紋（光柱）緩慢流動
            float rays = 0.55 + 0.45*nz(u*140.0 + uT*0.6) * nz(u*37.0 - uT*0.25);
            float band = exp(-d*5.0) * smoothstep(0.0, 0.03, d);
            float edge = smoothstep(0.0, 0.12, u) * smoothstep(1.0, 0.88, u);
            vec3 green = vec3(0.25, 1.0, 0.55), violet = vec3(0.65, 0.35, 1.0);
            vec3 col = mix(green, violet, smoothstep(0.08, 0.45, d));
            float a = 1.5 * band * rays * edge * uK * (0.7 + 0.3*sin(uT*0.4 + u*5.0));
            gl_FragColor = vec4(col * a, a);
          }`,
      });
      this.aurora = new THREE.Mesh(g, this.auroraMat);
      this.aurora.position.copy(this.center).setY(650);
      // 圓弧中心朝向真北（北 = -Z 轉 northOffset）
      // CylinderGeometry 的角度 θ 對應方向 (sinθ, cosθ)，弧中心在 0.375π；轉到真北的方位 π − north
      this.aurora.rotation.y = Math.PI - north - Math.PI * 0.375;
      this.aurora.renderOrder = -0.5; this.aurora.frustumCulled = false;
      this.scene.add(this.aurora);
      this.auroraK = 0;
    }
    this.auroraK += (k - this.auroraK) * Math.min(1, dt * 1.5);
    this.auroraMat.uniforms.uK.value = this.auroraK;
    this.auroraMat.uniforms.uT.value += dt;
    this.aurora.visible = this.auroraK > 0.01;
  }
}
