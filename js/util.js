import * as THREE from 'three';

// Fusion 模型座標（cm，Z 朝上）↔ 網頁座標（m，Y 朝上）
// x_web = X/100, y_web = Z/100, z_web = -Y/100
export const cm2w = (p) => new THREE.Vector3(p[0] / 100, (p[2] || 0) / 100, -p[1] / 100);
export const w2cm = (v) => [Math.round(v.x * 100), Math.round(-v.z * 100), Math.round(v.y * 100)];

export async function loadJSON(url, fallback) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn('[config] 讀不到', url, e.message);
    return fallback;
  }
}

// 名稱比對：pattern 為正規表示式字串陣列；以 "@群組" 引用 groups 內的清單
export function makeMatcher(patterns, groups = {}) {
  const list = [], exact = new Set();
  const add = (p) => {
    if (typeof p !== 'string') return;
    if (p.startsWith('@')) (groups[p.slice(1)] || []).forEach(add);
    else if (p.startsWith('=')) exact.add(p.slice(1));
    else list.push(new RegExp(p));
  };
  (patterns || []).forEach(add);
  return (name) => exact.has(name) || list.some((re) => re.test(name));
}

export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const isMobile = matchMedia('(pointer:coarse)').matches || /Mobi|Android|iPad|iPhone/.test(navigator.userAgent);
