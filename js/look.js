import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { isMobile } from './util.js';

// ---------- 畫質 ----------
// default（預設，所有裝置）：減面模型、無陰影、一般深度緩衝＋依鏡頭距離調整 near、依幀率自動調整解析度；
//   夜間光暈（bloom）、屋頂投射燈、廣場面光源照常開啟。
// high（高畫質，給效能好的電腦）：原模型、陰影、對數深度緩衝。
// 設定 → 畫質 切換（記在瀏覽器），或網址 ?q=high／?q=default。
const QKEY = 'nkca.quality';
export function qualityPref() {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'high' || q === 'default') return q;
  try { if (localStorage.getItem(QKEY) === 'high') return 'high'; } catch {}   // 舊版存的 low／auto 都視為預設
  return 'default';
}
export function setQualityPref(v) { try { v === 'high' ? localStorage.setItem(QKEY, 'high') : localStorage.removeItem(QKEY); } catch {} }
export const quality = qualityPref();
export const HIGH = quality === 'high';
export { isMobile };

// ---------- 色調映射：Khronos PBR Neutral ----------
// 原本的 ACES 會壓暗中間調、讓顏色變灰（看起來「霧霧、土土的」）；Neutral 在亮部以下幾乎不改變材質原色，
// 只把過亮的地方柔和地壓回 1。three r160 沒有內建，替換 CustomToneMapping 的內容來用。
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  `vec3 CustomToneMapping( vec3 color ) {
    const float StartCompression = 0.8 - 0.04;
    const float Desaturation = 0.15;
    color *= toneMappingExposure;
    float x = min( color.r, min( color.g, color.b ) );
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max( color.r, max( color.g, color.b ) );
    if ( peak < StartCompression ) return color;
    float d = 1.0 - StartCompression;
    float newPeak = 1.0 - d * d / ( peak + d - StartCompression );
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / ( Desaturation * ( peak - newPeak ) + 1.0 );
    return mix( color, vec3( newPeak ), g );
  }`);
export const TONE = THREE.CustomToneMapping;

// ---------- 最後一道後製：色調映射＋sRGB＋（線稿＋網點樣式時）網點化 ----------
// 只有需要後製（夜間光暈、網點）時才走這條；平常直接畫到畫面上，省一張浮點貼圖的頻寬（手機差很多）。
export class FinalPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null }, toneMappingExposure: { value: 1 }, uTone: { value: 1 },
      uDot: { value: 0 }, uCell: { value: 6 }, uRes: { value: new THREE.Vector2(1, 1) }, uInk: { value: new THREE.Color(0x15171a) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        #include <tonemapping_pars_fragment>
        uniform sampler2D tDiffuse; uniform float uTone, uDot, uCell; uniform vec2 uRes; uniform vec3 uInk;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          if (uTone > 0.5) c.rgb = CustomToneMapping(c.rgb);
          c = sRGBTransferOETF(c);
          if (uDot > 0.5) {
            // 網點（漫畫網點紙）：亮面留白、暗面與線條實黑，中間調依明暗換成 45° 網點，網點面積＝暗的程度
            float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            float t = clamp((0.94 - l) / 0.62, 0.0, 1.0);
            vec2 p = gl_FragCoord.xy;
            p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p / uCell;
            vec2 q = (fract(p) - 0.5) * uCell;
            float r = uCell * sqrt(t / 3.14159) * 1.02;
            float dotm = 1.0 - smoothstep(r - 0.6, r + 0.6, length(q));
            float ink = l < 0.36 ? 1.0 : (t > 0.0 ? dotm : 0.0);
            c.rgb = mix(vec3(1.0), uInk, ink);
          }
          gl_FragColor = c;
        }`,
      depthTest: false, depthWrite: false,
      toneMapped: false,   // 色調映射自己做（three 不再自動加入，避免重複定義）；sRGB 函式由 three 自動加入
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.getDrawingBufferSize(this.uniforms.uRes.value);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

// ---------- 動態解析度 ----------
// 依實際幀時間調整 pixelRatio：卡的時候降、順的時候升（手機上最有感）。鏡頭在動的時候才量。
export class AdaptiveRes {
  constructor({ min, max, apply }) {
    this.min = min; this.max = max; this.apply = apply;
    this.pr = max; this.acc = 0; this.n = 0; this.cool = 0;
  }
  sample(dtMs, moving) {
    this.cool -= dtMs;
    if (!moving || dtMs > 250) return;   // 切到背景、載入貼圖的長停頓不算
    this.acc += dtMs; this.n++;
    if (this.acc < 1000) return;
    const avg = this.acc / this.n; this.acc = 0; this.n = 0;
    if (this.cool > 0) return;
    let pr = this.pr;
    if (avg > 26 && pr > this.min) pr = Math.max(this.min, pr - 0.25);        // 低於約 38 fps
    else if (avg < 15 && pr < this.max) pr = Math.min(this.max, pr + 0.25);   // 高於約 66 fps 才升
    if (pr !== this.pr) { this.pr = pr; this.apply(pr); this.cool = 2500; }
  }
}
