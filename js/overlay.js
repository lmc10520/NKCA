import * as THREE from 'three';
import { cm2w } from './util.js';

// ---------- 簡報平面圖層：把 SVG（逃生動線、集合點……）平鋪在模型的平面座標上 ----------
// SVG 的整張畫板（viewBox）對應到一個平面範圍 frame = [x0, y0, x1, y1]（Fusion 座標，cm）：
//   畫板左上角 = (x0, y1)、右下角 = (x1, y0)，也就是北（+Y）朝上的俯視平面。
// 底圖用網頁「下載平面底圖」取得，範圍寫在檔名裡；在 Illustrator 以底圖為畫板描線後輸出 SVG。
// SVG 裡的 <image>（底圖本身）會自動忽略，所以不必刪掉底圖圖層。
export class PlanOverlay {
  constructor(scene, renderer, site) {
    this.scene = scene;
    this.frame = site.planFrame_cm || [-4000, 2000, 36000, 30000];
    this.z = site.planZ_cm ?? 150;
    this.maxTex = Math.min(renderer.capabilities.maxTextureSize || 4096, matchMedia('(pointer:coarse)').matches ? 4096 : 8192);
    this.aniso = renderer.capabilities.getMaxAnisotropy();
    this.items = [];
    this.seq = 0;
  }

  // layers：[{ src, frame, z, depth }]；換頁時整組替換
  async show(layers) {
    const seq = ++this.seq;
    this.clear();
    for (const L of layers || []) {
      try {
        const mesh = await this.build(L);
        if (seq !== this.seq) { this.dispose(mesh); return; }   // 載入途中已換頁
        this.scene.add(mesh); this.items.push(mesh);
      } catch (e) { console.warn('[plan] 讀不到', L.src, e); this.onError?.(L.src); }
    }
  }

  clear() {
    for (const m of this.items) { this.scene.remove(m); this.dispose(m); }
    this.items = [];
  }
  dispose(m) { m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
  set visible(v) { for (const m of this.items) m.visible = v; }

  async build(L) {
    const [x0, y0, x1, y1] = L.frame || this.frame;
    const wcm = x1 - x0, hcm = y1 - y0;
    // 解析度：長邊最多 maxTex 像素，至少 2 cm／像素
    const k = Math.min(this.maxTex / Math.max(wcm, hcm), 0.5);
    const W = Math.round(wcm * k), H = Math.round(hcm * k);

    const txt = await (await fetch(L.src, { cache: 'no-cache' })).text();
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName !== 'svg') throw new Error('不是 SVG');
    svg.querySelectorAll('image').forEach((n) => n.remove());   // 底圖不要
    if (!svg.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width')) || W, h = parseFloat(svg.getAttribute('height')) || H;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('preserveAspectRatio', 'none');   // 畫板四邊＝範圍四邊
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
    URL.revokeObjectURL(url);

    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(img, 0, 0, W, H);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = this.aniso;

    const depth = !!L.depth;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, depthTest: depth, depthWrite: false,
      toneMapped: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wcm / 100, hcm / 100), mat);
    mesh.rotation.x = -Math.PI / 2;   // 平面朝上，圖的上方＝模型 +Y（北側）
    mesh.position.copy(cm2w([(x0 + x1) / 2, (y0 + y1) / 2, L.z ?? this.z]));
    mesh.renderOrder = depth ? 5 : 900;   // 不做遮擋時永遠畫在最上層
    mesh.frustumCulled = false;
    mesh.userData.plan = true;
    return mesh;
  }

  update(dt) {
    for (const m of this.items) if (m.material.opacity < 1) m.material.opacity = Math.min(1, m.material.opacity + dt * 2.5);
  }
}
