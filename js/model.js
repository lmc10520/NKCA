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
    let m = o.material;
    const matGlass = /glass|玻璃/i.test(m.name || '');
    const isGlass = matGlass || /Glass/.test(fname);
    o.userData.isGlass = isGlass;
    // 只因物件名稱判定為玻璃時，材質可能和牆、地面共用，必須先複製再改成透明，
    // 否則整片地面、天花會一起變透明（就是之前縮放時模型「破掉」的原因）
    if (isGlass && !matGlass) { m = m.clone(); o.material = m; }
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
  // 屋頂直立縫（Seam_*）是很細的立鰭，暗面在遠處會鋸齒化成一排排黑點（屋頂看起來「破掉」）。
  // 把法線全部改成朝上，讓它和屋面同樣受光，只呈現細緻的線條；並且不投/不收陰影。
  root.updateMatrixWorld(true);
  const up = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const o of meshes) {
    if (!/^Seam/.test(o.userData.fname)) continue;
    const g = o.geometry.clone();
    nm.getNormalMatrix(o.matrixWorld).invert();
    up.set(0, 1, 0).applyMatrix3(nm).normalize();
    const n = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < n.length; i += 3) { n[i] = up.x; n[i + 1] = up.y; n[i + 2] = up.z; }
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    o.geometry = g;
    o.castShadow = false; o.receiveShadow = false;
  }
  // 道路標線：Fusion 裡只比路面高 6 mm，壓縮（量化）後會掉到路面下面看不到；網頁往上抬 5 cm
  for (const o of meshes) {
    if (!/^Site_Marking/.test(o.userData.fname)) continue;
    const w = o.getWorldPosition(new THREE.Vector3()); w.y += 0.05;
    o.position.copy(o.parent.worldToLocal(w));
    o.receiveShadow = true; o.castShadow = false;
  }
  return { root, meshes, byName };
}

// 依名稱規則找 mesh
export function findMeshes(model, matcher) {
  return model.meshes.filter((m) => matcher(m.userData.fname));
}
