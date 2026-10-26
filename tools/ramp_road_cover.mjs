// 補上停車場坡道上方的柏油路面（Site_Road_Base_RampCover）
// 用法：node tools/ramp_road_cover.mjs <舊模型.glb> <新模型.glb> [輸出=新模型.glb]
// 需要 Node.js：npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer
//
// 加入 B1／B2 地下停車場後，Fusion 匯出的 Site_Road_Base 在東西兩側坡道正上方挖了洞（B1／B2 模式才看得到坡道），
// 草地、鋪面、標線都有對應的 *_RampCover 上蓋，柏油路面卻沒有，外觀模式就會看到坡道外露、圓環路面缺一塊。
// 這支從舊模型（還沒有地下停車場的版本，例如 git show 5429aff:model/nkca.glb）的 Site_Road_Base
// 取出「新模型路面沒蓋到、下方有坡道」的平面三角形，做成 Site_Road_Base_RampCover 加回新模型；
// config/modes.json 的 aboveGround 群組會在 B1／B2 模式把它收起來。
// 換新模型時：如果 Fusion 已經有 Site_Road_Base_RampCover 就不用跑；否則 nkca.glb、nkca_lite.glb 各跑一次。
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [OLD, NEW, OUT = NEW] = process.argv.slice(2);
const NAME = 'Site_Road_Base_RampCover';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const fname = (n) => n.getExtras()?.fname || n.getName();
const mul = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
// 物件名稱符合 re 的三角形（世界座標）
async function triangles(doc, re) {
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !re.test(fname(node))) continue;
    const M = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'), idx = prim.getIndices(), n = idx ? idx.getCount() : pos.getCount();
      const P = (i) => mul(M, pos.getElement(idx ? idx.getScalar(i) : i, []));
      for (let i = 0; i < n; i += 3) out.push([P(i), P(i + 1), P(i + 2)]);
    }
  }
  return out;
}
// 平面（x, z）上的點是否落在某個三角形內，用格網加速
function index(tris, cell = 2) {
  const g = new Map();
  tris.forEach((t, k) => {
    const xs = t.map((p) => p[0]), zs = t.map((p) => p[2]);
    for (let i = Math.floor(Math.min(...xs) / cell); i <= Math.floor(Math.max(...xs) / cell); i++)
      for (let j = Math.floor(Math.min(...zs) / cell); j <= Math.floor(Math.max(...zs) / cell); j++) {
        const key = i + ',' + j; if (!g.has(key)) g.set(key, []); g.get(key).push(k);
      }
  });
  const inTri = (x, z, [a, b, c]) => {
    const d = (p, q) => (x - q[0]) * (p[2] - q[2]) - (p[0] - q[0]) * (z - q[2]);
    const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  return (x, z) => (g.get(Math.floor(x / cell) + ',' + Math.floor(z / cell)) || []).some((k) => inTri(x, z, tris[k]));
}

const oldDoc = await io.read(OLD); await oldDoc.transform(dequantize());
const newDoc = await io.read(NEW);
if (newDoc.getRoot().listNodes().some((n) => fname(n) === NAME)) { console.log(`${NEW} 已經有 ${NAME}，不用補`); process.exit(0); }
const probe = await io.read(NEW); await probe.transform(dequantize());
const road = index(await triangles(probe, /^Site_Road_Base$/));
const ramp = index(await triangles(probe, /^(Ramp_|Site_Ramp_Walls)/));
const cover = (await triangles(oldDoc, /^Site_Road_Base$/)).filter((t) => {
  const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
  return t.every((p) => p[1] > -0.3) && !road(cx, cz) && ramp(cx, cz);   // 只補地面高度的平面；坡道本身的斜面不補
});
if (!cover.length) { console.log('沒有需要補的路面'); process.exit(0); }

// 新物件：沿用新模型 Site_Road_Base 的材質，放在場景根層（世界座標）
const baseNode = newDoc.getRoot().listNodes().find((n) => fname(n) === 'Site_Road_Base');
const mat = baseNode.getMesh().listPrimitives()[0].getMaterial();
const buf = newDoc.getRoot().listBuffers()[0];
const pos = new Float32Array(cover.flat(2)), nor = new Float32Array(pos.length);
for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
// 三角形一律朝上
for (let i = 0; i < pos.length; i += 9) {
  const ax = pos[i + 3] - pos[i], az = pos[i + 5] - pos[i + 2], bx = pos[i + 6] - pos[i], bz = pos[i + 8] - pos[i + 2];
  if (az * bx - ax * bz < 0) for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
}
const prim = newDoc.createPrimitive().setMaterial(mat)
  .setAttribute('POSITION', newDoc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
  .setAttribute('NORMAL', newDoc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buf));
const node = newDoc.createNode(NAME).setMesh(newDoc.createMesh(NAME).addPrimitive(prim)).setExtras({ fname: NAME });
newDoc.getRoot().listScenes()[0].addChild(node);
await io.write(OUT, newDoc);
const area = cover.reduce((s, [a, b, c]) => s + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2, 0);
console.log(`${OUT}：補上 ${NAME}，${cover.length} 個三角形、${area.toFixed(0)} m²`);
