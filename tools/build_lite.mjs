// 產生手機／平板（省電模式）用的減面模型：model/nkca.glb → model/nkca_lite.glb
// 用法：node tools/build_lite.mjs [輸入=model/nkca.glb] [輸出=model/nkca_lite.glb]
// 需要 Node.js：npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer
//
// 只針對「面數很多、但看起來很平或很小」的物件減面，形狀與外框保持不變（lockBorder：開口邊界不動）。
// 物件名稱、Fusion 原始名稱（extras.fname）都保留，網頁所有功能照常運作。
// 換新模型時：先用 build_model.sh 產生 model/nkca.glb，再跑這支。
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, simplifyPrimitive, weldPrimitive, quantize, reorder, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IN = process.argv[2] || 'model/nkca.glb', OUT = process.argv[3] || 'model/nkca_lite.glb';

// 規則：依物件名稱（第一個符合的生效）。error＝允許的形狀誤差（相對於物件大小），ratio＝目標面數比例
const RULES = [
  { match: /^Site_Fountain_(LED|Nozzles)/, ratio: 0.08, error: 0.02 },   // 噴泉細部：遠看不出來
  { match: /^(Plaza_Ground|Site_|Plaza_Ceiling)/, ratio: 0, error: 0.0006 },   // 平坦的地坪、天花：大量細分三角形
  { match: /^Railing/, skip: true },                                      // 欄杆：細柱很多，減面會讓柱子消失，不動
  { match: /^Seam/, ratio: 0, error: 0.001 },                             // 屋頂直立縫：細長物件
  { match: /^Roof_/, ratio: 0, error: 0.00025 },                          // 屋頂曲面：小心減，保留弧度
];
const DEFAULT = { ratio: 0, error: 0.0008 };
const MIN_TRIS = 3000;   // 少於這個面數的物件不動

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(IN);
await doc.transform(dequantize());

const tri = (p) => (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
let before = 0, after = 0;
const report = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const name = node.getName();
  for (const prim of mesh.listPrimitives()) {
    const t0 = tri(prim); before += t0;
    if (t0 < MIN_TRIS) { after += t0; continue; }
    const r = RULES.find((x) => x.match.test(name)) || DEFAULT;
    if (r.skip) { after += t0; continue; }
    weldPrimitive(prim);
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: r.ratio, error: r.error, lockBorder: true });
    const t1 = tri(prim); after += t1;
    report.push([name, t0, t1]);
  }
}
await doc.transform(prune({ keepAttributes: true, keepExtras: true }), quantize(), reorder({ encoder: MeshoptEncoder }));
doc.createExtension(ALL_EXTENSIONS.find((E) => E.EXTENSION_NAME === 'EXT_meshopt_compression'))
  .setRequired(true).setEncoderOptions({ method: 'filter' });
await io.write(OUT, doc);

report.sort((a, b) => b[1] - a[1]);
for (const [n, a, b] of report.slice(0, 20)) console.log(`${n.padEnd(28)} ${String(a).padStart(7)} → ${String(b).padStart(7)}`);
console.log(`總面數 ${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()}（${Math.round((after / before) * 100)}%）`);

// 匯出後檢查（北側土丘等必須隱藏的物件）：兩個模型都檢查，沒通過會失敗
execFileSync(process.execPath, [fileURLToPath(new URL('check_model.mjs', import.meta.url)), IN, OUT], { stdio: 'inherit' });
