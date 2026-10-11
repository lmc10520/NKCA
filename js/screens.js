import * as THREE from 'three';
import { cm2w } from './util.js';

// LED 電視牆與舞台貼圖：讀 img/ 內指定檔名的圖片貼在四個角點圍成的面上
export function buildScreens(scene, cfg) {
  const group = new THREE.Group(); group.name = 'Screens'; scene.add(group);
  const loader = new THREE.TextureLoader();
  const bust = '?v=' + Math.floor(Date.now() / 60000);   // 每分鐘換一次，GitHub 換圖後重新整理即可看到
  for (const s of cfg?.screens || []) {
    if (!s.enabled) continue;
    const c = s.corners_cm.map(cm2w);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...c[0].toArray(), ...c[1].toArray(), ...c[2].toArray(), ...c[3].toArray()], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'Screen_' + s.id; mesh.userData.fname = mesh.name; mesh.userData.label = s.label;
    group.add(mesh);
    loader.load(s.file + bust, (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.color.set(0xffffff); mat.needsUpdate = true; },
      undefined, () => console.warn('[screen] 找不到圖片', s.file));
  }
  return group;
}
