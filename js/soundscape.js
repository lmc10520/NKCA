import { cm2w, listFolder, isMobile } from './util.js';

// ---------- 建築聲景（Soundscape Architecture） ----------
// 依「目前的模式（外觀／樹冠大廳／榕樹廣場）＋鏡頭看的位置＋縮放距離＋晝夜＋天氣」決定要聽到哪個空間的聲音。
// 設定在 config/soundscape.json；音檔放在 audio/soundscape/<區域 id>/，丟進資料夾就會自動播放（不用改設定）。
//
// 兩種區域：
//   底景（bed）：同一時間只有一個，依 priority 選最高的符合者；切換時交叉淡入淡出。
//                資料夾沒有音檔的區域會被略過，改用下一個符合的區域（不會突然安靜）。
//   疊加（layer: true）：可同時多個，疊在底景上，音量隨距離漸弱（例如噴泉水聲、雨聲）。
//
// 聲音路徑：每段音檔 → 片段增益（淡入淡出）→ 區域增益 → 低通濾波 → 聲景總音量 → 鋼琴避讓（ducking）→ 總開關 → 喇叭
// 循環：同一個檔案或多個檔案輪流，每段結尾和下一段重疊 loopCrossfade_s 秒（等功率曲線），所以沒有斷點，
//       也不需要事先把音檔剪成完美循環。

const STORE = 'nkca.sound', STORE_VOL = 'nkca.soundVol';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
// 等功率淡入／淡出曲線（不相關的環境音交叉時，音量不會在中間凹下去）
const CURVE_N = 64;
const UP = new Float32Array(CURVE_N), DOWN = new Float32Array(CURVE_N);
for (let i = 0; i < CURVE_N; i++) { const x = i / (CURVE_N - 1); UP[i] = Math.sin((x * Math.PI) / 2); DOWN[i] = Math.cos((x * Math.PI) / 2); }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Soundscape {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.zones = (cfg.zones || []).filter((z) => z && z.id && z.enabled !== false).map((z) => ({
      ...z,
      folder: (z.folder || `audio/soundscape/${z.id}`).replace(/\/$/, ''),
      priority: z.priority ?? 0,
      volume: z.volume ?? 1,
      status: 'unknown',   // unknown → listing → ready（有檔案）／empty（沒有檔案，靜默略過）
      files: [],
    }));
    this.byId = new Map(this.zones.map((z) => [z.id, z]));
    this.defaultId = cfg.default || this.zones.find((z) => !z.layer)?.id;
    this.xfade = cfg.crossfade_s ?? 2.5;
    this.loopX = cfg.loopCrossfade_s ?? 3;
    this.hold = cfg.hold_s ?? 0.6;
    this.duckCfg = { level: 0.25, attack_s: 0.6, release_s: 2.5, ...(cfg.duck || {}) };
    this.cacheBytes = (cfg.cacheMB ?? (isMobile ? 80 : 180)) * 1048576;
    const saved = store.get(STORE), vol = parseFloat(store.get(STORE_VOL));
    this.on = saved == null ? cfg.defaultOn !== false : saved === '1';
    this.volume = isFinite(vol) ? vol : cfg.masterVolume ?? 0.7;
    this.ctx = null; this.unlocked = false;
    this.players = new Map();     // 區域 id → ZonePlayer
    this.buffers = new Map();     // 網址 → { p: Promise<AudioBuffer|null>, bytes, used }
    this.bed = null; this.pending = null;
    this.ducked = false; this.duckTimer = 0;
    this.ctxInfo = null; this.lastEval = 0;
    this.onChange = null;         // (狀態) => void：更新按鈕、設定面板
    this.listeners();
  }

  // ---------- 解鎖：瀏覽器規定要有使用者操作後才能出聲 ----------
  listeners() {
    const evs = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
    const tryUnlock = () => {
      if (!this.on) return;           // 關著就不必建立；之後按開關本身就是使用者操作
      this.unlock();
      if (this.ctx?.state === 'running') evs.forEach((e) => removeEventListener(e, tryUnlock, true));
    };
    evs.forEach((e) => addEventListener(e, tryUnlock, true));
    this._tryUnlock = tryUnlock;
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (this.on) this.ctx.resume().catch(() => {});
    });
  }
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'playback' });
        // iOS：靜音鍵打開時 Web Audio 預設不出聲；audioSession（Safari 16.4+）改成播放類別
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
        const c = this.ctx;
        this.out = c.createGain(); this.out.gain.value = 0; this.out.connect(c.destination);
        this.duckG = c.createGain(); this.duckG.connect(this.out);
        this.bus = c.createGain(); this.bus.gain.value = this.volume; this.bus.connect(this.duckG);
        if (this.ducked) this.duckG.gain.value = this.duckCfg.level;
        this.tickTimer = setInterval(() => this.tick(), 400);   // 排程不靠畫面迴圈：載入卡頓時也不會斷音
        this.listAll();
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      if (!this.unlocked && this.ctx.state === 'running') {
        this.unlocked = true;
        this.applyOn(true);
        this.emit();
      } else if (!this.unlocked) {
        // 有些瀏覽器 resume 是非同步的
        this.ctx.onstatechange = () => { if (this.ctx.state === 'running' && !this.unlocked) { this.unlocked = true; this.applyOn(true); this.emit(); } };
      }
    } catch (e) { console.warn('[soundscape] 無法啟用聲音', e); }
  }

  // 一次查完所有資料夾（GitHub Pages 上只需要一個請求）
  listAll() {
    for (const z of this.zones) this.listZone(z);
  }
  async listZone(z) {
    if (z.status !== 'unknown') return;
    z.status = 'listing';
    try { z.files = await listFolder(z.folder); } catch { z.files = []; }
    z.status = z.files.length ? 'ready' : 'empty';
    if (z.status === 'empty') console.info(`[soundscape] ${z.id}：${z.folder}/ 還沒有音檔，略過`);
    this.lastEval = 0;   // 立刻重新選擇區域
  }

  // ---------- 開關、音量 ----------
  setOn(v) {
    this.on = !!v; store.set(STORE, this.on ? '1' : '0');
    if (this.on) this.unlock();
    this.applyOn();
    this.emit();
  }
  applyOn(fromUnlock) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, g = this.out.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.on ? 1 : 0, now + (fromUnlock ? 1.5 : 0.4));
    clearTimeout(this.offTimer);
    if (this.on) this.ctx.resume().catch(() => {});
    else this.offTimer = setTimeout(() => { if (!this.on) this.ctx.suspend().catch(() => {}); }, 600);   // 關掉後暫停，省電
  }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, +v)); store.set(STORE_VOL, String(this.volume));
    if (this.bus) this.bus.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }
  // 鋼琴播放時壓低環境音；停止後延遲一下再回來（換曲時不會忽大忽小）
  duck(on) {
    clearTimeout(this.duckTimer);
    const apply = (v) => {
      this.ducked = v;
      if (!this.duckG) return;
      const now = this.ctx.currentTime, g = this.duckG.gain, d = this.duckCfg;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(v ? d.level : 1, now + (v ? d.attack_s : d.release_s));
    };
    if (on) { if (!this.ducked) apply(true); }
    else if (this.ducked) this.duckTimer = setTimeout(() => apply(false), 1200);
  }
  get state() {
    const z = this.bed && this.byId.get(this.bed);
    const want = this.ctxInfo && this.pickBed(this.ctxInfo, true);
    return { on: this.on, unlocked: this.unlocked, volume: this.volume, zone: z, wanted: want && want !== z ? want : null, layers: [...this.players.values()].filter((p) => p.zone.layer && p.level > 0.02).map((p) => p.zone) };
  }
  emit() { this.onChange?.(this.state); }

  // ---------- 判斷區域 ----------
  // info：{ mode, target(Vector3), camera(Vector3), dist（鏡頭到目標 m）, halls, night(0–1), rainy, storm }
  match(z, info, current) {
    const t = z.trigger || {};
    if (t.modes && !t.modes.includes(info.mode)) return 0;
    if (t.minDist_m != null && info.dist < t.minDist_m * (current ? 0.92 : 1)) return 0;
    if (t.maxDist_m != null && info.dist > t.maxDist_m * (current ? 1.08 : 1)) return 0;
    if (t.time === 'night' && info.night < 0.5) return 0;
    if (t.time === 'day' && info.night >= 0.5) return 0;
    if (t.weather) {
      const w = info.storm ? 'storm' : info.rainy ? 'rain' : 'clear';
      if (!t.weather.includes(w) && !(w === 'storm' && t.weather.includes('rain'))) return 0;
    }
    if (t.floors) for (const [h, f] of Object.entries(t.floors)) if (info.halls?.[h] !== f) return 0;
    const p = t.point === 'camera' ? info.camera : info.target;
    const x = p.x * 100, y = -p.z * 100;   // 網頁座標 → Fusion cm（水平）
    const grow = current ? 1.08 : 1;       // 已在區域內時邊界放寬一點，避免在邊界來回切換
    if (t.rect_cm) {
      const [x0, y0, x1, y1] = t.rect_cm, mx = ((x1 - x0) * (grow - 1)) / 2, my = ((y1 - y0) * (grow - 1)) / 2;
      if (x < x0 - mx || x > x1 + mx || y < y0 - my || y > y1 + my) return 0;
      return 1;
    }
    if (t.center_cm) {
      const r = (t.radius_cm || 3000) * grow, d = Math.hypot(x - t.center_cm[0], y - t.center_cm[1]);
      if (d > r) return 0;
      // 疊加層：inner_cm 內全音量，往外漸弱到 radius_cm
      if (z.layer) return 1 - smooth(t.inner_cm ?? r * 0.3, r, d);
      return 1;
    }
    return 1;
  }
  pickBed(info, ignoreStatus) {
    let best = null;
    for (const z of this.zones) {
      if (z.layer) continue;
      if (!ignoreStatus && z.status === 'empty') continue;
      if (!this.match(z, info, z.id === this.bed)) continue;
      if (!best || z.priority > best.priority) best = z;
    }
    if (!best) { const d = this.byId.get(this.defaultId); if (d && (ignoreStatus || d.status !== 'empty')) best = d; }
    return best;
  }
  modeOpts(z, mode) { return { ...z, ...(z.byMode?.[mode] || {}) }; }

  // 每幀從主迴圈呼叫（內部節流 5 次／秒）
  update(info) {
    this.ctxInfo = info;
    if (!this.ctx || !this.unlocked || !this.on) return;
    const now = performance.now();
    if (now - this.lastEval < 200) return;
    this.lastEval = now;
    const bed = this.pickBed(info);
    const id = bed?.id || null;
    // 停留 hold_s 秒才切換（快速掃過時不會一直換）
    if (id !== this.bed) {
      if (this.pending?.id !== id) this.pending = { id, since: now };
      const ready = !bed || bed.status !== 'listing';
      if (ready && (this.bed == null || now - this.pending.since >= this.hold * 1000)) this.switchBed(id);
    } else this.pending = null;
    if (bed) this.listZone(bed);
    // 疊加層
    for (const z of this.zones) {
      if (!z.layer) continue;
      if (z.status === 'empty') continue;
      const k = this.match(z, info, false);
      const o = this.modeOpts(z, info.mode);
      const p = this.players.get(z.id);
      if (k > 0.001) {
        this.listZone(z);
        if (z.status !== 'ready') continue;
        const pl = p || this.player(z);
        pl.setLevel(k * o.volume, 0.6, o.lowpass_hz);
      } else if (p) p.setLevel(0, 1.2);
    }
    this.info = info;
    // 晝夜切換、換區時讓底景也套用模式專屬的設定
    if (this.bed) { const z = this.byId.get(this.bed), o = this.modeOpts(z, info.mode); this.players.get(this.bed)?.setLevel(o.volume, this.xfade, o.lowpass_hz, true); }
  }
  switchBed(id) {
    this.bed = id; this.pending = null;
    const out = () => { for (const [pid, p] of this.players) if (!p.zone.layer && pid !== this.bed) p.setLevel(0, this.xfade); };
    if (id) {
      const z = this.byId.get(id), o = this.modeOpts(z, this.info?.mode || this.ctxInfo?.mode);
      const p = this.players.get(id) || this.player(z);
      // 新區域的第一段音檔真的開始播了，舊的才淡出（下載、解碼期間不會出現空白）
      if (p.clips.length) out();
      else { p.onStart = out; clearTimeout(this.outTimer); this.outTimer = setTimeout(out, 10000); }
      p.setLevel(o.volume, this.xfade, o.lowpass_hz);
      console.info(`[soundscape] → ${z.name || id}（${z.folder}/）`);
    } else out();
    this.emit();
  }
  player(z) { const p = new ZonePlayer(this, z); this.players.set(z.id, p); return p; }

  // 排程：每 0.4 秒檢查一次，把下一段音檔提前排好
  tick() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    for (const [id, p] of this.players) {
      p.tick();
      if (p.idle()) { p.dispose(); this.players.delete(id); }
    }
    this.trimCache();
  }

  // ---------- 音檔解碼與快取 ----------
  buffer(url) {
    let e = this.buffers.get(url);
    if (!e) {
      e = { bytes: 0, used: performance.now() };
      e.p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((ab) => (ab ? new Promise((res) => this.ctx.decodeAudioData(ab, res, () => res(null))) : null))
        .then((b) => { if (b) e.bytes = b.length * b.numberOfChannels * 4; else console.warn('[soundscape] 無法解碼', decodeURIComponent(url)); return b; })
        .catch(() => null);
      this.buffers.set(url, e);
    }
    e.used = performance.now();
    return e.p;
  }
  trimCache() {
    let total = 0;
    for (const e of this.buffers.values()) total += e.bytes;
    if (total <= this.cacheBytes) return;
    const inUse = new Set();
    for (const p of this.players.values()) for (const u of p.inUse()) inUse.add(u);
    const old = [...this.buffers.entries()].filter(([u, e]) => e.bytes && !inUse.has(u)).sort((a, b) => a[1].used - b[1].used);
    for (const [u, e] of old) { if (total <= this.cacheBytes) break; total -= e.bytes; this.buffers.delete(u); }
  }
}

// 一個區域的播放器：負責輪流播放資料夾裡的檔案，段與段之間交叉淡入淡出
class ZonePlayer {
  constructor(engine, zone) {
    this.e = engine; this.zone = zone;
    const c = engine.ctx;
    this.gain = c.createGain(); this.gain.gain.value = 0;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 0.5;
    this.gain.connect(this.lp).connect(engine.bus);
    this.level = 0; this.target = 0; this.clips = []; this.next = null; this.last = -1; this.zeroAt = 0;
    this.loading = false;
  }
  setLevel(v, sec, lowpass, soft) {
    const c = this.e.ctx, now = c.currentTime;
    if (lowpass !== undefined) this.lp.frequency.setTargetAtTime(lowpass || 20000, now, 0.4);
    if (Math.abs(v - this.target) < 0.005) return;
    this.target = v;
    const g = this.gain.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    if (soft) g.setTargetAtTime(v, now, 0.5);
    else g.linearRampToValueAtTime(v, now + Math.max(0.05, sec));
    this.level = v;
    if (v > 0) { this.zeroAt = 0; this.tick(); }
    else this.zeroAt = now + sec;
  }
  // 依晝夜挑可播的檔案：day_ 開頭只在白天、night_ 開頭只在夜晚，其他都可以
  pool() {
    const night = (this.e.info?.night ?? 0) >= 0.5, all = this.zone.files;
    const ok = all.filter((u) => { const n = decodeURIComponent(u.split('/').pop()).toLowerCase(); return night ? !n.startsWith('day_') : !n.startsWith('night_'); });
    return ok.length ? ok : all;
  }
  pick() {
    const list = this.pool();
    if (!list.length) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && list[i] === this.lastUrl) i = (i + 1) % list.length;
    return list[i];
  }
  inUse() { return [...this.clips.map((x) => x.url), this.next?.url].filter(Boolean); }
  tick() {
    if (this.target <= 0 && !this.clips.length) return;
    const c = this.e.ctx, now = c.currentTime;
    this.clips = this.clips.filter((x) => x.end > now);
    if (this.target <= 0) return;   // 淡出中：讓現有片段自然結束，不再排新的
    const cur = this.clips[this.clips.length - 1];
    if (!cur) { this.startFirst(); return; }
    // 結尾前 6 秒準備好下一段（解碼可能要一點時間）
    if (!this.next && cur.end - now < 6 + cur.xf) this.prepare();
    if (this.next?.buf && !cur.followed && cur.end - cur.xf - now < 1.5) {
      cur.followed = true;
      this.schedule(this.next, Math.max(now + 0.05, cur.end - cur.xf), cur.xf, 0);
      this.next = null;
    }
  }
  prepare() {
    const url = this.pick(); if (!url) return;
    const n = { url, buf: null };
    this.next = n;
    this.e.buffer(url).then((b) => { if (b) n.buf = b; else if (this.next === n) { this.next = null; this.zone.files = this.zone.files.filter((u) => u !== url); } });
  }
  async startFirst() {
    if (this.loading) return;
    this.loading = true;
    const url = this.pick();
    const buf = url && (await this.e.buffer(url));
    this.loading = false;
    if (!buf) { if (url) this.zone.files = this.zone.files.filter((u) => u !== url); if (!this.zone.files.length) this.zone.status = 'empty'; return; }
    if (this.target <= 0 || this.clips.length) return;
    // 從檔案中間的隨機位置開始，回到同一區時不會每次都從頭
    const off = buf.duration > 20 ? Math.random() * buf.duration * 0.6 : 0;
    this.schedule({ url, buf }, this.e.ctx.currentTime + 0.05, 0.8, off);
  }
  schedule({ url, buf }, when, fadeIn, offset) {
    const c = this.e.ctx;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    src.connect(g).connect(this.gain);
    const len = buf.duration - offset;
    const xf = Math.min(this.e.loopX, len / 3, buf.duration / 3);
    const fi = Math.min(fadeIn, len / 3);
    const end = when + len;
    // 淡入曲線結束後維持在 1，直到結尾的淡出曲線（兩段曲線不重疊：fi、xf 都不超過長度的 1/3）
    if (fi > 0.01) g.gain.setValueCurveAtTime(UP, when, fi); else g.gain.setValueAtTime(1, when);
    g.gain.setValueCurveAtTime(DOWN, end - xf, xf);
    src.start(when, offset);
    src.stop(end + 0.05);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch {} };
    this.lastUrl = url;
    this.clips.push({ src, g, url, end, xf, followed: false });
    const cb = this.onStart; this.onStart = null; cb?.();
  }
  idle() { return this.target <= 0 && this.zeroAt && this.e.ctx.currentTime > this.zeroAt + 0.5; }
  dispose() {
    for (const x of this.clips) { try { x.src.stop(); } catch {} }
    this.clips = [];
    try { this.gain.disconnect(); this.lp.disconnect(); } catch {}
  }
}
