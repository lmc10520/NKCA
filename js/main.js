import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { loadJSON, cm2w, w2cm, makeMatcher, toast, ease, isMobile } from './util.js';
import { loadModel } from './model.js';
import { Environment } from './env.js';
import { NightLights } from './lights.js';
import { Fountain } from './fountain.js';
import { Vehicles, People } from './vehicles.js';
import { buildScreens } from './screens.js';
import { Labels, Pois } from './labels.js';

const $ = (id) => document.getElementById(id);

// ---------- 設定 ----------
const [site, modesCfg, lightsCfg, coresCfg, hallsCfg, labelsCfg, screensCfg, roadsCfg, fountainCfg, lawnsCfg, peopleCfg, streetCfg, poisCfg] =
  await Promise.all(['site', 'modes', 'lights', 'cores', 'halls', 'labels', 'screens', 'roads', 'fountain', 'lawns', 'walk', 'streetlights', 'pois']
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
// camera：透視鏡頭，也是操控的主體；orthoCam：等角（平行投影）時跟著 camera 的方向與距離換算畫面大小
const camera = new THREE.PerspectiveCamera(45, 1, 0.3, 6000);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 14000);
const viewCam = () => (state.ortho ? orthoCam : camera);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = THREE.MathUtils.degToRad(89.5);   // 立面視角需要接近水平；鏡頭高度另外限制不鑽到地面下
controls.minDistance = 4; controls.maxDistance = 1600;
controls.screenSpacePanning = false;
// 中鍵也用來平移（原本的中鍵縮放有 DPR 除以 0 的問題，會瞬間跳到最大／最小）
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
// 滑鼠滾輪縮放自己處理：three r160 內建的滾輪縮放用 (devicePixelRatio | 0) 當分母，DPR < 1 時會除以 0
canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); e.stopImmediatePropagation();
  if (fly) return;
  let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
  dy = THREE.MathUtils.clamp(dy, -300, 300);
  const k = Math.pow(0.95, Math.abs(dy) / 100);
  const off = camera.position.clone().sub(controls.target);
  const d0 = off.length(), d1 = THREE.MathUtils.clamp(dy < 0 ? d0 * k : d0 / k, controls.minDistance, controls.maxDistance);
  // 往游標方向拉近（像 Google 地圖）
  if (dy < 0) {
    ray.setFromCamera(ndc(e), viewCam());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -controls.target.y), hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, hit) && hit.distanceTo(controls.target) < d0 * 3) {
      const shift = hit.sub(controls.target).multiplyScalar(1 - d1 / d0);
      controls.target.add(shift); camera.position.add(shift);
    }
  }
  camera.position.copy(controls.target).add(off.setLength(d1));
  controls.update();
}, { passive: false, capture: true });
// Google 地圖式：左鍵平移、右鍵（或 Ctrl＋左鍵）旋轉傾斜；手機雙指旋轉縮放
addEventListener('keydown', (e) => { if (e.key === 'Control') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; });
addEventListener('keyup', (e) => { if (e.key === 'Control') controls.mouseButtons.LEFT = THREE.MOUSE.PAN; });
const sc = site.startCamera || {};
camera.position.copy(cm2w(sc.pos_cm || [2000, -12000, 16000]));
controls.target.copy(cm2w(sc.target_cm || [13700, 15300, 0]));

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.5, 0.85);
if (site.bloom !== false) composer.addPass(bloom);
composer.addPass(new OutputPass());

const env = new Environment(scene, renderer, site);

// ---------- 模型 ----------
const model = await loadModel(site.model || 'model/nkca.glb', (f) => ($('loadBar').style.width = (f * 100).toFixed(0) + '%'));
scene.add(model.root);
const exclude = makeMatcher(modesCfg.exclude, modesCfg.groups);
for (const m of model.meshes) if (exclude(m.userData.fname)) { m.visible = false; m.userData.excluded = true; }

// 材質統一：config/site.json 的 materialFrom 指定「名稱規則 → 參照物件」，網頁直接套用參照物件的材質
for (const [pat, ref] of Object.entries(site.materialFrom || {})) {
  if (pat.startsWith('_')) continue;
  const src = model.meshes.find((m) => m.userData.fname === ref);
  if (!src) continue;
  const re = new RegExp(pat);
  for (const m of model.meshes) if (m !== src && re.test(m.userData.fname)) { m.material = src.material; m.userData.origMaterial = src.material; }
}
// 幾乎重疊的地面圖層上下錯開，避免閃爍（site.json 的 lift_cm）
for (const [pat, cm] of Object.entries(site.lift_cm || {})) {
  if (pat.startsWith('_')) continue;
  const re = new RegExp(pat);
  for (const m of model.meshes) if (re.test(m.userData.fname)) {
    const w = m.getWorldPosition(new THREE.Vector3()); w.y += cm / 100;
    m.position.copy(m.parent.worldToLocal(w)); m.updateMatrixWorld(true);
  }
}
// 地坪與周邊環境（高對比時淡化）；其他視為建築
const groundRe = new RegExp(site.groundMatch || '^(Site_|Plaza_Ground|Plaza_Wall_Patch|Theater_Seating)');
for (const m of model.meshes) m.userData.isGround = groundRe.test(m.userData.fname);

const night = new NightLights(scene, model, lightsCfg, lawnsCfg);
night.addStreetLights(streetCfg);
const fountain = fountainCfg?.nozzles ? new Fountain(scene, fountainCfg) : null;
const vehicles = new Vehicles(scene, roadsCfg, lightsCfg.vehicles);
const people = new People(scene, peopleCfg);
const screens = buildScreens(scene, screensCfg);
const labels = new Labels(labelsCfg, model);
const pois = new Pois(poisCfg, model, labels);
$('loading').classList.add('hidden');

// ---------- 可見性：模式 + 廳院樓層 ----------
const state = {
  mode: modesCfg.default || 'exterior', halls: {}, clock: true, weather: true, labels: true, traffic: true,
  style: 'normal', contrast: false, wire: false, ortho: false, lineW: 2,
};
const modeHide = {};
for (const m of modesCfg.modes || []) modeHide[m.id] = makeMatcher(m.hide, modesCfg.groups);
const halls = (hallsCfg.halls || []).map((h) => ({ ...h, floorsM: h.floors.map((f) => ({ ...f, hideM: makeMatcher(f.hide), showM: makeMatcher(f.show) })) }));
halls.forEach((h) => (state.halls[h.id] = h.default));

function applyVisibility() {
  const hide = modeHide[state.mode] || (() => false);
  for (const m of model.meshes) {
    if (m.userData.excluded) continue;
    const n = m.userData.fname;
    let v = !hide(n);
    for (const h of halls) {
      if (h.modes && !h.modes.includes(state.mode)) continue;
      const f = h.floorsM.find((x) => x.id === state.halls[h.id]);
      if (f?.hideM(n)) v = false;
    }
    m.visible = v;
  }
  night.roofOn = !!model.byName.get('Roof_Main')?.some((m) => m.visible);
  labels.reanchor();
  pois.setContext(state);
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
let liftCtx = null, liftPin = null;
// 點標籤：指定要顯示哪個交通核／廳院的樓層選單，並把鏡頭帶過去
labels.onLift = (ref) => {
  const [type, id] = ref.split(':');
  const c = type === 'hall' ? halls.find((h) => h.id === id) : (coresCfg.cores || []).find((x) => x.id === id);
  if (!c) return;
  if (type === 'hall' && c.modes && !c.modes.includes(state.mode)) setMode(c.modes[0]);
  liftPin = { type, c };
  const p = cm2w(c.center_cm), t = controls.target, off = camera.position.clone().sub(t);
  const d = Math.min(off.length(), 140);
  flyTo(p.clone().add(off.setLength(d)), p, 1200);
  renderLiftPanel(true);
};
function nearest() {
  if (liftPin) {
    // 鏡頭離開該處（目標點移出兩倍範圍）就取消固定
    const p = cm2w(liftPin.c.center_cm), t = fly ? fly.t1 : controls.target;
    if (Math.hypot(p.x - t.x, p.z - t.z) < (liftPin.c.radius_cm / 100) * 2 && !(liftPin.c.modes && !liftPin.c.modes.includes(state.mode))) return liftPin;
    liftPin = null;
  }
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
  $('modal').classList.remove('hidden');
  im.onload = () => mapZ.fit(); im.src = img; if (im.complete && im.naturalWidth) mapZ.fit();
}
$('modalClose').onclick = () => $('modal').classList.add('hidden');
// 停車場地圖：拖曳平移、雙指縮放、滾輪縮放、雙擊放大，右下角 ＋／－／符合畫面
const mapZ = (() => {
  const view = $('mapView'), img = $('modalImg');
  let s = 1, x = 0, y = 0, fitS = 1;
  const pts = new Map(); let last = null, lastTap = 0;
  const apply = () => { img.style.transform = `translate(${x}px,${y}px) scale(${s})`; };
  const W = () => img.naturalWidth || 1600, H = () => img.naturalHeight || 1130;
  function fit() {
    // SVG 沒有固定像素大小時，以 1600 寬為基準
    if (!img.naturalWidth) { img.style.width = '1600px'; }
    const vw = view.clientWidth, vh = view.clientHeight;
    fitS = Math.min(vw / W(), vh / H()); s = fitS;
    x = (vw - W() * s) / 2; y = (vh - H() * s) / 2; apply();
  }
  function zoomAt(k, cx, cy) {
    const ns = Math.min(fitS * 8, Math.max(fitS, s * k));
    x = cx - (cx - x) * (ns / s); y = cy - (cy - y) * (ns / s); s = ns; apply();
  }
  const local = (e) => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  view.addEventListener('wheel', (e) => { e.preventDefault(); const [cx, cy] = local(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, cx, cy); }, { passive: false });
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); last = null;
    const now = performance.now();
    if (pts.size === 1 && now - lastTap < 300) { const [cx, cy] = local(e); zoomAt(s > fitS * 1.5 ? fitS / s : 2.5, cx, cy); }
    lastTap = now;
  });
  view.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e); pts.set(e.pointerId, cur);
    if (pts.size === 1) { x += cur[0] - prev[0]; y += cur[1] - prev[1]; apply(); }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (last) { zoomAt(d / last.d, c[0], c[1]); x += c[0] - last.c[0]; y += c[1] - last.c[1]; apply(); }
      last = { d, c };
    }
  });
  const up = (e) => { pts.delete(e.pointerId); last = null; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  const mid = () => [view.clientWidth / 2, view.clientHeight / 2];
  $('zIn').onclick = (e) => { e.stopPropagation(); zoomAt(1.5, ...mid()); };
  $('zOut').onclick = (e) => { e.stopPropagation(); zoomAt(1 / 1.5, ...mid()); };
  $('zFit').onclick = (e) => { e.stopPropagation(); fit(); };
  $('mapZoom').addEventListener('pointerdown', (e) => e.stopPropagation());
  addEventListener('resize', () => { if (!$('modal').classList.contains('hidden')) fit(); });
  return { fit };
})();
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };

// ---------- 點選：行人、Shift＋點擊取座標；點空白處收起標籤資料卡 ----------
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const ndc = (e) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
let downAt = null;
canvas.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  if (!e.shiftKey && !e.altKey) {
    if (people.tap(e.clientX, e.clientY, viewCam(), r)) return;
    labels.close(); $('settings').classList.add('hidden');
    return;
  }
  ray.setFromCamera(ndc(e), viewCam());
  const hit = ray.intersectObjects([...model.meshes.filter((m) => m.visible), ...screens.children], false)[0];
  if (!hit) return;
  const c = w2cm(hit.point), txt = `[${c.join(',')}]`;
  // 複製一行可直接貼進 config/pois.json 的設定（含目前模式；榕樹廣場模式附上附近廳院的樓層）
  const n = nearest(), hallPart = state.mode === 'plaza' && n?.type === 'hall' ? `, "hall": "${n.c.id}", "floor": "${state.halls[n.c.id]}"` : '';
  const line = `{ "icon": "", "text": "", "pos_cm": ${txt}, "modes": ["${state.mode}"]${hallPart} }`;
  navigator.clipboard?.writeText(line);
  toast(`已複製（${hit.object.userData.fname}）：\n${line}`, 6000);
});

// ---------- 模型樣式：一般／高對比／線架構 ----------
// 高對比：建築白色有明暗＋深色輪廓線，地坪與周邊淡成淺灰、不畫線，人車隱藏 → 凸顯建築
const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
const groundMat = new THREE.MeshBasicMaterial({ color: 0xeceef1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
const glassMat = new THREE.MeshLambertMaterial({ color: 0xbcd7e6, transparent: true, opacity: 0.35, depthWrite: false });
// 線架構＝只顯示看得到的邊：面用不透明白色、往後推一點先寫入深度，把後面的邊遮住
const hiddenFaceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
// 粗線（LineSegments2）：線寬以螢幕像素計，可在設定中調整
const edgeMat = new LineMaterial({ color: 0x1f2328, linewidth: state.lineW, worldUnits: false });
const groundEdgeMat = new LineMaterial({ color: 0x9aa0a6, linewidth: 1, worldUnits: false });
let edgesBuilt = false;
function buildEdges() {
  if (edgesBuilt) return; edgesBuilt = true;
  const skip = new RegExp(site.edgeSkip || '^Site_Fountain_(LED|Nozzles)');   // 太細碎、看不出來的物件不畫線
  for (const m of model.meshes) {
    if (skip.test(m.userData.fname)) continue;
    const g = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(m.geometry, 40));
    const ls = new LineSegments2(g, m.userData.isGround ? groundEdgeMat : edgeMat);
    ls.visible = false; ls.raycast = () => {}; ls.frustumCulled = false; m.add(ls); m.userData.edges = ls;
  }
  resize();
}
function setStyle(style) {
  state.style = style; state.contrast = style === 'contrast'; state.wire = style === 'wire';
  if (style !== 'normal') buildEdges();
  for (const m of model.meshes) {
    const g = m.userData.isGround, gl = m.userData.isGlass;
    m.material = style === 'normal' ? m.userData.origMaterial
      : style === 'contrast' ? (gl ? glassMat : g ? groundMat : whiteMat) : hiddenFaceMat;
    if (m.userData.edges) m.userData.edges.visible = style === 'wire' || (style === 'contrast' && !g && !gl);
    m.castShadow = style === 'normal' && !gl;
  }
  // 高對比的建築輪廓線較淡、較細，避免屋頂直立縫太密變成一片黑
  edgeMat.color.set(style === 'contrast' ? 0x6b7077 : 0x1f2328);
  setLineW(state.lineW);
  night.group.visible = style === 'normal';
  applyTraffic();
  [...$('styleSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.style === style));
  $('lineRow').classList.toggle('dim', style === 'normal');
}
function setLineW(v) {
  state.lineW = +v; edgeMat.linewidth = state.lineW * (state.style === 'contrast' ? 0.5 : 1); groundEdgeMat.linewidth = Math.max(1, state.lineW * 0.5);
  $('lineW').value = v; $('lineWv').textContent = v;
}

// ---------- 透視／等角（平行投影） ----------
function setProj(p) {
  state.ortho = p === 'ortho';
  renderPass.camera = viewCam();
  [...$('projSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.proj === p));
}
function syncOrtho() {
  // 平行投影的畫面高度＝透視鏡頭在目標距離處看到的高度，切換時大小不跳
  const d = camera.position.distanceTo(controls.target);
  const hh = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  orthoCam.top = hh; orthoCam.bottom = -hh; orthoCam.left = -hh * camera.aspect; orthoCam.right = hh * camera.aspect;
  const dir = camera.position.clone().sub(controls.target).normalize();
  orthoCam.position.copy(controls.target).addScaledVector(dir, d + 2000);   // 往後退，避免切掉鏡頭後方的物件
  orthoCam.quaternion.copy(camera.quaternion);
  orthoCam.near = 1; orthoCam.far = d + 2000 + 6000;
  orthoCam.updateProjectionMatrix(); orthoCam.updateMatrixWorld();
}

// ---------- 人車 ----------
function applyTraffic() {
  const on = state.traffic && state.style === 'normal';
  vehicles.setVisible(on); people.setVisible(on);
}

// ---------- 設定選單（左下） ----------
function setToggle(k, v) {
  state[k] = v;
  const cb = document.querySelector(`[data-tg="${k}"]`); if (cb) cb.checked = v;
  if (k === 'labels') { labels.visible = v; pois.visible = v; }
  if (k === 'clock') $('clock').classList.toggle('hidden', !v && !state.weather);
  if (k === 'weather') env.weatherOn = v;
  if (k === 'traffic') applyTraffic();
}
document.querySelectorAll('[data-tg]').forEach((cb) => (cb.onchange = () => setToggle(cb.dataset.tg, cb.checked)));
$('settingsBtn').onclick = () => { $('settings').classList.toggle('hidden'); $('timeSlider').classList.add('hidden'); };
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('styleSeg').onclick = (e) => { const s = e.target.dataset.style; if (s) setStyle(s); };
$('projSeg').onclick = (e) => { const p = e.target.dataset.proj; if (p) setProj(p); };
$('lineW').oninput = (e) => setLineW(e.target.value);
$('wxSeg').onclick = (e) => {
  const w = e.target.dataset.wx; if (!w) return;
  env.wxOverride = w === 'live' ? null : w;
  [...$('wxSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.wx === w));
};
$('snapBtn').onclick = snapshot;
$('presBtn').onclick = () => $('presFile').click();
$('openTime').onclick = () => { $('settings').classList.add('hidden'); $('timeSlider').classList.remove('hidden'); syncPicker(); };
setLineW(state.lineW);
$('lineRow').classList.add('dim');

// 時間選擇：時、分兩欄滾輪（24 小時制），停下來的那一格就是選到的值
const tpH = $('tpH'), tpM = $('tpM'), ROW = 40;
function buildCol(el, n) {
  el.innerHTML = '<div class="pad"></div>' + Array.from({ length: n }, (_, i) => `<div data-v="${i}">${String(i).padStart(2, '0')}</div>`).join('') + '<div class="pad"></div>';
  let tm = null;
  el.addEventListener('scroll', () => {
    const v = Math.max(0, Math.min(n - 1, Math.round(el.scrollTop / ROW)));
    el.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    el.children[v + 1]?.classList.add('sel');
    clearTimeout(tm); tm = setTimeout(applyPicker, 120);
  });
  el.addEventListener('click', (e) => { const v = e.target.dataset?.v; if (v != null) el.scrollTo({ top: +v * ROW, behavior: 'smooth' }); });
}
buildCol(tpH, 24); buildCol(tpM, 60);
let pickerSync = false;
function applyPicker() {
  if (pickerSync) return;
  const h = Math.round(tpH.scrollTop / ROW), m = Math.round(tpM.scrollTop / ROW);
  env.override = Math.min(23, h) * 60 + Math.min(59, m);
}
function syncPicker() {
  const d = env.now(), tp = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  pickerSync = true;
  tpH.scrollTop = tp.getHours() * ROW; tpM.scrollTop = tp.getMinutes() * ROW;
  setTimeout(() => (pickerSync = false), 200);
}
$('timeLive').onclick = () => { env.override = null; syncPicker(); };
$('timeDone').onclick = () => $('timeSlider').classList.add('hidden');

// ---------- 指北針（真北）、視角方塊、視角切換 ----------
// 真北：模型 +Y 軸順時針轉 northOffset_deg（預設 23°）。網頁座標：模型 +Y = −Z、+X = +X
const NORTH = THREE.MathUtils.degToRad(site.northOffset_deg ?? 23);
const northDir = new THREE.Vector3(Math.sin(NORTH), 0, -Math.cos(NORTH));
function viewYaw(dirFromTarget) { return Math.atan2(dirFromTarget.x, dirFromTarget.z); }
$('compass').onclick = () => {
  // 轉到「真北朝上」：鏡頭放在目標的南邊（沿真北反方向），保持目前的俯角與距離
  const t = controls.target, d = camera.position.clone().sub(t);
  const r = Math.hypot(d.x, d.z);
  flyTo(t.clone().add(new THREE.Vector3(-northDir.x * r, d.y, -northDir.z * r)), t.clone(), 900);
};
// 依建築 X-Y-Z 軸的視角：dir 為「從目標指向鏡頭」的方向（模型座標 X, Y, Z）
function viewFromModelDir(X, Y, Z, ms = 1000) {
  const t = controls.target.clone(), d = camera.position.distanceTo(t);
  let dir = new THREE.Vector3(X, Z, -Y).normalize();
  if (X === 0 && Y === 0) dir = new THREE.Vector3(0, 1, 0.0015).normalize();   // 俯視：模型 +Y 朝畫面上方
  if (Math.abs(Z) < 1e-6) dir.y = 0.012;                                    // 立面：接近水平
  flyTo(t.clone().addScaledVector(dir.normalize(), d), t, ms);
}
const VIEWS = { top: [0, 0, 1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

// CSS 3D 視角方塊：面＝俯視／四向立面，上方四個角＝等角視角
const cubeCam = $('cubeCam'), S = 46;
function cssM(m) { const e = m.elements; return 'translate(-50%,-50%) matrix3d(' + [e[0], e[1], e[2], e[3], -e[4], -e[5], -e[6], -e[7], e[8], e[9], e[10], e[11], e[12], e[13], e[14], e[15]].join(',') + ')'; }
function addCubePart(el, pos, lookN, onClick) {
  const o = new THREE.Object3D(); o.position.copy(pos);
  if (lookN && Math.abs(lookN.y) > 0.99) o.rotation.x = -Math.sign(lookN.y) * Math.PI / 2;   // 上下面：文字朝北
  else if (lookN) o.lookAt(pos.clone().add(lookN));
  o.updateMatrixWorld(); el.style.transform = cssM(o.matrixWorld);
  if (onClick) el.onclick = onClick;
  cubeCam.appendChild(el);
}
// 面（網頁座標的法向）：+Y 上、−Z 北(+Y)、+Z 南(−Y)、+X 東、−X 西
const faces = [
  ['上', '+Z', new THREE.Vector3(0, 1, 0), 'top'], ['南', '−Y', new THREE.Vector3(0, 0, 1), 'front'], ['北', '+Y', new THREE.Vector3(0, 0, -1), 'back'],
  ['東', '+X', new THREE.Vector3(1, 0, 0), 'right'], ['西', '−X', new THREE.Vector3(-1, 0, 0), 'left'], ['下', '−Z', new THREE.Vector3(0, -1, 0), null],
];
for (const [t, ax, n, v] of faces) {
  const el = document.createElement('div'); el.className = 'cf'; el.innerHTML = `${t}<small>${ax}</small>`;
  addCubePart(el, n.clone().multiplyScalar(S / 2), n, v ? () => viewFromModelDir(...VIEWS[v]) : null);
}
// 上方四個角：等角視角（模型 X±、Y±、Z+）
for (const [X, Y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
  const el = document.createElement('div'); el.className = 'cc'; el.title = '等角視角';
  const p = new THREE.Vector3(X, 1, -Y).multiplyScalar(S / 2 + 1);
  addCubePart(el, p, p.clone().normalize(), () => viewFromModelDir(X, Y, 1));
}
// 底下四個角也可點（從下方看的等角視角不實用，這裡只做上方四角）
// 座標軸（建築 X 紅、Y 綠、Z 藍），從方塊左前下角伸出
const axesSvg = $('cubeAxes');
const AX = [['X', new THREE.Vector3(1, 0, 0), '#d93025'], ['Y', new THREE.Vector3(0, 0, -1), '#188038'], ['Z', new THREE.Vector3(0, 1, 0), '#1a73e8']];
function updateCube(cam) {
  const m = new THREE.Matrix4().extractRotation(cam.matrixWorldInverse), e = m.elements;
  cubeCam.style.transform = 'matrix3d(' + [e[0], -e[1], e[2], e[3], e[4], -e[5], e[6], e[7], e[8], -e[9], e[10], e[11], 0, 0, 0, 1].join(',') + ')';
  // 把世界向量投影到方塊畫面（與 CSS 3D 相同的正交投影）
  const pr = (v) => { const w = v.clone().applyMatrix4(m); return [w.x, -w.y]; };
  const o = new THREE.Vector3(-S / 2, -S / 2, S / 2), [ox, oy] = pr(o);
  let h = '';
  for (const [n, d, c] of AX) {
    const [x, y] = pr(o.clone().addScaledVector(d, S + 8)), [lx, ly] = pr(o.clone().addScaledVector(d, S + 16));
    h += `<line x1="${ox}" y1="${oy}" x2="${x}" y2="${y}" stroke="${c}" stroke-width="2" stroke-linecap="round"/><text x="${lx}" y="${ly}" fill="${c}">${n}</text>`;
  }
  axesSvg.innerHTML = h;
}
$('cubeHome').onclick = () => flyTo(cm2w(sc.pos_cm || [2000, -12000, 16000]), cm2w(sc.target_cm || [13700, 15300, 0]), 1200);

// ---------- 鏡頭動畫 ----------
let fly = null;
function flyTo(pos, target, ms = 1600) {
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, t: 0, ms };
}

// ---------- 簡報模式 ----------
// txt 格式：
//   NKCA1:xxxx     ← 一頁（由「複製代碼」取得）
//   # 標題          ← H1
//   ## 副標         ← H2
//   一般文字        ← 內文（可多行）
//   // 註記        ← 不顯示（頁次、提醒）
// 文字只在這次簡報顯示，不會存在瀏覽器裡。
function snapshot() {
  const s = {
    v: 2, c: w2cm(camera.position), t: w2cm(controls.target), m: state.mode, h: state.halls,
    ui: { labels: state.labels, clock: state.clock, weather: state.weather, traffic: state.traffic },
    style: state.style, lw: state.lineW, proj: state.ortho ? 'ortho' : 'persp',
    tod: env.override, card: labels.openId(),
  };
  const code = 'NKCA1:' + btoa(unescape(encodeURIComponent(JSON.stringify(s))));
  navigator.clipboard?.writeText(code);
  toast('已複製簡報代碼（貼到記事本，一頁一行）：\n' + code, 6000);
}
function decode(code) {
  try { return JSON.parse(decodeURIComponent(escape(atob(code)))); } catch { return null; }
}
function parseDeck(txt) {
  const cues = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^NKCA1:([A-Za-z0-9+/=]+)/);
    if (m) { const s = decode(m[1]); if (s) { cur = { ...s, h1: '', h2: '', p: [] }; cues.push(cur); } continue; }
    if (!cur || !line || line.startsWith('//')) continue;
    if (line.startsWith('## ')) cur.h2 = line.slice(3).trim();
    else if (line.startsWith('# ')) cur.h1 = line.slice(2).trim();
    else cur.p.push(line);
  }
  return cues;
}
const pres = { cues: [], i: 0 };
$('presFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  startDeck(await f.text());
};
// 教學代碼：輸入「newbie」→ 讀取 GitHub 上的 lessons/newbie.txt 並開始播放
$('lessonForm').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('lessonCode').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!code) return;
  try {
    const r = await fetch(`lessons/${code}.txt`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    startDeck(await r.text());
  } catch { toast(`找不到教學代碼「${code}」`); }
};
function startDeck(txt) {
  pres.cues = parseDeck(txt);
  if (!pres.cues.length) { toast('檔案中沒有可用的簡報代碼'); return; }
  $('settings').classList.add('hidden');
  state.presenting = true; document.body.classList.add('presenting');
  $('presBar').classList.remove('hidden'); renderLiftPanel(true);
  goCue(0);
}
function showPresText(s) {
  const box = $('presText'), has = s.h1 || s.h2 || s.p.length;
  box.classList.add('fade');
  setTimeout(() => {
    box.querySelector('h1').textContent = s.h1 || '';
    box.querySelector('h2').textContent = s.h2 || '';
    const pt = box.querySelector('.pt'); pt.innerHTML = '';
    for (const t of s.p) { const p = document.createElement('p'); p.textContent = t; pt.appendChild(p); }
    box.classList.toggle('hidden', !has);
    requestAnimationFrame(() => box.classList.remove('fade'));
  }, 250);
}
function goCue(i) {
  pres.i = Math.max(0, Math.min(pres.cues.length - 1, i));
  const s = pres.cues[pres.i];
  $('presIdx').textContent = `${pres.i + 1}/${pres.cues.length}`;
  if (s.m) setMode(s.m, true);
  if (s.h) for (const h of halls) if (s.h[h.id]) setHallFloor(h, s.h[h.id]);
  for (const [k, v] of Object.entries(s.ui || {})) if (k in state) setToggle(k, v);
  setStyle(s.style || (s.ui?.wire ? 'wire' : s.ui?.contrast ? 'contrast' : 'normal'));
  if (s.lw) setLineW(s.lw);
  setProj(s.proj || 'persp');
  env.override = s.tod ?? null;
  if (s.card) labels.openById(s.card); else labels.close();
  showPresText(s);
  flyTo(cm2w(s.c), cm2w(s.t));
}
function exitPres() {
  state.presenting = false; document.body.classList.remove('presenting');
  $('presBar').classList.add('hidden'); $('presText').classList.add('hidden'); renderLiftPanel(true);
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
  const pr = renderer.getPixelRatio();
  edgeMat.resolution.set(w * pr, h * pr); groundEdgeMat.resolution.set(w * pr, h * pr);
}
addEventListener('resize', resize); resize();

const clock = new THREE.Clock();
const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const BH = lightsCfg.buildingHours || {};
function buildingOpen(d) {
  if (!BH.off) return true;
  const tp = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })), m = tp.getHours() * 60 + tp.getMinutes();
  const on = hm(BH.on ?? '05:00'), off = hm(BH.off);
  return on < off ? m >= on && m < off : m >= on || m < off;
}
let venueK = 1;
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
  camera.updateMatrixWorld();
  if (state.ortho) syncOrtho();
  const cam = viewCam();
  env.focus = camera.position;
  env.update(dt);
  const plain = state.contrast || state.wire;
  if (plain) { scene.background = new THREE.Color(0xffffff); env.sky.visible = env.dome.visible = env.stars.visible = false; scene.fog.density = 0; }
  // 高對比／線架構不做色調映射，白就是純白（OutputPass 依 renderer.toneMapping 決定）
  renderer.toneMapping = plain ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  const n = plain ? 0 : env.night;
  // 建築燈光營運時間（config/lights.json 的 buildingHours）：23:00 熄燈，路燈、車燈、道路標線不受影響
  venueK += ((buildingOpen(env.now()) ? 1 : 0) - venueK) * Math.min(1, dt * 1.5);
  night.update(n, n * venueK);
  bloom.strength = n * 0.9;
  fountain?.update(t, env.now(), n);
  vehicles.update(dt, n);
  people.update(dt);
  for (let i = lifts.length - 1; i >= 0; i--) {
    const L = lifts[i]; L.t = Math.min(1, L.t + dt / 1.2);
    const f = halls.flatMap((h) => h.floorsM).find((x) => x.showM(L.m.userData.fname));
    L.m.position.y = L.m.userData.y0 - (f?.lift_m || 0) * (1 - ease(L.t));
    if (L.t >= 1) lifts.splice(i, 1);
  }
  composer.render();
  labels.update(cam, innerWidth, innerHeight);
  pois.update(cam, innerWidth, innerHeight);
  updateCube(camera);
  if (t - lastUI > 0.2) {
    lastUI = t;
    const d = env.now();
    const tp = d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    $('clockTime').textContent = state.clock ? tp : '';
    $('clockDate').textContent = state.clock ? d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'short' }) : '';
    $('weather').textContent = state.weather ? env.weatherText() : '';
    $('clock').classList.toggle('hidden', !state.clock && !state.weather);
    $('timeLabel').textContent = env.override != null ? '手動 ' + tp : '即時';
    renderLiftPanel(false);
    document.body.classList.toggle('night', env.night > 0.5 && !plain);
  }
  // 指北針：真北方向相對於畫面「往前」的角度（順時針為正）
  const f = controls.target.clone().sub(camera.position); f.y = 0;
  if (f.lengthSq() < 1e-8) f.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
  f.normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  // 俯視時「往前」以鏡頭的上方向為準
  if (camera.position.clone().sub(controls.target).normalize().y > 0.995) {
    f.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0).normalize(); r.crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  }
  const ang = Math.atan2(northDir.dot(r), northDir.dot(f));
  $('compassRose').style.transform = `rotate(${THREE.MathUtils.radToDeg(ang)}deg)`;
});

// 開發者用：在主控台 window.nkca 可以查物件
window.nkca = { scene, camera, orthoCam, controls, model, env, state, setMode, setStyle, setProj, flyTo, fountain, night, vehicles, people, renderer, labels, viewFromModelDir };
