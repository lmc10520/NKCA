import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const drop = new Set(['Body62']);
for (const n of doc.getRoot().listNodes()) if (drop.has(n.getName())) n.dispose();
await doc.transform(prune());
await io.write(process.argv[3], doc);
console.log('ok', doc.getRoot().listNodes().length);
