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
// ---------- 資料夾內的音檔清單（鋼琴、聲景共用） ----------
// 依序嘗試：1) GitHub Pages：向 GitHub 查整個儲存庫的檔案樹（只查一次，所有資料夾共用，空資料夾也不會產生 404）；
// 2) 資料夾裡的 list.json（["a.mp3", ...]，可指定順序；別處架站時用）；3) 本機 python -m http.server 的目錄列表。
// 都沒有就回傳 []，不丟錯誤。底線 _ 開頭的檔案視為草稿，不列入。
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|wav)$/i;
let repoTree;   // Promise<string[] | null>
function ghTree() {
  if (repoTree !== undefined) return repoTree;
  const m = location.hostname.match(/^([^.]+)\.github\.io$/), repo = location.pathname.split('/')[1];
  if (!m || !repo) return (repoTree = Promise.resolve(null));
  return (repoTree = fetch(`https://api.github.com/repos/${m[1]}/${repo}/git/trees/HEAD?recursive=1`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && Array.isArray(j.tree) && !j.truncated ? j.tree.filter((t) => t.type === 'blob').map((t) => t.path) : null))
    .catch(() => null));
}
const keep = (name) => AUDIO_RE.test(name) && !name.startsWith('_');
export async function listFolder(folder) {
  folder = String(folder || '').replace(/^\.?\/+|\/+$/g, '');
  const url = (f) => `${folder}/${encodeURIComponent(f)}`;
  const tree = await ghTree();
  if (tree) {
    const pre = folder + '/', out = [];
    let hasList = false;
    for (const p of tree) {
      if (!p.startsWith(pre)) continue;
      const rest = p.slice(pre.length);
      if (rest.includes('/')) continue;
      if (rest === 'list.json') hasList = true;
      else if (keep(rest)) out.push(url(rest));
    }
    if (!hasList) return out;   // 有 list.json 時以它的順序為準
  }
  try {
    const r = await fetch(`${folder}/list.json`, { cache: 'no-cache' });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j.filter((f) => typeof f === 'string' && keep(f)).map(url); }
  } catch {}
  if (tree) return [];
  try {
    const r = await fetch(`${folder}/`, { cache: 'no-cache' });
    if (r.ok && /text\/html/.test(r.headers.get('content-type') || '')) {
      const html = await r.text(), out = new Set();
      for (const m of html.matchAll(/href="([^"?#/]+)"/g)) { const f = decodeURIComponent(m[1]); if (keep(f)) out.add(url(f)); }
      return [...out];
    }
  } catch {}
  return [];
}

export const isMobile = matchMedia('(pointer:coarse)').matches || /Mobi|Android|iPad|iPhone/.test(navigator.userAgent);
