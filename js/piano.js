import * as THREE from 'three';
import { cm2w, listFolder } from './util.js';
import { torsoGeometry, headGeometry, hairGeometry, legGeometry, armGeometry } from './figures.js';

// ---------- 路人鋼琴 ----------
// config/piano.json：pos_cm（鋼琴中心，cm）、rot_deg（鍵盤朝向，0＝琴鍵在南側、彈奏者面向北）、folder（mp3 資料夾）。
// 點鋼琴 → 路人坐下來彈，隨機播放 folder 裡的 mp3；下方出現播放列（暫停／繼續、進度、音量、結束）。
// 曲目清單：GitHub Pages 上自動向 GitHub 查詢資料夾內容；別處架站時讀 folder/list.json（["a.mp3", ...]），
// 所以只要把 mp3 上傳到資料夾就會自動加入。
// 看得出可以點：滑鼠移到鋼琴上會發光、游標變手形並跳出提示；手機沒有 hover，鏡頭靠近時在鋼琴上方常駐小提示。
export class Piano {
  constructor(scene, cfg) {
    this.cfg = cfg || {};
    this.folder = (this.cfg.folder || 'audio/piano').replace(/\/$/, '');
    this.group = new THREE.Group(); this.group.name = 'Piano';
    if (!this.cfg.pos_cm) return;
    this.group.position.copy(cm2w(this.cfg.pos_cm));
    this.group.rotation.y = THREE.MathUtils.degToRad(this.cfg.rot_deg || 0);
    this.build();
    scene.add(this.group);
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.audio.volume = 0.8;
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('timeupdate', () => this.syncBar());
    this.audio.addEventListener('play', () => this.syncBar());
    this.audio.addEventListener('pause', () => this.syncBar());
    // 播放狀態給聲景用（鋼琴彈奏時環境音自動降低）
    for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) this.audio.addEventListener(ev, () => this.emitState());
    this.list = null; this.playing = false; this.t = 0; this.last = -1;
    this.hoverK = 0; this.hovered = false; this.hintK = 0; this.hint = false;
    this.ui();
  }

  build() {
    const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.18, metalness: 0.2 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.4 });
    const keyBlack = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xb08d3c, roughness: 0.35, metalness: 0.8 });
    this.glowMats = [black, white, keyBlack, gold];   // hover 時一起發光（琴蓋另外複製了一份材質，下面補上）
    // 平台鋼琴外形（俯視）：琴鍵在 +z（南側），琴尾在 -z。長 2.1 m、寬 1.5 m
    const s = new THREE.Shape();
    s.moveTo(-0.75, 0.55); s.lineTo(0.75, 0.55); s.lineTo(0.75, -0.2);
    s.bezierCurveTo(0.75, -0.9, 0.3, -1.0, 0.15, -1.3);
    s.bezierCurveTo(0.0, -1.55, -0.45, -1.6, -0.6, -1.35);
    s.bezierCurveTo(-0.75, -1.1, -0.75, -0.6, -0.75, -0.3); s.closePath();
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.32, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 }), black);
    body.rotation.x = Math.PI / 2; body.position.y = 0.98;   // 外形在 xz 平面，厚度往下
    // 掀起的琴蓋（以右側為軸，約 35°）
    const lid = new THREE.Mesh(new THREE.ShapeGeometry(s), black);
    lid.rotation.x = Math.PI / 2; lid.position.set(0, 0.995, 0);   // 和琴身同一個方向（琴鍵在 +z）
    const lidPivot = new THREE.Group(); lidPivot.position.set(0.75, 0, 0); lid.position.x -= 0.75; lidPivot.add(lid); lidPivot.rotation.z = THREE.MathUtils.degToRad(-35);
    lid.material = black.clone(); lid.material.side = THREE.DoubleSide; this.glowMats.push(lid.material);
    const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.62), black); prop.position.set(-0.45, 1.25, -0.5); prop.rotation.z = -0.55;
    // 鍵盤
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.06, 0.2), white); bed.position.set(0, 0.75, 0.66);
    const cheekL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.26), black); cheekL.position.set(-0.74, 0.76, 0.66);
    const cheekR = cheekL.clone(); cheekR.position.x = 0.74;
    const keyGeo = new THREE.BoxGeometry(0.014, 0.025, 0.11), keys = new THREE.InstancedMesh(keyGeo, keyBlack, 36);
    const m = new THREE.Matrix4(); let n = 0;
    for (let i = 0; i < 52 && n < 36; i++) { const k = i % 7; if (k === 2 || k === 6) continue; m.makeTranslation(-0.69 + i * 0.0265 + 0.013, 0.79, 0.62); keys.setMatrixAt(n++, m); }
    keys.count = n;
    const fall = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.12, 0.04), black); fall.position.set(0, 0.86, 0.56);
    const desk = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.28, 0.02), black); desk.position.set(0, 1.12, 0.5); desk.rotation.x = -0.25;
    // 腳、踏板
    const legGeo = new THREE.CylinderGeometry(0.05, 0.035, 0.66, 10);
    const legs = [[-0.65, 0.42], [0.65, 0.42], [-0.15, -1.25]].map(([x, z]) => { const l = new THREE.Mesh(legGeo, black); l.position.set(x, 0.33, z); return l; });
    const lyre = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.04), black); lyre.position.set(0, 0.3, 0.3);
    const pedals = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.015, 0.08), gold); pedals.position.set(0, 0.05, 0.36);
    // 琴椅
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.36), black); seat.position.y = 0.5;
    const cush = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.04, 0.32), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 })); cush.position.y = 0.56;
    bench.add(seat, cush);
    for (const [x, z] of [[-0.27, -0.14], [0.27, -0.14], [-0.27, 0.14], [0.27, 0.14]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.46, 0.04), black); l.position.set(x, 0.23, z); bench.add(l); }
    bench.position.set(0, 0, 1.15);
    this.group.add(body, lidPivot, prop, bed, cheekL, cheekR, keys, fall, desk, ...legs, lyre, pedals, bench);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    for (const m of this.glowMats) m.emissive.set(0xffd08a);
    // 外框發亮：琴身外面套一層略大的背面殼（只畫背面＝看起來是一圈描邊），hover 時淡入
    const og = body.geometry.clone(); og.computeBoundingBox();
    const oc = og.boundingBox.getCenter(new THREE.Vector3()); og.translate(-oc.x, -oc.y, -oc.z);
    this.outline = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ color: 0xffc061, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    this.outline.position.copy(oc); this.outline.scale.setScalar(1.045); this.outline.raycast = () => {}; this.outline.visible = false;
    body.add(this.outline);

    // 地面光暈：hover 時亮起；手機上鏡頭靠近時輕輕呼吸，提示這裡可以點
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g2 = cv.getContext('2d'), grd = g2.createRadialGradient(64, 64, 18, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,190,90,0)'); grd.addColorStop(0.55, 'rgba(255,190,90,0.85)'); grd.addColorStop(1, 'rgba(255,190,90,0)');
    g2.fillStyle = grd; g2.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.halo.rotation.x = -Math.PI / 2; this.halo.position.set(0, 0.03, -0.2); this.halo.renderOrder = 3;
    this.halo.raycast = () => {};   // 光暈不參與點選
    this.halo.visible = false;
    this.group.add(this.halo);

    // 彈奏的路人（坐在琴椅上，面向琴鍵 -z）
    const skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, color: 0x3f6fb5 });
    const pants = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, color: 0x2d3440 });
    const p = new THREE.Group();
    const torso = new THREE.Mesh(torsoGeometry(), shirt); torso.position.y = -0.42;
    const head = new THREE.Mesh(headGeometry(), skin); head.position.y = -0.42;
    const hair = new THREE.Mesh(hairGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x2b2118 }));
    hair.position.y = -0.42;
    p.add(torso, head, hair);
    // 大腿往前（水平）、小腿往下
    for (const sx of [-1, 1]) {
      const thigh = new THREE.Mesh(legGeometry(), pants); thigh.scale.set(1, 0.55, 1); thigh.rotation.x = -Math.PI / 2; thigh.position.set(sx * 0.1, 0.5, 0); p.add(thigh);
      const shin = new THREE.Mesh(legGeometry(), pants); shin.scale.set(1, 0.55, 1); shin.position.set(sx * 0.1, 0.5, 0.45); p.add(shin);
    }
    this.arms = [];
    for (const sx of [-1, 1]) {
      const a = new THREE.Mesh(armGeometry(), shirt); a.position.set(sx * 0.21, 1.0, 0); a.rotation.x = -1.0; p.add(a); this.arms.push(a);
    }
    p.rotation.y = Math.PI; p.position.set(0, 0, 1.15);
    p.visible = false;
    this.pianist = p; this.group.add(p);
  }

  // 點選判斷：回傳射線打到鋼琴的距離（沒打到為 null）
  hitDist(ray) {
    if (!this.cfg.pos_cm || !this.group.visible) return null;
    const h = ray.intersectObject(this.group, true)[0];
    return h ? h.distance : null;
  }
  hit(ray) { return this.hitDist(ray) != null; }
  // 鋼琴上方（提示文字的錨點，網頁座標）
  top(v) { return v.set(0, 1.9, -0.3).applyMatrix4(this.group.matrixWorld); }
  setHover(on) { this.hovered = !!on; }
  setHint(on) { this.hint = !!on; }
  get active() { return !!this.playing && !this.audio.paused; }
  emitState() { this.onState?.(this.active); }
  set muted(v) { if (this.audio) this.audio.muted = !!v; }

  async loadList() {
    if (this.list?.length) return this.list;
    return (this.list = await listFolder(this.folder));
  }

  async start() {
    const list = await this.loadList();
    if (!list.length) { this.onMessage?.(`還沒有曲子：請把 mp3 放到 ${this.folder}/`); return; }
    this.pianist.visible = true; this.playing = true;
    this.bar.classList.remove('hidden'); document.body.classList.add('pianoOn');
    this.next();
  }
  next() {
    if (!this.playing || !this.list?.length) return;
    let i = Math.floor(Math.random() * this.list.length);
    if (this.list.length > 1 && i === this.last) i = (i + 1) % this.list.length;
    this.last = i;
    this.audio.src = this.list[i];
    this.bar.querySelector('.pnTitle').textContent = decodeURIComponent(this.list[i].split('/').pop().replace(/\.mp3$/i, ''));
    this.audio.play().catch(() => {});
  }
  stop() {
    this.playing = false; this.audio.pause(); this.pianist.visible = false;
    this.bar.classList.add('hidden'); document.body.classList.remove('pianoOn');
    this.emitState();
  }
  toggle() { this.playing ? (this.audio.paused ? this.audio.play() : this.audio.pause()) : this.start(); }

  ui() {
    const b = document.createElement('div');
    b.id = 'pianoBar'; b.className = 'ui sheet hidden';
    b.innerHTML = `<span class="ms pnIcon">piano</span><button class="pnPlay ms" title="暫停／繼續">pause</button>
      <div class="pnMid"><div class="pnTitle"></div><div class="pnRow"><span class="pnCur">0:00</span><input class="pnSeek" type="range" min="0" max="1000" value="0"><span class="pnDur">0:00</span></div></div>
      <span class="ms pnVolI">volume_up</span><input class="pnVol" type="range" min="0" max="1" step="0.01" value="0.8" title="音量">
      <button class="pnNext ms" title="換一首">skip_next</button><button class="pnClose ms" title="結束">close</button>`;
    document.getElementById('app').appendChild(b);
    this.bar = b;
    const q = (c) => b.querySelector(c);
    q('.pnPlay').onclick = () => (this.audio.paused ? this.audio.play() : this.audio.pause());
    q('.pnNext').onclick = () => this.next();
    q('.pnClose').onclick = () => this.stop();
    q('.pnVol').oninput = (e) => { this.audio.volume = +e.target.value; q('.pnVolI').textContent = +e.target.value === 0 ? 'volume_off' : 'volume_up'; };
    q('.pnSeek').oninput = (e) => { if (this.audio.duration) this.audio.currentTime = (e.target.value / 1000) * this.audio.duration; };
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  syncBar() {
    if (!this.bar) return;
    const a = this.audio, f = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
    this.bar.querySelector('.pnPlay').textContent = a.paused ? 'play_arrow' : 'pause';
    this.bar.querySelector('.pnCur').textContent = f(a.currentTime);
    this.bar.querySelector('.pnDur').textContent = f(a.duration);
    if (a.duration) this.bar.querySelector('.pnSeek').value = Math.round((a.currentTime / a.duration) * 1000);
  }

  update(dt) {
    if (!this.cfg.pos_cm) return;
    // hover 發光、手機提示光暈（平滑淡入淡出）
    this.hoverK += ((this.hovered ? 1 : 0) - this.hoverK) * Math.min(1, dt * 10);
    this.hintK += ((this.hint ? 1 : 0) - this.hintK) * Math.min(1, dt * 4);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 420);
    const glow = this.hoverK * (0.05 + 0.03 * pulse);
    for (const m of this.glowMats) m.emissiveIntensity = glow;
    this.outline.material.opacity = this.hoverK * (0.75 + 0.25 * pulse); this.outline.visible = this.hoverK > 0.01;
    const ho = this.hoverK * 0.75 + this.hintK * (0.18 + 0.22 * pulse);
    this.halo.material.opacity = ho; this.halo.visible = ho > 0.01;
    if (!this.pianist?.visible) return;
    this.t += dt;
    const on = !this.audio.paused;
    this.arms.forEach((a, i) => { a.rotation.x = -1.0 + (on ? Math.sin(this.t * 9 + i * 1.7) * 0.06 : 0); a.rotation.z = (i ? -1 : 1) * (on ? 0.05 + Math.sin(this.t * 3 + i) * 0.05 : 0.05); });
    this.pianist.children[0].rotation.x = on ? Math.sin(this.t * 1.5) * 0.03 : 0;
  }
}
