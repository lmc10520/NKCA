// 匯出後的檢查：每次 Fusion 匯出新模型、跑完 build_model.sh／build_lite.mjs 後執行
// 用法：node tools/check_model.mjs [模型…]（預設 model/nkca.glb model/nkca_lite.glb）
// 需要 Node.js：npm i @gltf-transform/core @gltf-transform/extensions meshoptimizer
//
// 檢查 MUST_HIDE 裡的物件：模型裡有這個物件時，config/modes.json 的 exclude 一定要把它隱藏，否則失敗（exit 1）。
// Fusion 的顯示／隱藏狀態網頁不採用（大部分物件在 Fusion 都是隱藏的），所以只能靠 exclude。
import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const MUST_HIDE = {
  Site_North_Mound_Solid: '北側土丘和 Site_Campus_Paving 重疊，顯示時鋪面上會有殘影',
};

// 和 js/util.js 的 makeMatcher 同一套規則：'=' 完整名稱、'@' 引用 groups、其他為正規表示式
const modes = JSON.parse(readFileSync(new URL('../config/modes.json', import.meta.url), 'utf8'));
const exact = new Set(), res = [];
const add = (p) => {
  if (typeof p !== 'string') return;
  if (p.startsWith('@')) (modes.groups?.[p.slice(1)] || []).forEach(add);
  else if (p.startsWith('=')) exact.add(p.slice(1));
  else res.push(new RegExp(p));
};
(modes.exclude || []).forEach(add);
const excluded = (n) => exact.has(n) || res.some((re) => re.test(n));

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['model/nkca.glb', 'model/nkca_lite.glb'];
let bad = 0;
for (const f of files) {
  const doc = await io.read(f);
  const names = new Set(doc.getRoot().listNodes().map((n) => n.getExtras()?.fname || n.getName()));
  for (const [name, why] of Object.entries(MUST_HIDE)) {
    if (!names.has(name)) console.log(`${f}：沒有 ${name}（不用處理）`);
    else if (excluded(name)) console.log(`${f}：${name} 已隱藏 ✓`);
    else { console.log(`${f}：✗ ${name} 會顯示在網頁上（${why}）→ 加進 config/modes.json 的 exclude`); bad++; }
  }
}
process.exit(bad ? 1 : 0);
