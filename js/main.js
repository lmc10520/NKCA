import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadJSON, cm2w, w2cm, makeMatcher, toast, ease, isMobile } from './util.js';
import { loadModel } from './model.js';
import { Environment } from './env.js';
import { NightLights } from './lights.js';
import { Fountain } from './fountain.js';
import { Vehicles } from './vehicles.js';
import { buildScreens } from './screens.js';
import { Labels } from './labels.js';

const $ = (id) => document.getElementById(id);

// ---------- 設定 ----------
const [site, modesCfg, lightsCfg, coresCfg, hallsCfg, labelsCfg, screensCfg, infoCfg, roadsCfg, fountainCfg, lawnsCfg] =
  await Promise.all(['site', 'modes', 'lights', 'cores', 'halls', 'labels', 'screens', 'info', 'roads', 'fountain', 'lawns']
    .map((n) => loadJSON(`config/${n}.json`, {})));
document.title = site.title || document.title;

// ---------- 場景 ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = !!site.shadows && !isMobile;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 6000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = THREE.MathUtils.degToRad(84);   // 不讓鏡頭鑽到地面下
controls.minDistance = 4; controls.maxDistance = 1600;
controls.screenSpacePanning = false;
// Google 地圖式：左鍵平移、右鍵（或 Ctrl＋左鍵）旋轉傾斜；手機雙指旋轉縮放
addEventListener('keydown', (e) => { if (e.key === 'Control') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; });
addEventListener('keyup', (e) => { if (e.key === 'Control') controls.mouseButtons.LEFT = THREE.MOUSE.PAN; });
const sc = site.startCamera || {};
camera.position.copy(cm2w(sc.pos_cm || [2000, -12000, 16000]));
controls.target.copy(cm2w(sc.target_cm || [13700, 15300, 0]));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.5, 0.85);
if (site.bloom !== false) composer.addPass(bloom);
composer.addPass(new OutputPass());

const env = new Environment(scene, renderer, site);

// ---------- 模型 ----------
const model = await loadModel(site.model || 'model/nkca.glb', (f) => ($('loadBar').style.width = (f * 100).toFixed(0) + '%'));
scene.add(model.root);
const exclude = makeMatcher(modesCfg.exclude, modesCfg.groups);
for (const m of model.meshes) if (exclude(m.userData.fname)) { m.visible = false; m.userData.excluded = true; }

const night = new NightLights(scene, model, lightsCfg, lawnsCfg);
const fountain = fountainCfg?.nozzles ? new Fountain(scene, fountainCfg) : null;
const vehicles = new Vehicles(scene, roadsCfg, lightsCfg.vehicles);
const screens = buildScreens(scene, screensCfg);
const labels = new Labels(labelsCfg);
$('loading').classList.add('hidden');

// ---------- 可見性：模式 + 廳院樓層 ----------
const state = { mode: modesCfg.default || 'exterior', halls: {}, cards: true, clock: true, weather: true, contrast: false, wire: false, labels: true };
const modeHide = {};
for (const m of modesCfg.modes || []) modeHide[m.id] = makeMatcher(m.hide, modesCfg.groups);
const halls = (hallsCfg.halls || []).map((h) => ({ ...h, floorsM: h.floors.map((f) => ({ ...f, hideM: makeMatcher(f.hide), showM: makeMatcher(f.show) })) }));
halls.forEach((h) => (state.halls[h.id] = h.default));
const allHallShow = (n) => halls.some((h) => h.floorsM.some((f) => f.showM(n)));

function applyVisibility() {
  const hide = modeHide[state.mode] || (() => false);
  for (const m of model.meshes) {
    if (m.userData.excluded) continue;
    const n = m.userData.fname;
    let v = !hide(n);
    for (const h of halls) {
      if (h.modes && !h.modes.includes(state.mode)) continue;
      const f = h.floorsM.find((x) => x.id === state.halls[h.id]);
      if (!f) continue;
      if (f.hideM(n)) v = false;
    }
    m.visible = v;
  }
}
function setMode(id, quiet) {
  state.mode = id;
  [...$('modeBar').children].forEach((b) => b.classList.toggle('on', b.dataset.mode === id));
  applyVisibility();
  if (!quiet) { const m = modesCfg.modes.find((x) => x.id === id); toast(`切換到「${m?.label || id}」`); }
}
for (const m of modesCfg.modes || []) {
  const b = document.createElement('button'); b.textContent = m.label; b.dataset.mode = m.id;
  b.onclick = () => setMode(m.id); $('modeBar').appendChild(b);
}
setMode(state.mode, true);

// 廳院樓層升起動畫
const lifts = [];
function setHallFloor(h, fid) {
  state.halls[h.id] = fid; applyVisibility();
  const f = h.floorsM.find((x) => x.id === fid);
  if (f?.lift_m) {
    for (const m of model.meshes) if (f.showM(m.userData.fname) && m.visible) {
      m.userData.y0 ??= m.position.y; m.position.y = m.userData.y0 - f.lift_m;
      lifts.push({ m, t: 0 });
    }
  }
  renderLiftPanel(true);
}

// ---------- 電梯／樓層面板 ----------
let liftCtx = null;
function nearest() {
  const t = controls.target, d = camera.position.distanceTo(t);
  if (d > (coresCfg.showWithin_cm ?? 25000) / 100) return null;   // 鏡頭要拉近到這個距離內才顯示
  let best = null;
  for (const c of coresCfg.cores || []) {
    if (c.enabled === false) continue;
    const p = cm2w(c.center_cm), dist = Math.hypot(p.x - t.x, p.z - t.z);
    if (dist < c.radius_cm / 100 && (!best || dist < best.dist)) best = { type: 'core', c, dist };
  }
  for (const h of halls) {
    if (h.modes && !h.modes.includes(state.mode)) continue;
    const p = cm2w(h.center_cm), dist = Math.hypot(p.x - t.x, p.z - t.z);
    if (dist < h.radius_cm / 100 && (!best || dist < best.dist)) best = { type: 'hall', c: h, dist };
  }
  return best;
}
function renderLiftPanel(force) {
  const n = state.presenting ? null : nearest();
  const key = n ? n.type + n.c.id + state.mode + JSON.stringify(state.halls) : '';
  if (!force && key === liftCtx) return;
  liftCtx = key;
  $('liftPanel').classList.toggle('hidden', !n);
  if (!n) return;
  $('liftTitle').textContent = n.c.label;
  const box = $('liftButtons'); box.innerHTML = '';
  const cur = n.type === 'hall' ? state.halls[n.c.id] : currentCoreFloor(n.c);
  for (const f of n.c.floors) {
    const b = document.createElement('button'); b.textContent = f.id; b.classList.toggle('on', f.id === cur);
    b.onclick = () => (n.type === 'hall' ? setHallFloor(n.c, f.id) : coreAction(n.c, f));
    box.appendChild(b);
  }
}
function currentCoreFloor(c) {
  const f = c.floors.find((x) => x.action === 'mode' && x.mode === state.mode);
  return f ? f.id : null;
}
function coreAction(c, f) {
  if (f.action === 'mode') { setMode(f.mode); renderLiftPanel(true); }
  else if (f.action === 'popup') openModal(f.title || f.id, f.img);
}
function openModal(title, img) {
  $('modalTitle').textContent = title; $('modalNote').textContent = '';
  const im = $('modalImg'); im.style.display = '';
  im.onerror = () => { im.style.display = 'none'; $('modalNote').textContent = `尚未放入平面圖：請把圖片上傳為 ${img}`; };
  im.src = img; $('modal').classList.remove('hidden');
}
$('modalClose').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };

// ---------- 點選：資訊卡、Shift＋點擊取座標 ----------
const ray = new THREE.Raycaster();
const infoItems = (infoCfg.items || []).map((i) => ({ ...i, re: new RegExp(i.match) }));
let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const objs = [...model.meshes.filter((m) => m.visible), ...screens.children];
  const hit = ray.intersectObjects(objs, false)[0];
  if (!hit) { $('card').classList.add('hidden'); state.card = null; return; }
  if (e.shiftKey || e.altKey) {
    const c = w2cm(hit.point), txt = `[${c.join(',')}]`;
    navigator.clipboard?.writeText(txt);
    toast(`座標（cm）${txt}　${hit.object.userData.fname}　已複製`, 5000);
    return;
  }
  if (state.cards) showCard(hit.object.userData.fname);
});
function showCard(name) {
  if (!name) { $('card').classList.add('hidden'); state.card = null; return; }
  const it = infoItems.find((i) => i.re.test(name));
  $('cardTitle').textContent = it?.title || name;
  $('cardBody').innerHTML = (it?.text ? `<p>${it.text}</p>` : '') + (it?.img ? `<img src="${it.img}" alt="">` : '') +
    (it ? '' : '<p style="opacity:.6">（可在 config/info.json 補上說明）</p>');
  $('card').classList.remove('hidden'); state.card = name;
}
$('cardClose').onclick = () => showCard(null);

// ---------- 高對比、線架構 ----------
const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f2, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const glassMat = new THREE.MeshLambertMaterial({ color: 0xbcd7e6, transparent: true, opacity: 0.35, depthWrite: false });
const hiddenFaceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: true, colorWrite: false });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x22262a });
let edgesBuilt = false;
function buildEdges() {
  if (edgesBuilt) return; edgesBuilt = true;
  for (const m of model.meshes) {
    const ls = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 45), edgeMat);
    ls.visible = false; ls.raycast = () => {}; m.add(ls); m.userData.edges = ls;
  }
}
function applyStyle() {
  const style = state.wire ? 'wire' : state.contrast ? 'contrast' : 'normal';
  if (style !== 'normal') buildEdges();
  for (const m of model.meshes) {
    m.material = style === 'normal' ? m.userData.origMaterial : style === 'contrast' ? (m.userData.isGlass ? glassMat : whiteMat) : hiddenFaceMat;
    if (m.userData.edges) m.userData.edges.visible = style !== 'normal' && !m.userData.isGlass;
  }
  night.group.visible = style === 'normal';
}

// ---------- 工具列 ----------
const tb = (k) => document.querySelector(`#toolbar [data-tool="${k}"]`);
function setToggle(k, v) {
  state[k] = v; tb(k)?.classList.toggle('on', v);
  if (k === 'labels') labels.visible = v;
  if (k === 'cards' && !v) showCard(null);
  if (k === 'clock') $('clock').classList.toggle('hidden', !v && !state.weather);
  if (k === 'weather') env.weatherOn = v;
  if (k === 'contrast' || k === 'wire') applyStyle();
}
for (const b of document.querySelectorAll('#toolbar button')) {
  const k = b.dataset.tool;
  b.onclick = () => {
    if (['labels', 'cards', 'clock', 'weather', 'contrast', 'wire'].includes(k)) setToggle(k, !state[k]);
    else if (k === 'time') { $('timeSlider').classList.toggle('hidden'); b.classList.toggle('on'); }
    else if (k === 'snap') snapshot();
    else if (k === 'present') $('presFile').click();
  };
}
$('timeRange').oninput = (e) => { env.override = +e.target.value; };
$('timeLive').onclick = () => { env.override = null; };

// ---------- 指北針 ----------
$('compass').onclick = () => {
  const t = controls.target, d = camera.position.clone().sub(t);
  const r = Math.hypot(d.x, d.z);
  flyTo(t.clone().add(new THREE.Vector3(0, d.y, r)), t.clone(), 900);
};

// ---------- 鏡頭動畫 ----------
let fly = null;
function flyTo(pos, target, ms = 1600) {
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, t: 0, ms };
}

// ---------- 簡報模式 ----------
// 代碼格式：NKCA1:<base64 JSON>，可貼到記事本一行一個，依序播放
function snapshot() {
  const s = {
    v: 1, c: w2cm(camera.position), t: w2cm(controls.target), m: state.mode, h: state.halls,
    ui: { labels: state.labels, cards: state.cards, clock: state.clock, weather: state.weather, contrast: state.contrast, wire: state.wire },
    tod: env.override, card: state.card || null,
  };
  const code = 'NKCA1:' + btoa(unescape(encodeURIComponent(JSON.stringify(s))));
  navigator.clipboard?.writeText(code);
  toast('已複製簡報代碼（貼到記事本，一行一個）：\n' + code, 6000);
}
function decode(line) {
  const m = line.trim().match(/^NKCA1:([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return null; }
}
const pres = { cues: [], i: 0 };
$('presFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pres.cues = (await f.text()).split(/\r?\n/).map(decode).filter(Boolean);
  e.target.value = '';
  if (!pres.cues.length) { toast('檔案中沒有可用的簡報代碼'); return; }
  state.presenting = true; document.body.classList.add('presenting');
  $('presBar').classList.remove('hidden'); renderLiftPanel(true);
  goCue(0);
};
function goCue(i) {
  pres.i = Math.max(0, Math.min(pres.cues.length - 1, i));
  const s = pres.cues[pres.i];
  $('presIdx').textContent = `${pres.i + 1}/${pres.cues.length}`;
  if (s.m) setMode(s.m, true);
  if (s.h) for (const h of halls) if (s.h[h.id]) setHallFloor(h, s.h[h.id]);
  for (const [k, v] of Object.entries(s.ui || {})) setToggle(k, v);
  env.override = s.tod ?? null;
  showCard(s.card && state.cards ? s.card : null);
  flyTo(cm2w(s.c), cm2w(s.t));
}
function exitPres() {
  state.presenting = false; document.body.classList.remove('presenting');
  $('presBar').classList.add('hidden'); renderLiftPanel(true);
}
$('presPrev').onclick = () => goCue(pres.i - 1);
$('presNext').onclick = () => goCue(pres.i + 1);
$('presExit').onclick = exitPres;
addEventListener('keydown', (e) => {
  if (!state.presenting) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') goCue(pres.i + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goCue(pres.i - 1);
  if (e.key === 'Escape') exitPres();
});

// ---------- 迴圈 ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const clock = new THREE.Clock();
let lastUI = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (fly) {
    fly.t += (dt * 1000) / fly.ms; const k = ease(Math.min(1, fly.t));
    camera.position.lerpVectors(fly.p0, fly.p1, k); controls.target.lerpVectors(fly.t0, fly.t1, k);
    if (fly.t >= 1) fly = null;
  }
  controls.update();
  if (camera.position.y < 1.2) camera.position.y = 1.2;
  env.update(dt);
  if (state.contrast || state.wire) { scene.background = new THREE.Color(0xffffff); env.sky.visible = false; scene.fog.density = 0; }
  const n = state.contrast || state.wire ? 0 : env.night;
  night.update(n);
  bloom.strength = n * 0.9;
  fountain?.update(t, env.now(), n);
  vehicles.update(dt, n);
  for (let i = lifts.length - 1; i >= 0; i--) {
    const L = lifts[i]; L.t = Math.min(1, L.t + dt / 1.2);
    const f = halls.flatMap((h) => h.floorsM).find((x) => x.showM(L.m.userData.fname));
    L.m.position.y = L.m.userData.y0 - (f?.lift_m || 0) * (1 - ease(L.t));
    if (L.t >= 1) lifts.splice(i, 1);
  }
  composer.render();
  labels.update(camera, innerWidth, innerHeight);
  if (t - lastUI > 0.25) {
    lastUI = t;
    const d = env.now();
    const tp = d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    $('clockTime').textContent = state.clock ? tp : '';
    $('clockDate').textContent = state.clock ? d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'short' }) : '';
    $('weather').textContent = state.weather ? env.weatherText() : '';
    $('clock').classList.toggle('hidden', !state.clock && !state.weather);
    if (env.override != null) { $('timeRange').value = env.override; $('timeLabel').textContent = tp; }
    else $('timeLabel').textContent = '即時';
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    $('compassRose').setAttribute('transform', `rotate(${THREE.MathUtils.radToDeg(az)} 32 32)`);
    renderLiftPanel(false);
  }
});

// 開發者用：在主控台 window.nkca 可以查物件
window.nkca = { scene, camera, controls, model, env, state, setMode, flyTo, fountain };
