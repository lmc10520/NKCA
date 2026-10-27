import * as THREE from 'three';
import { makeMatcher } from './util.js';

// 廳院裝修材質（config/finishes.json）：依物件名稱換成黑牆、原木、木頭漆黑、石紋。
// 紋理在 shader 裡依世界座標產生（不需 UV、不需貼圖檔），Fusion 重新匯出只要命名不變就會套用。
// 朝上的面鋪地板紋（xz 平面），牆面依法線主軸投影，同一個物件裡的地板和牆會各自對齊。
const PATTERNS = {
  // 木地板／木牆：長條木板（寬 w、長 len），板縫加深，木紋沿長邊拉長的雜訊
  wood: `
    vec2 q = fp / vec2(fLen, fW);
    float row = floor(q.y);
    q.x += fhash(vec2(row, 7.0)) * 3.0;
    vec2 cell = floor(q), f = fract(q);
    float plank = fhash(cell) - 0.5;
    float grain = fnoise(vec2(fp.x * 0.8, fp.y * 14.0) + cell * 13.0) - 0.5;
    float seam = 1.0 - (1.0 - smoothstep(0.0, 0.03, f.y) * (1.0 - smoothstep(0.97, 1.0, f.y))) * 0.55
                     - (1.0 - smoothstep(0.0, 0.006, f.x) * (1.0 - smoothstep(0.994, 1.0, f.x))) * 0.35;
    tint = (1.0 + plank * fVar + grain * fVar * 0.8) * seam;`,
  // 石材：方塊石板（邊長 fLen×fW），每塊明暗不同，加大理石般的雲紋與細縫
  stone: `
    vec2 q = fp / vec2(fLen, fW);
    vec2 cell = floor(q), f = fract(q);
    float slab = fhash(cell) - 0.5;
    float cloud = fnoise(fp * 0.9 + cell * 5.0) * 0.6 + fnoise(fp * 3.1) * 0.4 - 0.5;
    float seam = 1.0 - (1.0 - smoothstep(0.0, 0.012, f.x) * (1.0 - smoothstep(0.988, 1.0, f.x)) * smoothstep(0.0, 0.012, f.y) * (1.0 - smoothstep(0.988, 1.0, f.y))) * 0.3;
    tint = (1.0 + slab * fVar + cloud * fVar * 1.4) * seam;`,
  plain: `tint = 1.0;`,
};

const COMMON = `
varying vec3 vFinWP; varying vec3 vFinWN;
float fhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fhash(i), fhash(i + vec2(1, 0)), f.x), mix(fhash(i + vec2(0, 1)), fhash(i + vec2(1, 1)), f.x), f.y); }`;

function finishMaterial(base, spec) {
  const mat = base.clone();
  mat.name = 'Finish_' + spec.id;
  mat.color.set(spec.color);
  if (spec.roughness != null) mat.roughness = spec.roughness;
  if (spec.metalness != null) mat.metalness = spec.metalness;
  mat.map = null;
  mat.userData.base = { color: mat.color.clone(), emissive: mat.emissive.clone(), ei: mat.emissiveIntensity };
  const pat = PATTERNS[spec.pattern] || PATTERNS.plain;
  const f = (v) => Number(v).toFixed(3);
  const [len, w] = spec.size_m || [1.2, 0.15];
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFinWP; varying vec3 vFinWN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFinWP=(modelMatrix*vec4(transformed,1.0)).xyz; vFinWN=mat3(modelMatrix)*objectNormal;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + COMMON)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 an = abs(normalize(vFinWN));
        // 地板：xz；牆：依法線主軸選投影面，木紋／石縫在牆上沿水平方向延伸
        vec2 fp = an.y > 0.7 ? vFinWP.${spec.along === 'z' ? 'zx' : 'xz'} : (an.x > an.z ? vFinWP.zy : vFinWP.xy);
        ${spec.wallVertical ? 'if (an.y <= 0.7) fp = fp.yx;' : ''}
        float fLen = ${f(len)}, fW = ${f(w)}, fVar = ${f(spec.variation ?? 0.25)}, tint = 1.0;
        ${pat}
        diffuseColor.rgb *= clamp(tint, 0.0, 2.0);
      }`);
  };
  mat.customProgramCacheKey = () => 'finish_' + spec.id;
  return mat;
}

// 回傳套用到的物件數。groups：modes.json 的 groups（規則可用 '@'）
export function applyFinishes(model, cfg, groups) {
  let n = 0;
  for (const spec of cfg?.finishes || []) {
    if (!spec.id || !spec.match) continue;
    const hit = makeMatcher(spec.match, groups), skip = makeMatcher(spec.exclude, groups);
    const mats = new Map();   // 同一個原材質只換一次，共用 shader
    for (const m of model.meshes) {
      const name = m.userData.fname;
      if (m.userData.isGlass || m.userData.finish || !hit(name) || skip(name)) continue;
      let mt = mats.get(m.material);
      if (!mt) { mt = finishMaterial(m.material, spec); mats.set(m.material, mt); }
      m.material = mt; m.userData.origMaterial = mt; m.userData.finish = spec.id;
      n++;
    }
  }
  return n;
}
