// 只更新模型裡的幾個物件：把另一個 glb（Fusion 只匯出這幾個 body，或另一份完整匯出）裡同名物件的形狀換進 model/nkca.glb、nkca_lite.glb
// 用法：node tools/replace_bodies.mjs <目標.glb> <來源.glb> <輸出.glb> 物件名稱…
// 例：node tools/replace_bodies.mjs model/nkca.glb nkca_ramps_fix.glb model/nkca.glb Ramp_E_B2_Up Ramp_W_B2_Up
// 用在使用者電腦沒有 Node／git、不方便重跑 build_model.sh 時；材質、名稱（extras.fname）沿用目標檔，形狀依世界座標換過去。
// 換完記得更新 config/site.json 的 modelBytes／modelLiteBytes。
// 需要 Node.js：npm i @gltf-transform/core @gltf-transform/extensions meshoptimizer
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder});
const [T, R, OUT, ...NAMES] = process.argv.slice(2);
const doc = await io.read(T), src = await io.read(R);
const xf = (M, v) => [M[0]*v[0]+M[4]*v[1]+M[8]*v[2]+M[12], M[1]*v[0]+M[5]*v[1]+M[9]*v[2]+M[13], M[2]*v[0]+M[6]*v[1]+M[10]*v[2]+M[14]];
const xn = (M, v) => { const r=[M[0]*v[0]+M[4]*v[1]+M[8]*v[2], M[1]*v[0]+M[5]*v[1]+M[9]*v[2], M[2]*v[0]+M[6]*v[1]+M[10]*v[2]]; const l=Math.hypot(...r)||1; return r.map(x=>x/l); };
for (const name of NAMES) {
  const sn = src.getRoot().listNodes().find(n => n.getName() === name);
  const tn = doc.getRoot().listNodes().find(n => n.getName() === name);
  if (!sn || !tn) throw new Error('missing ' + name);
  if (tn.getParentNode()) throw new Error('target has parent ' + name);
  const M = sn.getWorldMatrix();
  // 收集世界座標三角形，依位置＋法線焊接
  const P = [], N = [], I = [], key = new Map();
  for (const p of sn.getMesh().listPrimitives()) {
    const pa = p.getAttribute('POSITION'), na = p.getAttribute('NORMAL'), ix = p.getIndices();
    const cnt = ix ? ix.getCount() : pa.getCount(); const a = [0,0,0], b = [0,0,0];
    for (let k = 0; k < cnt; k++) {
      const i = ix ? ix.getScalar(k) : k; pa.getElement(i, a); const w = xf(M, a);
      let nn = [0,1,0]; if (na) { na.getElement(i, b); nn = xn(M, b); }
      const kk = w.map(x => x.toFixed(4)).join() + '|' + nn.map(x => x.toFixed(2)).join();
      let id = key.get(kk); if (id === undefined) { id = P.length / 3; key.set(kk, id); P.push(...w); N.push(...nn); }
      I.push(id);
    }
  }
  const nv = P.length / 3, mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], P[i*3+c]); mx[c] = Math.max(mx[c], P[i*3+c]); }
  const t = mn.map((v, c) => (v + mx[c]) / 2), s = Math.max(...mx.map((v, c) => (v - mn[c]) / 2));
  // KHR_mesh_quantization：int16 normalized 位置（4 分量對齊）、int8 法線，與原檔相同格式
  const qp = new Int16Array(nv * 4), qn = new Int8Array(nv * 4);
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) {
    qp[i*4+c] = Math.round((P[i*3+c] - t[c]) / s * 32767); qn[i*4+c] = Math.round(N[i*3+c] * 127);
  }
  const buf = doc.getRoot().listBuffers()[0];
  const prim0 = tn.getMesh().listPrimitives()[0];
  const oldP = prim0.getAttribute('POSITION'), oldN = prim0.getAttribute('NORMAL'), oldI = prim0.getIndices();
  // 原檔 accessor 是 VEC3 + byteStride 8；gltf-transform 會自行處理 stride，這裡給 VEC3 陣列
  const p3 = new Int16Array(nv * 3), n3 = new Int8Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { p3[i*3+c] = qp[i*4+c]; n3[i*3+c] = qn[i*4+c]; }
  const pos = doc.createAccessor().setType('VEC3').setArray(p3).setNormalized(true).setBuffer(buf);
  const nor = doc.createAccessor().setType('VEC3').setArray(n3).setNormalized(true).setBuffer(buf);
  const idx = doc.createAccessor().setType('SCALAR').setArray(nv > 65535 ? new Uint32Array(I) : new Uint16Array(I)).setBuffer(buf);
  prim0.setAttribute('POSITION', pos).setAttribute('NORMAL', nor).setIndices(idx);
  for (const a of [oldP, oldN, oldI]) if (a && a.listParents().length <= 1) a.dispose();
  tn.setTranslation(t).setScale([s, s, s]).setRotation([0,0,0,1]);
  console.log(name, 'verts', nv, 'tris', I.length / 3, 'min', mn.map(v=>v.toFixed(3)), 'max', mx.map(v=>v.toFixed(3)));
}
await io.write(OUT, doc);
console.log('wrote', OUT);
