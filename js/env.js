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
        '&current=temperature_2m,weather_code,cloud_cover,precipitation&timezone=Asia%2FTaipei';
      const j = await (await fetch(u)).json();
      this.weather = j.current;
    } catch (e) { this.weather = null; }
  }

  weatherText() {
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
    const cloud = this.weatherOn && this.weather ? this.weather.cloud_cover / 100 : 0.1;
    const rainy = this.weatherOn && this.weather && this.weather.precipitation > 0;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = 2 + cloud * 8;
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
    const moon = night > 0.5;
    this.sun.position.copy(this.center).addScaledVector(moon ? this.moonDir : dir, 400);
    this.sun.intensity = moon ? night * this.moonI * (1 - cloud * 0.6) : (1 - night) * (3.0 - cloud * 1.6);
    if (moon) this.sun.color.set(0xaec0e6);
    else this.sun.color.setHSL(0.09, 0.6, 0.5 + 0.45 * Math.min(1, Math.max(0, alt * 3)));
    this.hemi.intensity = 0.48 + (1 - night) * (0.42 + cloud * 0.4);
    this.hemi.color.lerpColors(new THREE.Color(0xdfe9f2), new THREE.Color(0x8296c4), night);
    this.hemi.groundColor.lerpColors(new THREE.Color(0x4a4438), new THREE.Color(0x30364a), night);
    this.renderer.toneMappingExposure = 0.8 + (1 - night) * 0.2;

    this.fog.density = this.weatherOn ? (rainy ? 0.0022 : cloud * 0.0006) : 0;
    this.fog.color.lerpColors(new THREE.Color(0xbfc8cf), new THREE.Color(0x1e2a48), night);
    this.updateRain(rainy, dt);
  }

  updateRain(on, dt) {
    if (on && !this.rain) {
      const n = 6000, g = new THREE.BufferGeometry(), p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - .5) * 400; p[i * 3 + 1] = Math.random() * 120; p[i * 3 + 2] = (Math.random() - .5) * 400; }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      this.rain = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab8c8, size: 0.15, transparent: true, opacity: 0.6 }));
      this.rain.position.copy(this.center);
      this.scene.add(this.rain);
    }
    if (this.rain) {
      this.rain.visible = on;
      if (on) {
        const a = this.rain.geometry.attributes.position;
        for (let i = 0; i < a.count; i++) { let y = a.getY(i) - 60 * dt; if (y < 0) y += 120; a.setY(i, y); }
        a.needsUpdate = true;
      }
    }
  }
}
