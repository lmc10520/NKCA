import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// 載入 model/ 內的 GLB。換模型時只要覆蓋同名檔案（或改 config/site.json 的 model 路徑）。
export async function loadModel(url, onProgress) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const root = gltf.scene;
  const meshes = [];
  const byName = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    // GLTFLoader 會把名稱中的空白換成底線；原始 Fusion 名稱保留在 userData.fname
    const fname = o.userData?.fname || o.parent?.userData?.fname || o.name;
    o.userData.fname = fname;
    const m = o.material;
    const isGlass = /glass|玻璃/i.test(m.name || '') || /Glass/.test(fname);
    o.userData.isGlass = isGlass;
    if (isGlass) {
      m.transparent = true;
      m.opacity = Math.min(m.opacity ?? 1, 0.35);
      m.depthWrite = false;
      m.roughness = 0.08;
      m.metalness = 0.1;
      m.color.lerp(new THREE.Color('#9fc4d6'), 0.4);
      o.renderOrder = 2;
    } else {
      m.side = THREE.DoubleSide;
    }
    m.userData.base = { color: m.color.clone(), emissive: m.emissive.clone(), ei: m.emissiveIntensity };
    o.userData.origMaterial = m;
    o.castShadow = !isGlass;
    o.receiveShadow = true;
    meshes.push(o);
    if (!byName.has(fname)) byName.set(fname, []);
    byName.get(fname).push(o);
  });
  return { root, meshes, byName };
}

// 依名稱規則找 mesh
export function findMeshes(model, matcher) {
  return model.meshes.filter((m) => matcher(m.userData.fname));
}
