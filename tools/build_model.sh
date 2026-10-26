#!/usr/bin/env bash
# 把 Fusion 匯出的原始 nkca.glb 壓縮成網頁用的 model/nkca.glb
# 需要 Node.js：npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions @gltf-transform/cli meshoptimizer
set -e
IN=${1:-nkca_raw.glb}
node tools/prune.mjs "$IN" /tmp/a.glb            # 移除 Body62 等不上網頁的物件
npx gltf-transform weld /tmp/a.glb /tmp/b.glb
npx gltf-transform simplify /tmp/b.glb /tmp/c.glb --ratio 0 --error 0.00006 --lock-border true
npx gltf-transform quantize /tmp/c.glb /tmp/d.glb
npx gltf-transform meshopt /tmp/d.glb /tmp/e.glb
node tools/names.mjs /tmp/e.glb model/nkca.glb  # 保留 Fusion 原始物件名稱
ls -la model/nkca.glb
node tools/check_model.mjs model/nkca.glb       # 必須隱藏的物件（北側土丘等）有沒有被 exclude
