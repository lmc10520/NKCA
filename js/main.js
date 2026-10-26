import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
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
import { PlanOverlay, ScreenOverlay } from './overlay.js';
import { Festival } from './festival.js';
import { Piano } from './piano.js';
import { Soundscape } from './soundscape.js';
import { Horizon, siteRect } from './horizon.js';
import { Section } from './section.js';
import { HIGH, quality, qualityPref, setQualityPref, TONE, FinalPass, AdaptiveRes } from './look.js';

const $ = (id) => document.getElementById(id);

// ---------- 載入進度：數字平滑往上跳 ----------
const load = { shown: 0, target: 0 };
function setLoad(pct, text) { load.target = Math.max(load.target, Math.min(100, pct)); if (text) $('loadText').textContent = text; }
(function tickLoad() {
  if ($('loading').classList.contains('hidden')) return;
  load.shown += (load.target - load.shown) * 0.18;
  if (load.target - load.shown < 0.4) load.shown = load.target;
  $('loadPct').firstChild.nodeValue = Math.floor(load.shown);
  $('loadBar').style.width = load.shown.toFixed(1) + '%';
  requestAnimationFrame(tickLoad);
})();
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // 讓畫面有機會更新數字
setLoad(2, '讀取設定…');

// ---------- 設定 ----------
const [site, modesCfg, lightsCfg, coresCfg, hallsCfg, labelsCfg, screensCfg, roadsCfg, fountainCfg, lawnsCfg, peopleCfg, streetCfg, poisCfg, festCfg, overviewCfg, pianoCfg, soundCfg] =
  await Promise.all(['site', 'modes', 'lights', 'cores', 'halls', 'labels', 'screens', 'roads', 'fountain', 'lawns', 'walk', 'streetlights', 'pois', 'festivals', 'overview', 'piano', 'soundscape']
    .map((n) => loadJSON(`config/${n}.json`, {})));
document.title = site.title || document.title;

// ---------- 場景 ----------
const canvas = $('view');
// 對數深度緩衝很吃 GPU（每個像素自己寫深度、關掉提前剔除），屋頂、玻璃邊緣也容易顫動；
// 預設改用一般深度緩衝＋「依鏡頭距離調整 near」維持精度（見迴圈），只有高畫質才開。
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: HIGH, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
const MAX_PR = Math.min(devicePixelRatio, isMobile ? 1.5 : 2);
renderer.setPixelRatio(MAX_PR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = TONE;   // Khronos PBR Neutral（look.js），保留材質原色，不像 ACES 那樣灰灰的
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = !!site.shadows && HIGH;   // 陰影只在高畫質
renderer.localClippingEnabled = true;   // 剖面（js/section.js）
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

// 後製只在需要時使用（夜間光暈、線稿＋網點）；平常直接畫到畫面，畫面有原生反鋸齒、也省一張浮點貼圖。
// 後製用的貼圖在桌機開 4× MSAA，否則經過後製的畫面會有鋸齒。
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth * MAX_PR, innerHeight * MAX_PR,
  { type: THREE.HalfFloatType, samples: isMobile || !renderer.capabilities.isWebGL2 ? 0 : 4 }));
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
// 夜間光暈（bloom）：比 threshold 亮的地方（燈具、車燈、號誌）向外暈開。site.json 的 bloom：
// strength 強度（夜晚全暗時）、radius 擴散範圍 0–1、threshold 門檻（1＝比白色還亮才發光）；設 false 關閉
const BL = typeof site.bloom === 'object' ? site.bloom : {};
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, BL.radius ?? 0.4, BL.threshold ?? 1.0);
const useBloom = site.bloom !== false && BL.enabled !== false;   // 預設與高畫質都有（白天自動跳過，不耗效能）
if (useBloom) composer.addPass(bloom);
const finalPass = new FinalPass();
composer.addPass(finalPass);

const env = new Environment(scene, renderer, site);
// 環境反射：讓玻璃、金屬有反光，白牆有柔和的環境光（取代一部分平板的半球光），質感差最多的地方
{
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pm.dispose();
}
const ENV_K = site.envIntensity ?? 0.25;

// ---------- 模型 ----------
setLoad(5, '下載模型…');
// 沒有檔案大小資訊時，用 site.json 的 modelBytes（約 8.8 MB）估算
// 預設載入減面模型（site.json 的 modelLite，由 tools/build_lite.mjs 產生）；高畫質或讀不到時用原模型
const modelURL = !HIGH && site.modelLite ? site.modelLite : site.model || 'model/nkca.glb';
const modelBytes = !HIGH && site.modelLite ? site.modelLiteBytes : site.modelBytes;
const onModelProgress = (loaded, total) =>
  setLoad(5 + 75 * Math.min(1, loaded / (total || modelBytes || 9e6)), loaded >= (total || Infinity) ? '解析模型…' : '下載模型…');
const model = await loadModel(modelURL, onModelProgress).catch((e) => {
  if (modelURL === (site.model || 'model/nkca.glb')) throw e;
  console.warn('[model] 讀不到減面模型，改用原模型', e);
  return loadModel(site.model || 'model/nkca.glb', onModelProgress);
});
setLoad(82, '整理模型…'); await paint();
scene.add(model.root);
const exclude = makeMatcher(modesCfg.exclude, modesCfg.groups);
for (const m of model.meshes) if (exclude(m.userData.fname)) { m.visible = false; m.userData.excluded = true; }

// 材質統一：config/site.json 的 materialFrom 指定「名稱規則 → 參照物件」，網頁直接套用參照物件的材質
for (const [pat, ref] of Object.entries(site.materialFrom || {})) {
  if (pat.startsWith('_')) continue;
  const src = model.meshes.find((m) => m.userData.fname === ref);
  if (!src) continue;
  const re = new RegExp(pat);
  for (const m of model.meshes) if (m !== src && re.test(m.userData.fname) && !m.userData.faceOverride) { m.material = src.material; m.userData.origMaterial = src.material; }
}
// 色盤：site.json 的 materialColor 指定「材質名稱 → 顏色」，覆蓋 Fusion 匯出的顏色（草地、植栽等原本偏灰、偏土）
{
  const pal = Object.entries(site.materialColor || {}).filter(([k]) => !k.startsWith('_'));
  const done = new Set();
  for (const m of model.meshes) {
    const mt = m.material; if (done.has(mt)) continue; done.add(mt);
    const hit = pal.find(([k]) => mt.name === k); if (!hit) continue;
    mt.color.set(hit[1]); if (mt.userData.base) mt.userData.base.color.copy(mt.color);
  }
}
// 屋頂直立縫（Seam_*）：法線朝上後和屋面受光一樣，線條會淡掉，所以另外給較深的顏色（site.json 的 seamColor）
if (site.seamColor) {
  const seamMats = new Map();
  for (const m of model.meshes) {
    if (!/^Seam/.test(m.userData.fname)) continue;
    let mt = seamMats.get(m.material);
    if (!mt) { mt = m.material.clone(); mt.name = 'Seam_Color'; mt.color.set(site.seamColor); seamMats.set(m.material, mt); }
    m.material = mt; m.userData.origMaterial = mt;
  }
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
// 剖面只切建築：符合 section.keep 的物件不切。預設只保留基地外圍的 Site_ 地面（道路、草地、鋪面），
// 榕樹廣場地坪、戶外劇場座席、停車場坡道／卸貨碼頭的牆（Site_Ramp_／Site_Parking_／Site_Dock_）、之後的地下樓層都會切
const keepRe = new RegExp(site.section?.keep || '^Site_(?!Ramp_|Parking_|Dock_)');
const isCut = (m) => !m.userData.excluded && !keepRe.test(m.userData.fname);
// 裁切設定在材質上：不切的物件若和建築共用材質，給它自己的一份（否則地面會跟著被切）
{
  const cutMats = new Set(model.meshes.filter(isCut).map((m) => m.material));
  const clones = new Map();
  for (const m of model.meshes) {
    if (isCut(m) || !cutMats.has(m.material)) continue;
    let c = clones.get(m.material);
    if (!c) { c = m.material.clone(); clones.set(m.material, c); }
    m.material = c; m.userData.origMaterial = c;
  }
}
// 建築是靜態的：不必每幀重算每個物件的矩陣（樓層升起動畫會自己更新）
model.root.updateMatrixWorld(true);
model.root.traverse((o) => { o.matrixAutoUpdate = false; });
env.setRoofMap(model.meshes);   // 雨、雪在屋頂底下不畫
// 環境反射強度（夜間調低）：收集所有會用到環境貼圖的材質
const envMats = new Set();

setLoad(86, '佈置夜間燈光…'); await paint();
const night = new NightLights(scene, model, lightsCfg, lawnsCfg);
// 剖面：建築材質登記（夜間燈光會替玻璃等換成各自的材質，所以在它之後）
const section = new Section({ model, cfg: site.section, isCut, scene });
for (const m of model.meshes) if (isCut(m)) section.register(m.userData.origMaterial);
// 地平線：基地外延伸的地坪＋地平線霧帶（site.json 的 horizon）
const rect = site.horizon?.enabled === false ? null : siteRect(model);
const horizon = rect ? new Horizon(scene, rect, site.horizon) : null;
section.addBase(scene, rect || siteRect(model), site.section?.baseColor);   // 屋頂投射燈、廣場面光源都開
for (const m of model.meshes) { const mt = m.userData.origMaterial; if (mt?.isMeshStandardMaterial) envMats.add(mt); }
let envKNow = -1, nightNow = -1;
function setEnvK(k) {
  if (Math.abs(k - envKNow) < 0.01) return; envKNow = k;
  for (const mt of envMats) mt.envMapIntensity = k * (mt.userData.isGlassMat ? 2.2 : 1);
}
// 夜間降低彩度：月光下顏色會變淡（原本 ACES 色調映射會順便做到，Neutral 不會），草地才不會晚上還是鮮綠色
const baseCol = new Map([...envMats].map((mt) => [mt, mt.color.clone()]));
const NIGHT_DESAT = site.nightDesaturate ?? 0.6;
function setNightTint(n) {
  if (Math.abs(n - nightNow) < 0.01) return; nightNow = n;
  const k = n * NIGHT_DESAT, g = new THREE.Color();
  for (const [mt, c] of baseCol) { const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; mt.color.copy(c).lerp(g.setRGB(l, l, l), k); }
}
night.addStreetLights(streetCfg);
setLoad(93, '加入人車與噴泉…'); await paint();
const fountain = fountainCfg?.nozzles ? new Fountain(scene, fountainCfg) : null;
const vehicles = new Vehicles(scene, roadsCfg, lightsCfg.vehicles, model);
const people = new People(scene, peopleCfg);
const screens = buildScreens(scene, screensCfg);
const festival = new Festival(scene, festCfg, model);
const piano = new Piano(scene, pianoCfg);
piano.onMessage = (t) => toast(t, 4000);
// 車輛、行人、路燈、鋼琴、節慶物件等的材質也納入環境反射的晝夜調整（否則晚上車身會亮到發光）
scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const mt of Array.isArray(o.material) ? o.material : [o.material]) if (mt?.isMeshStandardMaterial) envMats.add(mt);
});
envKNow = -1;
// 建築聲景：依空間播放環境音；鋼琴彈奏時自動降低（ducking）
const soundscape = new Soundscape(soundCfg);
piano.onState = (on) => soundscape.duck(on);
piano.muted = !soundscape.on;
const labels = new Labels(labelsCfg, model);
const pois = new Pois(poisCfg, model, labels);
const plan = new PlanOverlay(scene, renderer, site);
const parkingPlan = new PlanOverlay(scene, renderer, site);   // B1／B2 地板上的停車場平面圖
parkingPlan.onError = (src) => toast(`讀不到停車場平面圖 ${decodeURIComponent(src.split('/').pop())}`);
let parkingKey = '';
plan.onError = (src) => toast(`讀不到圖層 ${decodeURIComponent(src.split('/').pop())}`);
const screenLayer = new ScreenOverlay($('screenLayers'));
screenLayer.onError = plan.onError;
setLoad(100, '完成'); await paint(); await new Promise((r) => setTimeout(r, 250));
$('loading').classList.add('hidden');

// ---------- 可見性：模式 + 廳院樓層 ----------
const state = {
  mode: modesCfg.default || 'exterior', halls: {}, clock: true, weather: true, labels: true, traffic: true,
  style: 'normal', contrast: false, wire: false, ortho: false, lineW: 2,
  venue: null,   // 場館燈光：null＝依營運時間自動，true／false＝手動開／關
  festival: true,   // 節慶物件（檔期內才有）
};
const modeHide = {};
for (const m of modesCfg.modes || []) modeHide[m.id] = makeMatcher(m.hide, modesCfg.groups);
const halls = (hallsCfg.halls || []).map((h) => ({ ...h, panelModes: h.panelModes || h.modes, floorsM: h.floors.filter((f) => f.action !== 'mode').map((f) => ({ ...f, hideM: makeMatcher(f.hide, modesCfg.groups), showM: makeMatcher(f.show, modesCfg.groups) })) }));
halls.forEach((h) => (state.halls[h.id] = h.default));

function meshVisible(n) {
  if (modeHide[state.mode]?.(n)) return false;
  for (const h of halls) {
    if (h.modes && !h.modes.includes(state.mode)) continue;
    const f = h.floorsM.find((x) => x.id === state.halls[h.id]);
    if (f?.hideM(n)) return false;
  }
  return true;
}
function applyVisibility() {
  for (const m of model.meshes) {
    if (m.userData.excluded) continue;
    m.visible = meshVisible(m.userData.fname);
  }
  night.roofOn = !!model.byName.get('Roof_Main')?.some((m) => m.visible);
  // 地下停車場（B1／B2）：地面上的螢幕／貼紙、公共鋼琴、節慶物件、站在建築上方的行人收起來；車輛換成進出停車場的路線，
  // 地面車輛停在坡道上蓋前、不開到坡道正上方
  const under = !!modesCfg.modes.find((x) => x.id === state.mode)?.underground;
  screens.visible = !under;
  if (under && piano.playing) piano.stop();
  piano.group.visible = !under;
  festival.hidden = under;
  people.setHidden(under ? modesCfg.undergroundHide_cm : null);
  vehicles.setMode(state.mode, under);
  showParkingPlan();
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
  if (m.button === false) continue;   // B1、B2 地下停車場：由電梯／廳院樓層按鈕切換
  const b = document.createElement('button'); b.textContent = m.label; b.dataset.mode = m.id;
  b.onclick = () => setMode(m.id); $('modeBar').appendChild(b);
}
// 地下停車場平面圖：B1／B2 模式時把 parking_B1／B2.svg 貼在該層地板上（modes.json 的 plan）
function showParkingPlan() {
  const m = modesCfg.modes.find((x) => x.id === state.mode), L = m?.plan;
  const key = L ? L.src : '';
  if (key === parkingKey) return;
  parkingKey = key;
  parkingPlan.show(L ? [{ ...L, depth: true }] : []);
}

// 廳院樓層升起／降下動畫：切到有 lift_m 的樓層時，新出現的物件從下方升起；離開該樓層時，要收起的物件先降下再隱藏
const lifts = [];
function liftTo(m, to, hideEnd) {
  m.userData.y0 ??= m.position.y;
  const i = lifts.findIndex((L) => L.m === m); if (i >= 0) lifts.splice(i, 1);
  lifts.push({ m, from: m.position.y - m.userData.y0, to, hideEnd, t: 0 });
}
function setHallFloor(h, fid) {
  const prev = h.floorsM.find((x) => x.id === state.halls[h.id]);
  const was = new Set(model.meshes.filter((m) => m.visible));
  state.halls[h.id] = fid;
  if (h.modes && !h.modes.includes(state.mode)) setMode(h.modes[0], true); else applyVisibility();
  const f = h.floorsM.find((x) => x.id === fid);
  if (f?.lift_m) {
    for (const m of model.meshes) {
      if (!f.showM(m.userData.fname) || !m.visible) continue;
      if (!was.has(m)) { m.userData.y0 ??= m.position.y; m.position.y = m.userData.y0 - f.lift_m; m.updateMatrix(); liftTo(m, 0); }
      else if (lifts.some((L) => L.m === m && L.hideEnd)) liftTo(m, 0);   // 降到一半又切回來：從目前位置升回去
    }
  }
  if (prev?.lift_m && prev !== f) {
    for (const m of was) if (!m.visible && prev.showM(m.userData.fname)) { m.visible = true; liftTo(m, -prev.lift_m, true); }
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
  if (type === 'hall' && c.panelModes && !c.panelModes.includes(state.mode)) setMode(c.modes[0]);
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
    if (Math.hypot(p.x - t.x, p.z - t.z) < (liftPin.c.radius_cm / 100) * 2 && !(liftPin.c.panelModes && !liftPin.c.panelModes.includes(state.mode))) return liftPin;
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
    if (h.panelModes && !h.panelModes.includes(state.mode)) continue;
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
  const cur = currentCoreFloor(n.c) ?? (n.type === 'hall' ? state.halls[n.c.id] : null);
  for (const f of n.c.floors) {
    const b = document.createElement('button'); b.textContent = f.id; b.classList.toggle('on', f.id === cur);
    b.onclick = () => (n.type === 'hall' && f.action !== 'mode' ? setHallFloor(n.c, f.id) : coreAction(n.c, f));
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
    ray.setFromCamera(ndc(e), viewCam());
    if (pianoAt(e.clientX, e.clientY)) { piano.toggle(); setPianoHover(false); return; }   // 點鋼琴：路人坐下來彈
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
  navigator.clipboard?.writeText(line)?.catch(() => {});
  toast(`已複製（${hit.object.userData.fname}）：\n${line}`, 6000);
});

// ---------- 公共鋼琴：看得出可以點 ----------
// 滑鼠：pointermove 節流（約 60 ms 一次）做 raycast，移到鋼琴上時游標變手形、鋼琴發光、游標旁跳出提示。
// 手機（沒有 hover）：鏡頭靠近、看得到鋼琴時，在鋼琴上方常駐一個小提示，點提示或鋼琴都可以。
// 被建築擋住（例如外觀模式的屋頂）時不算點到鋼琴。
const occluders = () => model.meshes.filter((m) => m.visible && !m.userData.isGlass);
function blockedBefore(dist) {
  ray.far = Math.max(0, dist - 0.05);
  const hit = ray.intersectObjects(occluders(), false).length > 0;
  ray.far = Infinity;
  return hit;
}
function pianoAt(cx, cy) {
  if (!piano.cfg.pos_cm) return false;
  ray.setFromCamera(ndc({ clientX: cx, clientY: cy }), viewCam());
  const d = piano.hitDist(ray);
  return d != null && !blockedBefore(d);
}
const tip = $('pianoTip'), tipText = tip.querySelector('.t');
const tipMsg = () => (!piano.playing ? '點擊公共鋼琴，看看誰來彈鋼琴！' : piano.audio.paused ? '點擊繼續演奏' : '點擊暫停演奏');
const hover = { x: 0, y: 0, on: false, last: 0, timer: 0, buttons: 0 };
const noHover = matchMedia('(hover: none)').matches || (isMobile && !matchMedia('(hover: hover)').matches);
function setPianoHover(on) {
  if (hover.on === on) { if (on) placeTipAtCursor(); return; }
  hover.on = on; piano.setHover(on);
  canvas.style.cursor = on ? 'pointer' : '';
  tip.classList.remove('anchor');
  tip.classList.toggle('hidden', !on);
  if (on) { tipText.textContent = tipMsg(); placeTipAtCursor(); }
}
function placeTipAtCursor() {
  const w = tip.offsetWidth || 240, x = Math.min(hover.x + 16, innerWidth - w - 8), y = Math.min(hover.y + 20, innerHeight - 44);
  tip.style.transform = `translate(${x}px,${y}px)`;
}
function checkHover() {
  hover.timer = 0; hover.last = performance.now();
  if (hover.buttons || fly || welcome.on) { setPianoHover(false); return; }   // 拖曳中、鏡頭飛行中、迎賓模式不判斷
  setPianoHover(pianoAt(hover.x, hover.y));
}
function queueHover() {
  if (hover.timer) return;
  hover.timer = setTimeout(checkHover, Math.max(0, 60 - (performance.now() - hover.last)));
}
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;   // 觸控、觸控筆沒有 hover
  hover.x = e.clientX; hover.y = e.clientY; hover.buttons = e.buttons;
  if (hover.on && !e.buttons) placeTipAtCursor();   // 提示跟著游標，判斷本身節流
  queueHover();
});
canvas.addEventListener('pointerleave', () => { clearTimeout(hover.timer); hover.timer = 0; setPianoHover(false); });
canvas.addEventListener('wheel', () => { if (hover.on || hover.x) queueHover(); }, { passive: true });
// 手機：常駐提示（每 0.3 秒判斷一次要不要顯示，位置每幀跟著鋼琴）
const hint = { on: false, last: 0, v: new THREE.Vector3() };
const HINT_DIST = pianoCfg.hint_m ?? 90;
function updatePianoHint(t) {
  if (!noHover || !piano.cfg.pos_cm) return;
  if (t - hint.last > 0.3) {
    hint.last = t;
    let on = !piano.playing && !state.presenting && !welcome.on && !fly;
    if (on) {
      const top = piano.top(hint.v), d = camera.position.distanceTo(top);
      const p = top.clone().project(viewCam());
      on = d < HINT_DIST && p.z < 1 && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.85;
      if (on) { ray.set(camera.position, top.clone().sub(camera.position).normalize()); on = !blockedBefore(d); }
    }
    if (on !== hint.on) {
      hint.on = on; piano.setHint(on);
      tip.classList.toggle('anchor', on); tip.classList.toggle('hidden', !on);
      if (on) tipText.textContent = tipMsg();
    }
  }
  if (hint.on) {
    const p = piano.top(hint.v).project(viewCam());
    tip.style.transform = `translate(${((p.x + 1) / 2) * innerWidth}px,${((1 - p.y) / 2) * innerHeight}px) translate(-50%,calc(-100% - 10px))`;
  }
}
tip.addEventListener('click', () => { if (hint.on) { piano.toggle(); hint.last = 0; } });
tip.addEventListener('pointerdown', (e) => e.stopPropagation());

// ---------- 建築聲景：開關按鈕、設定、第一次互動解鎖提示 ----------
function renderSound(st = soundscape.state) {
  const b = $('soundBtn');
  b.querySelector('.ms').textContent = st.on ? 'volume_up' : 'volume_off';
  b.classList.toggle('off', !st.on);
  b.classList.toggle('locked', st.on && !st.unlocked);
  b.title = st.on ? (st.unlocked ? '關閉環境聲音' : '點一下開啟環境聲音') : '開啟環境聲音（建築聲景）';
  $('soundSw').checked = st.on;
  $('soundVol').value = st.volume; $('soundVolV').textContent = Math.round(st.volume * 100);
  $('soundHint').classList.toggle('hidden', !(st.on && !st.unlocked) || soundHintGone);
  piano.muted = !st.on;
}
let soundHintGone = false;
setTimeout(() => { soundHintGone = true; $('soundHint').classList.add('hidden'); }, 12000);   // 提示 12 秒後自己收起來
soundscape.onChange = renderSound;
function soundZoneText() {
  const st = soundscape.state;
  if (!st.on) return '已關閉';
  if (!st.unlocked) return '點一下畫面後開始播放';
  if (soundscape.ducked && !soundscape.duckCfg.level) return '鋼琴演奏中，環境音暫停';
  const names = [st.zone?.name, ...st.layers.map((z) => z.name)].filter(Boolean);
  let t = names.length ? '目前：' + names.join('＋') : '目前沒有可播放的音檔';
  if (st.wanted) t += `\n（${st.wanted.name}：${st.wanted.folder}/ 尚無音檔）`;
  return t;
}
$('soundBtn').onclick = (e) => {
  e.stopPropagation();
  if (soundscape.on && !soundscape.unlocked) { soundscape.unlock(); toast('建築聲景：開'); }
  else { soundscape.setOn(!soundscape.on); toast(soundscape.on ? '建築聲景：開' : '建築聲景：關（鋼琴也會靜音）'); }
  renderSound();
};
$('soundBtn').addEventListener('pointerdown', (e) => e.stopPropagation());
$('soundSw').onchange = (e) => { soundscape.setOn(e.target.checked); renderSound(); };
$('soundVol').oninput = (e) => { soundscape.setVolume(e.target.value); $('soundVolV').textContent = Math.round(e.target.value * 100); };
renderSound();

// ---------- 模型樣式：彩色／彩色＋線／白模／線稿／線稿＋網點 ----------
// normal 彩色、colorline 彩色＋線、contrast 白模（白色有明暗＋淡輪廓線）、wire 線稿（只有看得到的邊）、
// tone 線稿＋網點（白模的明暗經後製換成漫畫網點，陰影也是網點）。
// 白模／線稿／網點用固定的「攝影棚光」（site.json 的 studioLight），不受時間、天氣影響，教材截圖每次都一樣。
const STYLES = ['normal', 'colorline', 'contrast', 'wire', 'tone'];
const isPlain = (st) => st === 'contrast' || st === 'wire' || st === 'tone';
const isColor = (st) => st === 'normal' || st === 'colorline';
const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
const groundMat = new THREE.MeshLambertMaterial({ color: 0xeceef1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
const glassMat = new THREE.MeshLambertMaterial({ color: 0xbcd7e6, transparent: true, opacity: 0.35, depthWrite: false });
// 線架構＝只顯示看得到的邊：面用不透明白色、往後推一點先寫入深度，把後面的邊遮住
const hiddenFaceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
const hiddenFaceGroundMat = hiddenFaceMat.clone();   // 地面用（剖面不切）
// 粗線（LineSegments2）：線寬以螢幕像素計，可在設定中調整
const edgeMat = new LineMaterial({ color: 0x1f2328, linewidth: state.lineW, worldUnits: false });
const groundEdgeMat = new LineMaterial({ color: 0x9aa0a6, linewidth: 1, worldUnits: false });
// 會被剖面切到的地坪（榕樹廣場等）用同樣外觀的另一份材質，才不會連基地外的道路草地一起切
const groundCutMat = groundMat.clone(), groundEdgeCutMat = groundEdgeMat.clone();
function syncGroundCut() {
  groundCutMat.color.copy(groundMat.color);
  groundEdgeCutMat.color.copy(groundEdgeMat.color); groundEdgeCutMat.linewidth = groundEdgeMat.linewidth;
  groundEdgeCutMat.resolution.copy(groundEdgeMat.resolution);
}
section.register(groundCutMat); section.register(groundEdgeCutMat, { cap: false });
for (const mt of [whiteMat, glassMat, hiddenFaceMat]) section.register(mt);
section.register(edgeMat, { cap: false });
let edgesBuilt = false;
function buildEdges() {
  if (edgesBuilt) return; edgesBuilt = true;
  const skip = new RegExp(site.edgeSkip || '^Site_Fountain_(LED|Nozzles)');   // 太細碎、看不出來的物件不畫線
  for (const m of model.meshes) {
    if (skip.test(m.userData.fname)) continue;
    const g = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(m.geometry, 40));
    const ls = new LineSegments2(g, m.userData.isGround ? (isCut(m) ? groundEdgeCutMat : groundEdgeMat) : edgeMat);
    ls.visible = false; ls.raycast = () => {}; ls.frustumCulled = false; m.add(ls); m.userData.edges = ls;
    ls.matrixAutoUpdate = false;
  }
  resize();
}
const shadowsOK = renderer.shadowMap.enabled;
function setStyle(style) {
  if (!STYLES.includes(style)) style = 'normal';
  state.style = style; state.contrast = style === 'contrast'; state.wire = style === 'wire';
  if (style !== 'normal') {
    if (!edgesBuilt && isMobile) toast('正在產生線條…', 1500);
    buildEdges();
  }
  for (const m of model.meshes) {
    const g = m.userData.isGround, gl = m.userData.isGlass;
    m.material = isColor(style) ? m.userData.origMaterial
      : style === 'wire' ? (isCut(m) ? hiddenFaceMat : hiddenFaceGroundMat)
      : gl ? glassMat : g ? (isCut(m) ? groundCutMat : groundMat) : whiteMat;
    if (m.userData.edges) m.userData.edges.visible =
      style === 'wire' || (style === 'tone' && !gl) || ((style === 'contrast' || style === 'colorline') && !g && !gl);
    m.castShadow = shadowsOK && !gl && (isColor(style) || ((style === 'contrast' || style === 'tone') && !g));
  }
  // 線條顏色：白模較淡較細（避免屋頂直立縫太密變成一片黑）；彩色＋線半透明深灰；線稿、網點用黑
  edgeMat.color.set(style === 'contrast' ? 0x6b7077 : style === 'colorline' ? 0x24282d : 0x15171a);
  edgeMat.transparent = style === 'colorline'; edgeMat.opacity = style === 'colorline' ? 0.55 : 1; edgeMat.needsUpdate = true;
  groundEdgeMat.color.set(style === 'tone' ? 0x26292d : 0x9aa0a6);
  groundMat.color.set(style === 'tone' ? 0xf7f7f7 : 0xeceef1);
  syncGroundCut();
  // 剖面切口顏色：彩色、白模用灰，線稿、網點用深色（像圖面上塗黑的剖面）
  const SC = site.section?.capColors || {};
  section.setCapColor(SC[style] || (style === 'wire' || style === 'tone' ? '#2a2c30' : style === 'contrast' ? '#8d9196' : '#7a7e84'));
  setLineW(state.lineW);
  night.group.visible = isColor(style);
  applyTraffic();
  [...$('styleSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.style === style));
  $('lineRow').classList.toggle('dim', style === 'normal');
  $('toneRow').classList.toggle('hidden', style !== 'tone');
}
function setLineW(v) {
  state.lineW = +v; edgeMat.linewidth = state.lineW * (state.style === 'contrast' ? 0.5 : state.style === 'colorline' ? 0.6 : 1); groundEdgeMat.linewidth = Math.max(1, state.lineW * 0.5);
  $('lineW').value = v; $('lineWv').textContent = v;
  syncGroundCut();
}
// 網點大小（螢幕像素，依裝置像素比放大，手機上看起來一樣大）
function setToneSize(v) {
  state.toneSize = +v; $('toneSize').value = v; $('toneSizeV').textContent = v;
}
state.toneSize = site.toneSize ?? 5;

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
  const on = state.traffic && isColor(state.style);
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
  if (k === 'festival') festival.setOn(v);
}
document.querySelectorAll('[data-tg]').forEach((cb) => (cb.onchange = () => setToggle(cb.dataset.tg, cb.checked)));
// 場館燈光：預設依 lights.json 的營運時間自動開關；手動切換後維持，按「自動」回到排程
function setVenue(v) {
  state.venue = v;
  $('venueAuto').classList.toggle('hidden', v == null);
  if (v != null) $('venueSw').checked = v;
}
$('venueSw').onchange = (e) => { setVenue(e.target.checked); toast(e.target.checked ? '場館燈光：開（手動）' : '場館燈光：關（手動）'); };
$('venueAuto').onclick = () => { setVenue(null); toast('場館燈光：依營運時間自動開關'); };
// 節慶物件：只有檔期內（或網址 ?festival=）才出現這一列
$('festRow').classList.toggle('hidden', !festival.active);
$('festName').textContent = festival.active ? `節慶物件（${festival.names}）` : '節慶物件';
$('settingsBtn').onclick = () => { $('settings').classList.toggle('hidden'); $('timeSlider').classList.add('hidden'); closeOverview(); };
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('styleSeg').onclick = (e) => { const s = e.target.dataset.style; if (s) setStyle(s); };
$('projSeg').onclick = (e) => { const p = e.target.dataset.proj; if (p) setProj(p); };
$('lineW').oninput = (e) => setLineW(e.target.value);
$('toneSize').oninput = (e) => setToneSize(e.target.value);
// ---------- 剖面：設定面板的 X／Y／Z 滑桿 ----------
// 勾選要切的方向、拖滑桿決定位置（模型座標 m）、⇆ 翻轉保留的一側。只切建築。
function renderSection() {
  $('secSw').checked = section.on;
  $('secRows').classList.toggle('hidden', !section.on);
  $('capSw').checked = section.capOn;
  for (const row of document.querySelectorAll('.secRow')) {
    const a = row.dataset.ax, s = section.state[a], r = section.range[a];
    const [cb, sl, val, flip] = [row.querySelector('input[type=checkbox]'), row.querySelector('input[type=range]'), row.querySelector('b'), row.querySelector('.flip')];
    cb.checked = s.on; sl.min = r[0].toFixed(1); sl.max = r[1].toFixed(1); sl.value = s.v;
    sl.disabled = !s.on; row.classList.toggle('dim', !s.on);
    val.textContent = s.v.toFixed(1);
    flip.classList.toggle('on', s.flip);
    flip.title = s.flip ? `保留 ${a.toUpperCase()} 較大的一側` : `保留 ${a.toUpperCase()} 較小的一側`;
  }
}
$('secSw').onchange = (e) => { section.setOn(e.target.checked); renderSection(); if (section.on) toast('剖面：拖動滑桿移動切面，⇆ 翻轉方向', 3000); };
$('capSw').onchange = (e) => { section.setCap(e.target.checked); };
for (const row of document.querySelectorAll('.secRow')) {
  const a = row.dataset.ax;
  row.querySelector('input[type=checkbox]').onchange = (e) => { section.set(a, { on: e.target.checked }, true); if (!['x', 'y', 'z'].some((k) => section.state[k].on)) section.setOn(false); renderSection(); };
  row.querySelector('input[type=range]').oninput = (e) => { section.set(a, { v: +e.target.value }, true); row.querySelector('b').textContent = (+e.target.value).toFixed(1); };
  row.querySelector('.flip').onclick = () => { section.set(a, { flip: !section.state[a].flip }, true); renderSection(); };
}
renderSection();
setToneSize(state.toneSize);
// 畫質：預設／高畫質；切換後重新載入（對數深度緩衝、模型都要重建）
function renderQuality() {
  const p = qualityPref();
  [...$('qualSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.q === p));
  $('qualNote').textContent = HIGH ? '原模型＋陰影，建議效能較好的電腦使用' : '減面模型、無陰影，各種裝置都流暢';
}
$('qualSeg').onclick = (e) => {
  const q = e.target.closest('[data-q]')?.dataset.q; if (!q || q === qualityPref()) return;
  setQualityPref(q); renderQuality();
  const u = new URL(location.href); u.searchParams.delete('q');
  toast('重新載入以套用畫質設定…', 1500); setTimeout(() => location.replace(u), 600);
};
renderQuality();
$('wxSeg').onclick = (e) => {
  const w = e.target.closest('[data-wx]')?.dataset.wx; if (!w) return;
  $('wxName').textContent = e.target.closest('[data-wx]').title;
  env.wxOverride = w === 'live' ? null : w;
  // 極光只在夜間看得到：白天選極光時自動切到 21:00
  if (w === 'aurora' && env.night < 0.5) { env.override = 21 * 60; toast('極光要在夜間才看得到，已切到 21:00（設定 → 指定時間 → 回到現在 可還原）', 4000); }
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

// ---------- 迎賓模式：載入後時間天氣大字置中、模型緩慢自轉；使用者一操作就回到一般瀏覽 ----------
const welcome = { on: false };
const WELCOME_EVENTS = ['pointerdown', 'wheel', 'keydown', 'touchstart'];
function endWelcome() {
  if (!welcome.on) return;
  welcome.on = false; controls.autoRotate = false;
  document.body.classList.remove('welcome', 'welcomePure'); $('welcomeHint').classList.add('hidden');
  for (const ev of WELCOME_EVENTS) removeEventListener(ev, endWelcome, true);
}
// pure＝純轉動：只有轉動的模型，不顯示時間、日期、天氣和提示文字；離開方式相同
function startWelcome(pure = false) {
  if (welcome.on || state.presenting) return;
  welcome.on = true;
  $('settings').classList.add('hidden'); $('timeSlider').classList.add('hidden'); labels.close();
  document.body.classList.add('welcome'); document.body.classList.toggle('welcomePure', pure);
  $('welcomeHint').classList.toggle('hidden', pure);
  controls.autoRotate = true; controls.autoRotateSpeed = site.welcomeRotateSpeed ?? 0.5;   // 約 2 分鐘轉一圈
  // 等這次點擊結束後才開始監聽，避免按下「開啟迎賓模式」的同一下就把它關掉
  setTimeout(() => { if (welcome.on) for (const ev of WELCOME_EVENTS) addEventListener(ev, endWelcome, true); }, 400);
}
$('welcomeBtn').onclick = (e) => { e.stopPropagation(); startWelcome(); };
$('welcomePureBtn').onclick = (e) => { e.stopPropagation(); startWelcome(true); };

// ---------- 鏡頭動畫 ----------
let fly = null;
function flyTo(pos, target, ms = 1600) {
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, t: 0, ms };
}

// ---------- 簡報模式 ----------
// txt 格式：
//   NKCA1:xxxx         ← 一頁（由「複製代碼」取得）
//   # 標題              ← H1
//   ## 副標             ← H2
//   一般文字            ← 內文（可多行）
//   @svg 檔名.svg       ← 平面圖層（逃生動線等），貼在模型平面上；可加範圍 x0,y0,x1,y1、z=高度(cm)、depth（被建築遮住）
//   @screen 檔名.svg    ← 畫面圖層：疊在這一頁的畫面上（任意視角），底圖用「下載目前畫面底圖」
//   @img 檔名.jpg       ← 文字框裡的圖片
//   // 註記            ← 不顯示（頁次、提醒）
// 檔名是相對於 txt 所在的資料夾。文字只在這次簡報顯示，不會存在瀏覽器裡。
function snapshotCode() {
  const s = {
    v: 2, c: w2cm(camera.position), t: w2cm(controls.target), m: state.mode, h: state.halls,
    ui: { labels: state.labels, clock: state.clock, weather: state.weather, traffic: state.traffic, festival: state.festival },
    ...(section.on ? { sec: section.toCode() } : {}),
    style: state.style, lw: state.lineW, proj: state.ortho ? 'ortho' : 'persp', ...(state.style === 'tone' ? { ts: state.toneSize } : {}),
    tod: env.override, card: labels.openId(),
  };
  if (state.venue != null) s.vl = state.venue;
  return 'NKCA1:' + btoa(unescape(encodeURIComponent(JSON.stringify(s))));
}
function snapshot() {
  const code = snapshotCode();
  navigator.clipboard?.writeText(code)?.catch(() => {});
  toast('已複製簡報代碼（貼到記事本，一頁一行）：\n' + code, 6000);
}
function decode(code) {
  try { return JSON.parse(decodeURIComponent(escape(atob(code)))); } catch { return null; }
}
// resolve：把 txt 裡的檔名換成網址（GitHub 上的教材資料夾，或本機一起選取的檔案）
function parseDeck(txt, resolve = (f) => f) {
  const cues = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^NKCA1:([A-Za-z0-9+/=]+)/);
    if (m) { const s = decode(m[1]); if (s) { cur = { ...s, h1: '', h2: '', p: [], svg: [], img: [], screen: [] }; cues.push(cur); } continue; }
    if (!cur || !line || line.startsWith('//')) continue;
    const at = line.match(/^@(svg|img|screen)\s+(.+)$/i);
    if (at) {
      const parts = at[2].trim().split(/\s+/), file = parts.shift(), kind = at[1].toLowerCase();
      if (kind === 'img') { cur.img.push(resolve(file)); continue; }
      if (kind === 'screen') { cur.screen.push({ src: resolve(file) }); continue; }
      const L = { src: resolve(file) };
      for (const o of parts) {
        const f = o.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
        if (f) L.frame = f.slice(1).map(Number);
        else if (/^z=/i.test(o)) L.z = +o.slice(2);
        else if (/^depth$/i.test(o)) L.depth = true;
      }
      cur.svg.push(L);
      continue;
    }
    if (line.startsWith('## ')) cur.h2 = line.slice(3).trim();
    else if (line.startsWith('# ')) cur.h1 = line.slice(2).trim();
    else cur.p.push(line);
  }
  return cues;
}
const pres = { cues: [], i: 0, course: null, urls: [] };
// 匯入：可以同時選 txt 和它用到的 svg／圖片（上傳 GitHub 前先在本機預覽）
$('presFile').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  const txt = files.find((f) => /\.txt$/i.test(f.name)); if (!txt) { toast('請選擇簡報 txt 檔'); return; }
  pres.urls.forEach(URL.revokeObjectURL);
  const map = {};
  for (const f of files) if (f !== txt) map[f.name] = URL.createObjectURL(f);
  pres.urls = Object.values(map);
  const missing = new Set();
  const resolve = (n) => { if (/^(https?:|data:|blob:)/.test(n)) return n; if (map[n]) return map[n]; missing.add(n); return n; };
  pres.course = null;
  startDeck(await txt.text(), resolve);
  if (missing.size) toast(`沒有選到這些檔案：${[...missing].join('、')}（請和 txt 一起選取）`, 5000);
};
// 教學代碼：讀取 GitHub 上的 lessons/代碼/代碼.txt（圖片放同一個資料夾）；也相容舊的 lessons/代碼.txt
const cleanCode = (c) => String(c || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
async function loadCourse(raw) {
  const code = cleanCode(raw);
  if (!code) return false;
  for (const dir of [`lessons/${code}/`, 'lessons/']) {
    try {
      const r = await fetch(`${dir}${code}.txt`, { cache: 'no-cache' });
      if (!r.ok) continue;
      const txt = await r.text();
      pres.course = code;
      endWelcome();
      startDeck(txt, (f) => (/^(https?:|data:|blob:|\/)/.test(f) ? f : dir + f));
      return true;
    } catch {}
  }
  toast(`找不到教學代碼「${code}」`);
  return false;
}
$('lessonForm').onsubmit = (e) => { e.preventDefault(); loadCourse($('lessonCode').value); };
// 網址帶 course：…/?course=evac（或 &course=evac、#course=evac）直接開啟教材
function courseFromURL() {
  const q = new URLSearchParams(location.search).get('course') || new URLSearchParams(location.hash.slice(1)).get('course');
  return cleanCode(q || (location.href.match(/[?&#]course=([^&#]+)/) || [])[1]);
}
function setCourseURL(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('course', code); else u.searchParams.delete('course');
  u.hash = u.hash.replace(/(^#|&)course=[^&]*/, '').replace(/^#&/, '#');
  if (u.hash === '#') u.hash = '';
  history.replaceState(null, '', u);
}
function startDeck(txt, resolve) {
  const cues = parseDeck(txt, resolve);
  if (!cues.length) { toast('檔案中沒有可用的簡報代碼'); return; }
  pois.highlight(null);
  startCues(cues);
}
function startCues(cues) {
  pres.cues = cues;
  if (!state.presenting) pres.keep = { festival: state.festival };
  $('presBar').classList.toggle('single', cues.length < 2);
  $('settings').classList.add('hidden'); closeOverview();
  state.presenting = true; document.body.classList.add('presenting');
  $('presBar').classList.remove('hidden'); renderLiftPanel(true);
  setCourseURL(pres.course);   // 網址列就是可以分享給學生的連結
  goCue(0);
}
function showPresText(s) {
  const box = $('presText'), has = s.h1 || s.h2 || s.p.length || s.img.length;
  box.classList.add('fade');
  setTimeout(() => {
    box.querySelector('h1').textContent = s.h1 || '';
    box.querySelector('h2').textContent = s.h2 || '';
    const pt = box.querySelector('.pt'); pt.innerHTML = '';
    for (const t of s.p) { const p = document.createElement('p'); p.textContent = t; pt.appendChild(p); }
    for (const src of s.img) { const im = document.createElement('img'); im.src = src; im.alt = ''; pt.appendChild(im); }
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
  if (s.ui?.festival == null) setToggle('festival', false);   // 舊代碼沒有記錄：教材預設不顯示節慶物件
  setStyle(s.style || (s.ui?.wire ? 'wire' : s.ui?.contrast ? 'contrast' : 'normal'));
  if (s.lw) setLineW(s.lw);
  if (s.ts) setToneSize(s.ts);
  section.fromCode(s.sec || null); renderSection();
  setProj(s.proj || 'persp');
  env.override = s.tod ?? null;
  setVenue(s.vl ?? null);
  if (s.card) labels.openById(s.card); else labels.close();
  showPresText(s);
  plan.show(s.svg);
  screenLayer.show(s.screen, { c: cm2w(s.c), t: cm2w(s.t) });
  flyTo(cm2w(s.c), cm2w(s.t));
}
function exitPres() {
  state.presenting = false; document.body.classList.remove('presenting');
  $('presBar').classList.add('hidden'); $('presText').classList.add('hidden'); renderLiftPanel(true);
  plan.show([]); screenLayer.show([]);
  if (pres.keep) { setToggle('festival', pres.keep.festival); pres.keep = null; }
  pois.highlight(null);
  if (pres.course) { pres.course = null; setCourseURL(null); }
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

// ---------- 平面底圖：俯視、北（+Y）朝上的正射影像，給 Illustrator 描逃生動線用 ----------
// 範圍：畫面拉近時取目前看到的地面範圍，否則用 site.json 的 planFrame_cm（整個基地）。範圍寫在檔名裡。
function planFrameNow() {
  const def = site.planFrame_cm || [-4000, 2000, 36000, 30000];
  const g = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), xs = [], ys = [];
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ray.setFromCamera(new THREE.Vector2(x, y), viewCam());
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(g, p)) return def;
    const c = w2cm(p); xs.push(c[0]); ys.push(c[1]);
  }
  let f = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if ((f[2] - f[0]) * (f[3] - f[1]) >= (def[2] - def[0]) * (def[3] - def[1]) * 0.8) return def;
  f = [Math.floor(f[0] / 100) * 100, Math.floor(f[1] / 100) * 100, Math.ceil(f[2] / 100) * 100, Math.ceil(f[3] / 100) * 100];
  return [Math.max(f[0], def[0] - 8000), Math.max(f[1], def[1] - 8000), Math.min(f[2], def[2] + 8000), Math.min(f[3], def[3] + 8000)];
}
function exportPlan() {
  const [x0, y0, x1, y1] = planFrameNow();
  const wcm = x1 - x0, hcm = y1 - y0;
  const k = Math.min(4096 / Math.max(wcm, hcm), 0.5, renderer.capabilities.maxTextureSize / Math.max(wcm, hcm));   // 像素／cm
  const W = Math.round(wcm * k), H = Math.round(hcm * k);
  const cam = new THREE.OrthographicCamera(-wcm / 200, wcm / 200, hcm / 200, -hcm / 200, 1, 3000);
  const c = cm2w([(x0 + x1) / 2, (y0 + y1) / 2, 0]);
  cam.position.set(c.x, 1500, c.z); cam.up.set(0, 0, -1); cam.lookAt(c.x, 0, c.z); cam.updateMatrixWorld();
  const out = renderOffscreen(cam, W, H, true), g = out.getContext('2d');
  // 標籤畫在底圖上，方便對位置
  const fs = Math.max(14, Math.round(W / 140));
  g.font = `500 ${fs}px Roboto, "Noto Sans TC", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const it of labels.items) {
    const [lx, ly] = it.cfg.pos_cm, u = (lx - x0) * k, v = (y1 - ly) * k;
    if (u < 0 || v < 0 || u > W || v > H) continue;
    const tw = g.measureText(it.cfg.text).width + fs * 1.2, th = fs * 1.7;
    g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.roundRect(u - tw / 2, v - th / 2, tw, th, th / 2); g.fill();
    g.fillStyle = '#202124'; g.fillText(it.cfg.text, u, v + 1);
  }
  g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillStyle = 'rgba(0,0,0,.55)';
  g.font = `${Math.round(fs * 0.8)}px Roboto, sans-serif`;
  g.fillText(`NKCA plan  x ${x0}–${x1} cm  y ${y0}–${y1} cm  (1 px = ${(1 / k).toFixed(1)} cm, north-up = model +Y)`, fs * 0.6, H - fs * 0.5);
  const name = `NKCA_plan_${x0}_${y0}_${x1}_${y1}.png`;
  downloadCanvas(out, name);
  const def = site.planFrame_cm || [-4000, 2000, 36000, 30000];
  const isDef = [x0, y0, x1, y1].every((v, i) => v === def[i]);
  navigator.clipboard?.writeText(isDef ? '@svg 檔名.svg' : `@svg 檔名.svg ${x0},${y0},${x1},${y1}`)?.catch(() => {});
  toast(`已下載平面底圖 ${W}×${H}\n範圍 ${x0},${y0},${x1},${y1}（cm）\n` +
    (isDef ? '這是預設範圍，txt 寫「@svg 檔名.svg」即可（已複製）' : `txt 寫「@svg 檔名.svg ${x0},${y0},${x1},${y1}」（已複製）`), 8000);
}
$('planBtn').onclick = exportPlan;

// 離屏算圖：指定鏡頭與尺寸，回傳 2D canvas（noFog：平面底圖不要霧）
function renderOffscreen(cam, W, H, noFog = false) {
  const pr = renderer.getPixelRatio(), fog = scene.fog;
  if (noFog) scene.fog = null;
  plan.visible = false;
  edgeMat.resolution.set(W, H); groundEdgeMat.resolution.set(W, H); syncGroundCut();
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.render(scene, cam);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  out.getContext('2d').drawImage(renderer.domElement, 0, 0);
  scene.fog = fog; plan.visible = true;
  renderer.setPixelRatio(pr); resize();
  return out;
}
const downloadCanvas = (cv, name) => cv.toBlob((b) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}, 'image/png');

// ---------- 目前畫面底圖：任意視角，給 @screen 畫面圖層用 ----------
// 同時複製這個畫面的簡報代碼＋「@screen 檔名.svg」，貼進 txt 就是一頁。
function exportView() {
  const code = snapshotCode();
  // 先把鏡頭放到代碼記錄的位置（四捨五入到 cm），底圖和播放時的畫面才會完全一樣
  const s = decode(code.slice(6));
  fly = null; camera.position.copy(cm2w(s.c)); controls.target.copy(cm2w(s.t)); controls.update(); camera.updateMatrixWorld();
  if (state.ortho) syncOrtho();
  const H = 1440, W = Math.round(H * camera.aspect);
  const out = renderOffscreen(viewCam(), W, H), g = out.getContext('2d');
  // 看得到的標籤也畫上去（位置照目前畫面等比例換算）
  const k = H / innerHeight, fs = Math.round(13 * k);
  g.font = `500 ${fs}px Roboto, "Noto Sans TC", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const it of labels.items) {
    if (it.el.classList.contains('gone') || !state.labels) continue;
    const m = it.el.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/); if (!m) continue;
    const u = +m[1] * k, v = (+m[2] - 18) * k;
    const tw = g.measureText(it.cfg.text).width + fs * 1.6, th = fs * 1.9;
    g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.roundRect(u - tw / 2, v - th / 2, tw, th, th / 2); g.fill();
    g.fillStyle = '#202124'; g.fillText(it.cfg.text, u, v + 1);
  }
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  downloadCanvas(out, `NKCA_view_${stamp}.png`);
  navigator.clipboard?.writeText(`${code}\n@screen 檔名.svg`)?.catch(() => {});
  toast(`已下載目前畫面底圖 ${W}×${H}\n已複製這個畫面的簡報代碼＋「@screen 檔名.svg」，貼進 txt 後把檔名改成你的 SVG`, 8000);
}
$('viewBtn').onclick = exportView;

// ---------- 概覽（右側選單）：分類定點導覽 ----------
// config/overview.json 的分類；定點來自 pois.json 中 cat 相同的圖示、分類自己的 items，或直接開教材（course）
const ovCats = overviewCfg.categories || [];
const iconSrc = (n) => poisCfg.icons?.[n] || null;
function catPoints(c) {
  const out = [];
  for (const it of pois.items) if (it.cfg.cat === c.id) out.push({ title: it.cfg.text, pos_cm: it.cfg.pos_cm, modes: it.cfg.modes, hall: it.cfg.hall, floor: it.cfg.floor, text: it.cfg.note });
  for (const it of c.items || []) out.push(it);
  return out;
}
function renderOverview() {
  const box = $('ovList'); box.innerHTML = '';
  for (const c of ovCats) {
    const n = catPoints(c).length, b = document.createElement('button');
    b.className = 'ovItem' + (n || c.course ? '' : ' empty');
    b.style.setProperty('--c', c.color || '#0b57d0');
    const src = iconSrc(c.icon);
    b.innerHTML = `<span class="ovIcon">${src ? `<img src="${src}" alt="">` : `<span class="ms">${c.icon || 'place'}</span>`}</span>` +
      `<span><div class="ovName"></div><div class="ovSub">${c.course ? '教材' : n ? `${n} 個定點` : '尚未設定位置'}</div></span>`;
    b.querySelector('.ovName').textContent = c.name;
    b.onclick = () => startOverview(c);
    box.appendChild(b);
  }
}
function openOverview() { renderOverview(); $('ovDrawer').classList.add('open'); $('settings').classList.add('hidden'); }
function closeOverview() { $('ovDrawer').classList.remove('open'); }
$('ovBtn').onclick = (e) => { e.stopPropagation(); $('ovDrawer').classList.contains('open') ? closeOverview() : openOverview(); };
$('ovClose').onclick = closeOverview;
function startOverview(c) {
  if (c.course) { closeOverview(); loadCourse(c.course); return; }
  const pts = catPoints(c);
  if (!pts.length) { toast(`「${c.name}」還沒有設定位置（config/overview.json 或 pois.json 的 cat）`); return; }
  // 鏡頭：沿用目前的方位，往下看 50°，距離 dist_m（預設 45 m）
  const off = camera.position.clone().sub(controls.target); off.y = 0;
  if (off.lengthSq() < 1e-6) off.set(0, 0, 1);
  off.normalize();
  const cues = pts.map((p, i) => {
    let base;
    if (p.code) base = decode(String(p.code).replace(/^NKCA1:/, ''));
    if (!base) {
      const t = cm2w(p.pos_cm), d = p.dist_m || 45, e = THREE.MathUtils.degToRad(50);
      const cpos = t.clone().addScaledVector(off, Math.cos(e) * d); cpos.y += Math.sin(e) * d;
      base = { c: w2cm(cpos), t: p.pos_cm, m: p.modes?.[0] || c.mode || state.mode };
      if (p.hall) base.h = { ...state.halls, [p.hall]: p.floor };
    }
    return { ...base, sec: base.sec ?? section.toCode(), h1: c.name, h2: p.title && p.title !== c.name ? p.title : '', p: p.text ? String(p.text).split('\n') : [], svg: [], img: [], screen: [] };
  });
  pres.course = null;
  startCues(cues);
  pois.highlight(c.id, c.color || '#0b57d0');
}

// 開啟網頁：網址有 course 就直接播放教材，否則依設定進入迎賓模式
{
  const course = courseFromURL();
  if (course) loadCourse(course).then((ok) => { if (!ok && site.welcome !== false) startWelcome(); });
  else if (site.welcome !== false) startWelcome();
}

// ---------- 迴圈 ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  composer.setPixelRatio(renderer.getPixelRatio());
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  edgeMat.resolution.set(w * pr, h * pr); groundEdgeMat.resolution.set(w * pr, h * pr); syncGroundCut();
}
addEventListener('resize', resize); resize();
// 動態解析度：鏡頭在動而幀率不足時降低像素比（電腦最低 1，手機 0.8），順了再升回來
const adaptive = new AdaptiveRes({ min: Math.min(MAX_PR, isMobile ? 0.8 : 1), max: MAX_PR, apply: (pr) => { renderer.setPixelRatio(pr); resize(); } });
const lastCam = new THREE.Matrix4();
// 白模／線稿／網點的固定光源（site.json 的 studioLight：方位角由北順時針、仰角，度）
const SL = site.studioLight || {};
const studioDir = (() => {
  const a = THREE.MathUtils.degToRad(SL.az_deg ?? 300), e = THREE.MathUtils.degToRad(SL.alt_deg ?? 46);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
})();
const WHITE_BG = new THREE.Color(0xffffff);
function studioLight() {
  env.sun.position.copy(env.center).addScaledVector(studioDir, 400);
  env.sun.color.set(0xffffff); env.sun.intensity = SL.sun ?? 2.6;
  env.hemi.color.set(0xffffff); env.hemi.groundColor.set(0xb4b6b8); env.hemi.intensity = SL.ambient ?? 2.0;
  if (env.flash) env.flash.intensity = 0;
}

const clock = new THREE.Clock();
const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const BH = lightsCfg.buildingHours || {};
function buildingOpen(d) {
  if (!BH.off) return true;
  const tp = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' })), m = tp.getHours() * 60 + tp.getMinutes();
  const on = hm(BH.on ?? '05:00'), off = hm(BH.off);
  return on < off ? m >= on && m < off : m >= on || m < off;
}
let venueK = 1, simDt = 0, frameNo = 0;
let lastUI = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (fly) {
    fly.t += (dt * 1000) / fly.ms; const k = ease(Math.min(1, fly.t));
    camera.position.lerpVectors(fly.p0, fly.p1, k); controls.target.lerpVectors(fly.t0, fly.t1, k);
    if (fly.t >= 1) fly = null;
  }
  controls.update(dt);   // 傳入 dt：迎賓自轉速度與幀率無關
  if (camera.position.y < 1.2) camera.position.y = 1.2;
  // 沒有對數深度時：near 跟著鏡頭距離放大，遠看時深度精度才夠，地面圖層不會閃
  if (!renderer.capabilities.logarithmicDepthBuffer) {
    const nr = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.01, 0.3, 8);
    if (Math.abs(nr - camera.near) > camera.near * 0.15) { camera.near = nr; camera.updateProjectionMatrix(); }
  }
  camera.updateMatrixWorld();
  const camMoving = !lastCam.equals(camera.matrixWorld); lastCam.copy(camera.matrixWorld);
  adaptive.sample(dt * 1000, camMoving || !!fly);
  if (state.ortho) syncOrtho();
  const cam = viewCam();
  env.focus = camera.position;
  env.update(dt);
  const plain = isPlain(state.style);
  if (plain) { scene.background = WHITE_BG; env.sky.visible = env.dome.visible = env.stars.visible = false; scene.fog.density = 0; studioLight(); }
  // 白模／線稿／網點不做色調映射，白就是純白
  renderer.toneMapping = plain ? THREE.NoToneMapping : TONE;
  setEnvK(plain ? 0 : ENV_K * (1 - env.night * 0.85));
  if (!plain) setNightTint(env.night);
  horizon?.update(camera.position, plain ? 0 : env.night, plain);
  const n = plain ? 0 : env.night;
  // 建築燈光營運時間（config/lights.json 的 buildingHours）：23:00 熄燈，路燈、車燈、道路標線不受影響
  const venueOn = state.venue ?? buildingOpen(env.now());
  venueK += ((venueOn ? 1 : 0) - venueK) * Math.min(1, dt * 1.5);
  night.update(n, n * venueK);
  bloom.strength = n * (BL.strength ?? 0.75) + (env.flashK || 0) * 0.6;
  if (env.flashK) renderer.toneMappingExposure += env.flashK * 0.9;   // 閃電瞬間整個畫面亮一下
  fountain?.update(t, env.now(), n);
  festival.update(dt, n);
  piano.update(dt);
  section.tick(dt);
  updatePianoHint(t);
  soundscape.update({ mode: state.mode, target: controls.target, camera: camera.position, dist: camera.position.distanceTo(controls.target), halls: state.halls, night: env.night, rainy: env.rainy, storm: !!env.storm });
  plan.update(dt); parkingPlan.update(dt);
  screenLayer.update(camera.position, controls.target, !!fly);
  // 手機平板：人車模擬隔一幀算一次（時間累加，速度不變）
  simDt += dt;
  if (!isMobile || (frameNo & 1)) { vehicles.update(simDt, n); people.update(simDt); simDt = 0; }
  frameNo++;
  for (let i = lifts.length - 1; i >= 0; i--) {
    const L = lifts[i]; L.t = Math.min(1, L.t + dt / 1.2);
    L.m.position.y = L.m.userData.y0 + L.from + (L.to - L.from) * ease(L.t);
    if (L.t >= 1) {
      lifts.splice(i, 1);
      if (L.hideEnd) { L.m.visible = meshVisible(L.m.userData.fname); L.m.position.y = L.m.userData.y0; }
    }
    L.m.updateMatrix();
  }
  // 需要後製（夜間光暈、線稿＋網點）才走 composer；否則直接畫，畫面有原生反鋸齒
  const tone = state.style === 'tone', bloomOn = useBloom && !plain && bloom.strength > 0.01;
  if (bloomOn || tone) {
    bloom.enabled = bloomOn;
    finalPass.uniforms.uTone.value = plain ? 0 : 1;
    finalPass.uniforms.uDot.value = tone ? 1 : 0;
    finalPass.uniforms.uCell.value = state.toneSize * renderer.getPixelRatio();
    composer.render();
  } else renderer.render(scene, cam);
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
    if (!$('settings').classList.contains('hidden')) $('soundZone').textContent = soundZoneText();
    if (state.venue == null) $('venueSw').checked = buildingOpen(env.now());
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
window.nkca = { festival, pois, startOverview, ovCats, scene, camera, orthoCam, controls, model, env, state, setMode, setStyle, setProj, flyTo, fountain, night, vehicles, people, renderer, labels, viewFromModelDir, piano, soundscape, section, renderSection };
