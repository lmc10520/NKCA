// 滅火器攝影機測試（drill-cam.html）：只用一支外接攝影機，滅火器不裝任何電子零件。
// 偵測：人體骨架（MediaPipe Pose，估距離、身體壓低）＋四個螢光色標記（噴嘴前端、皮管根部、插銷旗標、壓把色塊）。
// 所有計算在瀏覽器內完成，影像不上傳。座標一律用「畫面上看到的」座標（鏡像時已左右翻轉），0–1。

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const AGENT_SEC = 14;          // 10 型乾粉約 14 秒噴完
const PIN_LOST_MS = 700;       // 插銷旗標消失多久算拔掉
const LEVER_MS = 120;          // 壓把色塊出現多久算壓下（去抖動）
const SWEEP_WIN = 2500;        // 掃射判斷的時間窗（ms）
const SWEEP_AMP = 0.18;        // 一次擺動至少要多大（瞄準單位，1＝目標框半寬）
const BASE_ZONE = { x: 0.75, y0: 0.25, y1: 0.85 };   // 目標框裡「火源根部」的範圍
const TOO_HIGH = 0.05;         // aimY 小於這個值＝對準火焰上方
const DIST_GRACE = 0.25;       // 距離超出建議範圍多少才算太近／太遠（m）

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('drillcam.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('drillcam.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- 標記 ----------
const MARKERS = [
  { id: 'tip',   name: '噴嘴前端',   h: 330, tol: 14, minS: 0.45, minV: 0.35, draw: '#ff2bd6' },
  { id: 'base',  name: '皮管根部',   h: 110, tol: 16, minS: 0.45, minV: 0.30, draw: '#3cff3c' },
  { id: 'pin',   name: '插銷旗標',   h: 25,  tol: 12, minS: 0.55, minV: 0.45, draw: '#ff8a00' },
  { id: 'lever', name: '壓把色塊',   h: 200, tol: 14, minS: 0.45, minV: 0.30, draw: '#22a8ff' },
];
const saved = store.get('markers', {});
for (const m of MARKERS) { Object.assign(m, saved[m.id] || {}); m.on = m.on ?? true; m.blob = null; }
const saveMarkers = () => store.set('markers', Object.fromEntries(MARKERS.map((m) => [m.id, { h: m.h, tol: m.tol, minS: m.minS, minV: m.minV, on: m.on }])));
const hsl = (m) => `hsl(${m.h} 90% 55%)`;

let picking = null;
let calib = null, calRun = null;   // 校正結果、進行中的校正
function buildMarkerUI() {
  $('markers').innerHTML = '';
  for (const m of MARKERS) {
    const row = document.createElement('div'); row.className = 'mk';
    row.innerHTML = `<div class="sw" style="background:${hsl(m)}"></div>
      <label><input type="checkbox" ${m.on ? 'checked' : ''}> ${m.name}</label>
      <span class="n">—</span><button>取色</button>`;
    row.querySelector('input').onchange = (e) => { m.on = e.target.checked; saveMarkers(); };
    row.querySelector('button').onclick = () => {
      picking = picking === m ? null : m;
      document.querySelectorAll('.mk button').forEach((b) => b.classList.remove('on'));
      if (picking) row.querySelector('button').classList.add('on');
      hint(picking ? `點畫面上的「${m.name}」貼紙` : '');
    };
    m.ui = { sw: row.querySelector('.sw'), n: row.querySelector('.n') };
    $('markers').appendChild(row);
  }
}
buildMarkerUI();

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}
const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------- 畫面 ----------
const video = document.createElement('video'); video.playsInline = true; video.muted = true;
const view = $('view'), vctx = view.getContext('2d');
const proc = document.createElement('canvas'), pctx = proc.getContext('2d', { willReadFrequently: true });
const PW = 320; let PH = 180;
const CELL = 8;
let mirror = store.get('mirror', true); $('mirror').checked = mirror;
$('mirror').onchange = (e) => { mirror = e.target.checked; store.set('mirror', mirror); };
let role = store.get('role', 'front');
const setRole = (r) => { role = r; store.set('role', r); $('roleFront').classList.toggle('on', r === 'front'); $('roleSide').classList.toggle('on', r === 'side'); calib = null; };
$('roleFront').onclick = () => setRole('front'); $('roleSide').onclick = () => setRole('side'); setRole(role);
let gain = store.get('gain', 1); $('gain').value = gain; $('gainV').textContent = (+gain).toFixed(1);
$('gain').oninput = (e) => { gain = +e.target.value; $('gainV').textContent = gain.toFixed(1); store.set('gain', gain); };
for (const k of ['calD', 'dMin', 'dMax']) { $(k).value = store.get(k, $(k).value); $(k).onchange = (e) => store.set(k, e.target.value); }

function hint(t) { $('hint').textContent = t; }
function banner(t, sub = '') { $('banner').innerHTML = t ? `${t}${sub ? `<small>${sub}</small>` : ''}` : ''; }

// ---------- 攝影機 ----------
let stream = null;
async function listCams() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('camSel'), cur = store.get('cam', '');
    sel.innerHTML = '<option value="">（預設攝影機）</option>' + devs.map((d, i) => `<option value="${d.deviceId}">${d.label || '攝影機 ' + (i + 1)}</option>`).join('');
    if (devs.some((d) => d.deviceId === cur)) sel.value = cur;
  } catch {}
}
async function openCam() {
  if (!navigator.mediaDevices?.getUserMedia) { banner('這個瀏覽器不能開攝影機', '請用電腦版 Chrome 或 Edge，並以 https 開啟'); return; }
  stream?.getTracks().forEach((t) => t.stop());
  const id = $('camSel').value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  } catch (e) { banner('無法開啟攝影機', e.name === 'NotAllowedError' ? '請在網址列允許使用攝影機' : e.message); return; }
  video.srcObject = stream; await video.play();
  store.set('cam', id);
  await listCams();   // 允許後才拿得到攝影機名稱
  view.width = video.videoWidth; view.height = video.videoHeight;
  PH = Math.round(PW * video.videoHeight / video.videoWidth); proc.width = PW; proc.height = PH;
  banner('', ''); hint('先依序替四個標記「取色」，再站上 2 m 線按「開始校正」');
  $('camBtn').textContent = '重新開啟'; $('camBtn').classList.remove('primary');
}
$('camBtn').onclick = openCam;
$('camSel').onchange = () => { if (stream) openCam(); };
listCams();

// ---------- 骨架 ----------
let pose = null, poseLm = null, lastPoseT = 0, poseMs = 0;
(async () => {
  try {
    const { FilesetResolver, PoseLandmarker } = await import(`${MP}/vision_bundle.mjs`);
    const fs = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    pose = await PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1 });
  } catch (e) {
    console.warn(e); $('perf').textContent = '骨架模型載入失敗：只用顏色標記（距離改用噴嘴標記大小估算）';
  }
})();

// ---------- 顏色追蹤：320 寬的小圖，8×8 格子連通 ----------
function track(img) {
  const GW = Math.ceil(PW / CELL), GH = Math.ceil(PH / CELL), N = GW * GH;
  const act = MARKERS.filter((m) => m.on);
  const cnt = act.map(() => new Uint16Array(N)), sx = act.map(() => new Float32Array(N)), sy = act.map(() => new Float32Array(N));
  const d = img.data;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = (y * PW + x) * 4;
    const [h, s, v] = rgb2hsv(d[i], d[i + 1], d[i + 2]);
    for (let k = 0; k < act.length; k++) {
      const m = act[k];
      if (s >= m.minS && v >= m.minV && hueDiff(h, m.h) <= m.tol) {
        const c = ((y / CELL) | 0) * GW + ((x / CELL) | 0);
        cnt[k][c]++; sx[k][c] += x; sy[k][c] += y;
      }
    }
  }
  for (const m of MARKERS) m.blob = null;
  act.forEach((m, k) => {
    const seen = new Uint8Array(N); let best = null;
    for (let c = 0; c < N; c++) {
      if (seen[c] || cnt[k][c] < 4) continue;
      let n = 0, X = 0, Y = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; const q = [c]; seen[c] = 1;
      while (q.length) {
        const j = q.pop(), gx = j % GW, gy = (j / GW) | 0;
        n += cnt[k][j]; X += sx[k][j]; Y += sy[k][j];
        x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + ax, ny = gy + ay; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const o = ny * GW + nx; if (!seen[o] && cnt[k][o] >= 4) { seen[o] = 1; q.push(o); }
        }
      }
      if (!best || n > best.n) best = { n, x: X / n / PW, y: Y / n / PH, box: [x0 * CELL / PW, y0 * CELL / PH, (x1 + 1) * CELL / PW, (y1 + 1) * CELL / PH] };
    }
    m.blob = best && best.n >= 20 ? best : null;
  });
}

function pickColor(nx, ny) {
  const x = Math.round(nx * PW), y = Math.round(ny * PH);
  const d = pctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  let r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4, [h, s, v] = rgb2hsv(r / n, g / n, b / n);
  if (s < 0.25) { hint('這個顏色太接近灰白，攝影機分不出來，請換螢光色貼紙'); return; }
  Object.assign(picking, { h: Math.round(h), minS: +Math.max(0.3, s * 0.6).toFixed(2), minV: +Math.max(0.2, v * 0.5).toFixed(2) });
  picking.ui.sw.style.background = hsl(picking); saveMarkers();
  hint(`已設定「${picking.name}」：色相 ${picking.h}°`);
  document.querySelectorAll('.mk button').forEach((b) => b.classList.remove('on')); picking = null;
}
view.addEventListener('click', (e) => {
  if (!picking || !stream) return;
  const r = view.getBoundingClientRect(); pickColor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
});

// ---------- 量測 ----------
const LM = { nose: 0, lSh: 11, rSh: 12, lWr: 15, rWr: 16, lHip: 23, rHip: 24 };
const lm = (i) => (poseLm && poseLm[i] && (poseLm[i].visibility ?? 1) > 0.5 ? poseLm[i] : null);
function shoulderPx() {
  const a = lm(LM.lSh), b = lm(LM.rSh); if (!a || !b) return null;
  return Math.hypot((a.x - b.x) * view.width, (a.y - b.y) * view.height);
}
const blob = (id) => MARKERS.find((m) => m.id === id).blob;
function nozzlePitch() {   // 側面：皮管根部 → 噴嘴前端的仰角（度，向上為正）
  const t = blob('tip'), b = blob('base'); if (!t || !b) return null;
  return Math.atan2(-(t.y - b.y) * view.height, Math.abs(t.x - b.x) * view.width) * 180 / Math.PI;
}

// ---------- 校正 ----------

$('calBtn').onclick = () => {
  if (!stream) { hint('請先開啟攝影機'); return; }
  audioInit();
  calRun = { t0: performance.now(), sh: [], tip: [], pitch: [], nose: [], tipN: [], pin: 0, n: 0 };
};
function calibStep(now) {
  const t = (now - calRun.t0) / 1000;
  if (t < 3) { banner(String(3 - Math.floor(t)), '站在線上，噴嘴對準螢幕中央，不要動'); return; }
  if (t < 4) {
    banner('校正中…'); calRun.n++;
    const s = shoulderPx(); if (s) calRun.sh.push(s);
    const tp = blob('tip'); if (tp) { calRun.tip.push([tp.x, tp.y]); calRun.tipN.push(tp.n); }
    const p = nozzlePitch(); if (p != null) calRun.pitch.push(p);
    const n = lm(LM.nose); if (n) calRun.nose.push(n.y);
    if (blob('pin')) calRun.pin++;
    return;
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const r = calRun; calRun = null; banner('');
  if (r.n < 8) { hint('校正時電腦太忙（畫面更新太少），請再按一次「開始校正」'); return; }
  if (r.tip.length < r.n * 0.5) { hint('校正失敗：看不到「噴嘴前端」標記，請重新取色或調整攝影機'); return; }
  if (role === 'side' && !r.pitch.length) { hint('校正失敗：側面模式需要同時看到「噴嘴前端」和「皮管根部」'); return; }
  calib = {
    D: +$('calD').value || 2,
    sh: r.sh.length ? avg(r.sh) : null,
    tipN: avg(r.tipN),
    tip: [avg(r.tip.map((v) => v[0])), avg(r.tip.map((v) => v[1]))],
    pitch: r.pitch.length ? avg(r.pitch) : null,
    nose: r.nose.length ? avg(r.nose) : null,
    pinSeen: r.pin > r.n * 0.5,
  };
  resetRun();
  log(`校正完成${calib.sh ? '' : '（沒抓到肩膀，距離改用噴嘴標記大小估算）'}${calib.pinSeen ? '' : '；沒看到插銷旗標，可用 P 鍵代替'}`, 'ok');
  hint('開始操作：拉 → 準 → 壓 → 掃');
}

// ---------- 訓練狀態 ----------
let run;
function resetRun() {
  run = { t0: performance.now(), pinIn: true, pinLostAt: 0, leverAt: 0, squeeze: false, agent: 1, sprayMs: 0, baseMs: 0, sweepMs: 0,
    hist: [], errors: 0, warned: {}, firstSpray: null, done: false, keyPin: false, keySq: false };
  $('log').innerHTML = '';
}
resetRun();
$('resetBtn').onclick = () => { resetRun(); log('重新開始', 'ok'); };
function log(t, cls = '') {
  const li = document.createElement('li'); li.className = cls;
  li.textContent = `${((performance.now() - run.t0) / 1000).toFixed(1)}s　${t}`;
  const box = $('log'); box.appendChild(li); box.scrollTop = box.scrollHeight;
}
function warnOnce(key, t, gap = 3000) {   // 同一種錯誤 3 秒內只記一次；校正前不記
  if (!calib) return;
  const now = performance.now(); if (run.warned[key] && now - run.warned[key] < gap) return;
  run.warned[key] = now; run.errors++; log(t, 'bad');
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyP') { run.keyPin = !run.keyPin; }
  if (e.code === 'Space') { run.keySq = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') run.keySq = false; });

let meas = {};
function update(now, dt) {
  const tip = blob('tip'), pin = blob('pin'), lever = blob('lever');
  // 距離
  let dist = null;
  if (calib) {
    const s = shoulderPx();
    if (s && calib.sh) dist = calib.D * calib.sh / s;
    else if (tip && calib.tipN) dist = calib.D * Math.sqrt(calib.tipN / tip.n);
  }
  // 瞄準（1＝目標框半寬；y 向下為正）
  let aim = null;
  if (calib) {
    if (role === 'front' && tip) {
      const k = gain / (0.2 * view.width);
      aim = { x: (tip.x - calib.tip[0]) * view.width * k, y: (tip.y - calib.tip[1]) * view.height * k };
    } else if (role === 'side') {
      const p = nozzlePitch(); if (p != null) aim = { x: 0, y: (calib.pitch - p) / 25 * gain };
    }
    if (aim) { aim.x = Math.max(-1.2, Math.min(1.2, aim.x)); aim.y = Math.max(-1.2, Math.min(1.2, aim.y)); }
  }
  // 拉：插銷旗標消失一段時間＝拔掉
  if (calib?.pinSeen) {
    if (pin) run.pinLostAt = 0; else if (!run.pinLostAt) run.pinLostAt = now;
    const pulled = run.pinLostAt && now - run.pinLostAt > PIN_LOST_MS;
    if (pulled && run.pinIn) { run.pinIn = false; log('拔掉插銷', 'ok'); }
    if (!pulled && !run.pinIn && pin) { run.pinIn = true; log('插銷又出現（插回去了？）'); }
  } else if (run.keyPin === run.pinIn) { run.pinIn = !run.keyPin; log(run.pinIn ? '插回插銷（鍵盤）' : '拔掉插銷（鍵盤）', run.pinIn ? '' : 'ok'); }
  // 壓：壓把色塊露出
  const levRaw = !!lever || run.keySq;
  if (levRaw) { if (!run.leverAt) run.leverAt = now; } else run.leverAt = 0;
  const squeeze = !!run.leverAt && now - run.leverAt > LEVER_MS;
  if (squeeze && !run.squeeze) {
    if (run.pinIn) warnOnce('pin', '還沒拔插銷就壓握把');
    else if (run.agent > 0) log('壓下握把', 'ok');
  }
  run.squeeze = squeeze;
  const spraying = calib && squeeze && !run.pinIn && run.agent > 0;
  // 掃：瞄準水平位置來回擺動
  if (aim) run.hist.push([now, aim.x]);
  while (run.hist.length && now - run.hist[0][0] > SWEEP_WIN) run.hist.shift();
  // 掃：先找出第一次移動的方向，之後每次反向（擺幅超過 SWEEP_AMP）算一次
  let swings = 0, dir = 0, hi = run.hist[0]?.[1], lo = hi;
  for (const [, x] of run.hist) {
    if (dir === 0) {
      hi = Math.max(hi, x); lo = Math.min(lo, x);
      if (hi - x > SWEEP_AMP) { dir = -1; lo = x; } else if (x - lo > SWEEP_AMP) { dir = 1; hi = x; }
    } else if (dir > 0) {
      if (x > hi) hi = x; else if (hi - x > SWEEP_AMP) { swings++; dir = -1; lo = x; }
    } else if (x < lo) lo = x; else if (x - lo > SWEEP_AMP) { swings++; dir = 1; hi = x; }
  }
  const sweeping = role === 'front' && swings >= 1;
  const atBase = aim && Math.abs(aim.x) <= BASE_ZONE.x && aim.y >= BASE_ZONE.y0 && aim.y <= BASE_ZONE.y1;
  // 噴射中的檢查
  if (spraying) {
    if (run.firstSpray == null) run.firstSpray = now;
    run.agent = Math.max(0, run.agent - dt / 1000 / AGENT_SEC);
    run.sprayMs += dt; if (atBase) run.baseMs += dt; if (sweeping) run.sweepMs += dt;
    if (aim && aim.y < TOO_HIGH) warnOnce('high', '對準火焰上方，應對準火源根部');
    if (dist != null && dist > +$('dMax').value + DIST_GRACE) warnOnce('far', `距離 ${dist.toFixed(1)} m，太遠了`);
    if (dist != null && dist < +$('dMin').value - DIST_GRACE) warnOnce('near', `距離 ${dist.toFixed(1)} m，太靠近火源`);
    if (role === 'front' && now - run.firstSpray > 3000 && !sweeping) warnOnce('sweep', '沒有左右掃射', 5000);
    if (run.agent === 0 && !run.done) { run.done = true; log('藥劑用完', 'ok'); }
  }
  hiss(spraying);
  // 身體壓低（跟校正時比較鼻子高度）
  const nose = lm(LM.nose); const crouch = calib?.nose != null && nose ? nose.y - calib.nose > 0.08 : false;
  meas = { dist, aim, spraying, sweeping, atBase, crouch, squeeze, swings };
}

// ---------- 噴射聲 ----------
let ac = null, hissGain = null;
function audioInit() {
  if (ac) return;
  try {
    ac = new AudioContext();
    const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.6;
    hissGain = ac.createGain(); hissGain.gain.value = 0;
    src.connect(bp).connect(hissGain).connect(ac.destination); src.start();
  } catch { ac = null; }
}
let hissOn = false;
function hiss(on) {
  if (!hissGain || on === hissOn) return; hissOn = on;
  hissGain.gain.setTargetAtTime(on ? 0.35 : 0, ac.currentTime, on ? 0.05 : 0.15);
}

// ---------- 繪圖 ----------
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
function drawView() {
  const W = view.width, H = view.height;
  vctx.save();
  if (mirror) { vctx.translate(W, 0); vctx.scale(-1, 1); }
  vctx.drawImage(video, 0, 0, W, H); vctx.restore();
  vctx.lineWidth = Math.max(2, W / 400);
  if (poseLm) {
    vctx.strokeStyle = 'rgba(255,255,255,.8)';
    for (const [a, b] of BONES) {
      const p = lm(a), q = lm(b); if (!p || !q) continue;
      vctx.beginPath(); vctx.moveTo(p.x * W, p.y * H); vctx.lineTo(q.x * W, q.y * H); vctx.stroke();
    }
  }
  for (const m of MARKERS) {
    const b = m.blob; m.ui.n.textContent = b ? `${b.n}px` : '—'; m.ui.n.style.color = b ? '#188038' : '';
    if (!b) continue;
    vctx.strokeStyle = m.draw; vctx.strokeRect(b.box[0] * W, b.box[1] * H, (b.box[2] - b.box[0]) * W, (b.box[3] - b.box[1]) * H);
    vctx.fillStyle = m.draw; vctx.beginPath(); vctx.arc(b.x * W, b.y * H, W / 160, 0, Math.PI * 2); vctx.fill();
    vctx.font = `${Math.round(W / 60)}px sans-serif`; vctx.fillText(m.name, b.box[2] * W + 6, b.box[1] * H + W / 60);
  }
  const t = blob('tip'), b = blob('base');
  if (t && b) { vctx.strokeStyle = '#fff'; vctx.setLineDash([8, 6]); vctx.beginPath(); vctx.moveTo(b.x * W, b.y * H); vctx.lineTo(t.x * W, t.y * H); vctx.stroke(); vctx.setLineDash([]); }
  if (calib && role === 'front') {   // 校正時噴嘴的位置＝螢幕中央
    const x = calib.tip[0] * W, y = calib.tip[1] * H, r = W / 80;
    vctx.strokeStyle = 'rgba(255,255,0,.8)'; vctx.beginPath(); vctx.moveTo(x - r, y); vctx.lineTo(x + r, y); vctx.moveTo(x, y - r); vctx.lineTo(x, y + r); vctx.stroke();
  }
}

const tg = $('target'), tctx = tg.getContext('2d');
let flick = 0;
function drawTarget() {
  const W = tg.width, H = tg.height, cx = W / 2, cy = H / 2, sx = W / 2, sy = H / 2;
  const X = (v) => cx + v * sx, Y = (v) => cy + v * sy;
  tctx.fillStyle = '#202124'; tctx.fillRect(0, 0, W, H);
  // 地面
  tctx.fillStyle = '#3c4043'; tctx.fillRect(0, Y(0.85), W, H);
  // 火焰：根部在 y≈0.75，大小隨剩餘火勢（這裡用藥劑噴在根部的時間粗估）
  const fire = Math.max(0, 1 - run.baseMs / 1000 / (AGENT_SEC * 0.6));
  flick += 0.2;
  if (fire > 0) {
    for (let i = 0; i < 7; i++) {
      const fx = X(-0.55 + i * 0.18), h = (0.55 + 0.25 * Math.sin(flick + i * 1.7)) * fire;
      const g = tctx.createLinearGradient(0, Y(0.8), 0, Y(0.8 - h * 1.4));
      g.addColorStop(0, '#ffdd55'); g.addColorStop(0.5, '#ff7a1a'); g.addColorStop(1, 'rgba(220,40,0,0)');
      tctx.fillStyle = g; tctx.beginPath();
      tctx.moveTo(fx - sx * 0.12, Y(0.8)); tctx.quadraticCurveTo(fx, Y(0.8 - h * 2.2), fx + sx * 0.12, Y(0.8)); tctx.fill();
    }
  } else { tctx.fillStyle = '#81c995'; tctx.font = '20px sans-serif'; tctx.textAlign = 'center'; tctx.fillText('火已撲滅', cx, cy); }
  // 根部範圍
  tctx.strokeStyle = 'rgba(129,201,149,.8)'; tctx.setLineDash([5, 4]);
  tctx.strokeRect(X(-BASE_ZONE.x), Y(BASE_ZONE.y0), BASE_ZONE.x * 2 * sx, (BASE_ZONE.y1 - BASE_ZONE.y0) * sy); tctx.setLineDash([]);
  tctx.fillStyle = 'rgba(129,201,149,.9)'; tctx.font = '12px sans-serif'; tctx.textAlign = 'left'; tctx.fillText('火源根部', X(-BASE_ZONE.x) + 4, Y(BASE_ZONE.y0) - 4);
  // 準星與噴射
  const a = meas.aim;
  if (a) {
    if (meas.spraying) {
      tctx.fillStyle = 'rgba(255,255,255,.35)';
      tctx.beginPath(); tctx.moveTo(cx - 10, H); tctx.lineTo(X(a.x) - 22, Y(a.y)); tctx.lineTo(X(a.x) + 22, Y(a.y)); tctx.lineTo(cx + 10, H); tctx.fill();
    }
    tctx.strokeStyle = meas.atBase ? '#81c995' : '#fdd663'; tctx.lineWidth = 2;
    tctx.beginPath(); tctx.arc(X(a.x), Y(a.y), 10, 0, Math.PI * 2); tctx.moveTo(X(a.x) - 16, Y(a.y)); tctx.lineTo(X(a.x) + 16, Y(a.y));
    tctx.moveTo(X(a.x), Y(a.y) - 16); tctx.lineTo(X(a.x), Y(a.y) + 16); tctx.stroke(); tctx.lineWidth = 1;
  } else {
    tctx.fillStyle = '#9aa0a6'; tctx.font = '14px sans-serif'; tctx.textAlign = 'center';
    tctx.fillText(calib ? '看不到噴嘴標記' : '尚未校正', cx, 24);
  }
}

function drawPanel() {
  const set = (id, on, bad) => { $(id).classList.toggle('on', !!on); $(id).classList.toggle('bad', !!bad); };
  set('lP', calib && !run.pinIn, false);
  set('lA', meas.atBase, meas.aim && meas.aim.y < TOO_HIGH && meas.squeeze);
  set('lS1', meas.spraying, meas.squeeze && run.pinIn);
  set('lS2', meas.sweeping && meas.spraying, false);
  $('agent').firstElementChild.style.width = (run.agent * 100).toFixed(1) + '%';
  const pct = (v) => run.sprayMs ? Math.round(v / run.sprayMs * 100) + '%' : '—';
  const d = meas.dist, dMin = +$('dMin').value, dMax = +$('dMax').value;
  $('stats').innerHTML = [
    ['距離', d == null ? '—' : `${d.toFixed(2)} m ${d < dMin - DIST_GRACE ? '（太近）' : d > dMax + DIST_GRACE ? '（太遠）' : '（適當）'}`],
    ['瞄準', meas.aim ? `左右 ${meas.aim.x.toFixed(2)}　上下 ${meas.aim.y.toFixed(2)}` : '—'],
    ['身體', meas.crouch ? '壓低' : '站直'],
    ['開始噴射', run.firstSpray == null ? '—' : `${((run.firstSpray - run.t0) / 1000).toFixed(1)} 秒`],
    ['噴射時間', `${(run.sprayMs / 1000).toFixed(1)} 秒`],
    ['對準根部', pct(run.baseMs)],
    ['左右掃射', role === 'side' ? '側面無法判斷' : pct(run.sweepMs)],
    ['錯誤', `${run.errors} 次`],
  ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
}

// ---------- 主迴圈 ----------
let last = performance.now(), fpsT = 0, frames = 0, fps = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, now - last); last = now;
  if (stream && video.readyState >= 2) {
    pctx.save();
    if (mirror) { pctx.translate(PW, 0); pctx.scale(-1, 1); }
    pctx.drawImage(video, 0, 0, PW, PH); pctx.restore();
    track(pctx.getImageData(0, 0, PW, PH));
    if (pose && now - lastPoseT > Math.max(45, poseMs * 4)) {   // 骨架約每秒 20 次；電腦較慢時自動降頻，顏色追蹤保持流暢
      lastPoseT = now; const t0 = performance.now();
      try {
        const r = pose.detectForVideo(video, now);
        poseLm = r.landmarks?.[0]?.map((p) => ({ ...p, x: mirror ? 1 - p.x : p.x })) || null;
      } catch {}
      poseMs = performance.now() - t0;
    }
    if (calRun) calibStep(now);
    update(now, dt);
    drawView();
    frames++; if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; $('perf').textContent = `${video.videoWidth}×${video.videoHeight}　${fps} fps　骨架 ${pose ? poseMs.toFixed(0) + ' ms' : '載入中…'}`; }
  }
  drawTarget(); drawPanel();
}
requestAnimationFrame(loop);
