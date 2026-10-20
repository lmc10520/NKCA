import * as THREE from 'three';

// ---------- 地平線 ----------
// 基地（Site_* 物件的範圍）外面鋪一片大地坪，從基地邊緣的淺色漸漸變成地平線的霧色，
// 再加一圈跟著鏡頭的「地平線霧帶」（圓筒內側，下緣不透明、往上漸淡），把地面和天空分開，
// 鳥瞰時就看不到四方形的基地邊緣。夜晚地坪在遠處漸漸變透明、霧帶淡出，四周就是延伸到地平線以下的星空。
// 白模／線稿／網點樣式隱藏（背景本來就是白色）。
// 顏色在 site.json 的 horizon：dayNear／dayFar（白天近處／遠處）、nightNear／nightFar（夜晚）。
const VS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vW; varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;

export class Horizon {
  constructor(scene, rect, cfg = {}) {
    this.cfg = cfg;
    this.col = {
      dayNear: new THREE.Color(cfg.dayNear || '#eeeeeb'), dayFar: new THREE.Color(cfg.dayFar || '#d9e2e8'),
      nightNear: new THREE.Color(cfg.nightNear || '#5a647b'), nightFar: new THREE.Color(cfg.nightFar || '#2c3854'),
    };
    const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
    const R = cfg.radius_m ?? 6000;
    this.u = {
      uNear: { value: new THREE.Color() }, uFar: { value: new THREE.Color() },
      uC: { value: new THREE.Vector2(cx, cz) }, uR0: { value: cfg.fadeStart_m ?? 250 }, uR1: { value: cfg.fadeEnd_m ?? 2600 },
      uN: { value: 0 }, uA0: { value: cfg.nightFadeStart_m ?? 420 }, uA1: { value: cfg.nightFadeEnd_m ?? 1100 },
    };
    // 地坪：中間挖掉基地範圍（往內縮 0.3 m，邊緣塞在基地底下），高度略低於基地最低的地面
    const s = new THREE.Shape(); s.absarc(cx, -cz, R, 0, Math.PI * 2, false);
    const h = new THREE.Path(), i = 0.3;
    h.moveTo(rect.x0 + i, -(rect.z0 + i)); h.lineTo(rect.x1 - i, -(rect.z0 + i)); h.lineTo(rect.x1 - i, -(rect.z1 - i)); h.lineTo(rect.x0 + i, -(rect.z1 - i)); h.closePath();
    s.holes.push(h);
    const g = new THREE.ShapeGeometry(s, 96); g.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VS, fog: false, transparent: true,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uNear, uFar; uniform vec2 uC; uniform float uR0, uR1, uN, uA0, uA1; varying vec3 vW;
        void main() {
          #include <logdepthbuf_fragment>
          float d = distance(vW.xz, uC);
          float t = smoothstep(uR0, uR1, d);
          float a = mix(1.0, 1.0 - smoothstep(uA0, uA1, d), uN);
          if (a < 0.01) discard;
          gl_FragColor = vec4(mix(uNear, uFar, t), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.ground.position.y = cfg.y_m ?? -0.2;
    this.ground.name = 'HorizonGround'; this.ground.raycast = () => {};
    this.ground.renderOrder = -0.5;   // 透明物件中最先畫（在夜空之後、玻璃之前）
    // 地平線霧帶：半徑 5 km 的圓筒內側，跟著鏡頭水平移動
    const H = 600, below = 60;
    this.skirtR = 5000;
    const sg = new THREE.CylinderGeometry(this.skirtR, this.skirtR, H, 96, 1, true);
    sg.translate(0, H / 2 - below, 0);
    this.skirt = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      uniforms: { uFar: this.u.uFar, uG: { value: below / H }, uN: this.u.uN }, vertexShader: VS,
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uFar; uniform float uG, uN; varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float a = 1.0 - smoothstep(uG, 0.85, vUv.y);
          a *= a * (1.0 - uN);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uFar, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.skirt.name = 'HorizonSkirt'; this.skirt.raycast = () => {}; this.skirt.frustumCulled = false;
    scene.add(this.ground, this.skirt);
  }

  // night：0 白天 → 1 夜晚；plain：白模／線稿／網點（隱藏）
  update(camPos, night, plain) {
    const on = !plain;
    this.ground.visible = this.skirt.visible = on;
    if (!on) return;
    const c = this.col;
    this.u.uNear.value.lerpColors(c.dayNear, c.nightNear, night);
    this.u.uFar.value.lerpColors(c.dayFar, c.nightFar, night);
    this.u.uN.value = THREE.MathUtils.smoothstep(night, 0.15, 0.85);
    this.skirt.position.set(camPos.x, 0, camPos.z);
  }
}

// 從模型的 Site_* 物件算出基地範圍（網頁座標 m）
export function siteRect(model, re = /^Site_(Road_Base|City_Blocks|Sidewalk|Grass|Campus_Paving)/) {
  const box = new THREE.Box3(), b = new THREE.Box3();
  for (const m of model.meshes) if (re.test(m.userData.fname)) box.union(b.setFromObject(m));
  if (box.isEmpty()) return null;
  return { x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z };
}
