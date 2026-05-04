import * as THREE from 'three';

export const DEFAULT_LOGO = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236366f1' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='7' width='20' height='14' rx='2'/%3E%3Cpath d='M16 7V5a2 2 0 0 0-4 0v2'/%3E%3Cpath d='M8 7V5a2 2 0 0 0-4 0v2'/%3E%3Cline x1='12' y1='12' x2='12' y2='16'/%3E%3Cline x1='10' y1='14' x2='14' y2='14'/%3E%3C/svg%3E`;

/* ── TEXTURE LOADING ─────────────────────────────────────── */
const texCache = {};

export function getTexture(path, onLoad) {
  if (texCache[path]) {
    const t = texCache[path];
    if (onLoad && t.image) onLoad(t);
    return t;
  }
  const t = new THREE.TextureLoader().load(path, onLoad);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache[path] = t;
  return t;
}

export const loadTextureAsync = getTexture;

/* ── TEXTURE ALPHA SAMPLING ──────────────────────────────── */
const _pixelCache = new Map();

export function getTextureAlphaAt(texture, uv) {
  const img = texture?.image;
  if (!img?.width) return 255; // not loaded yet → treat as opaque

  const key = img.src || img.currentSrc || img;
  if (!_pixelCache.has(key)) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    _pixelCache.set(key, c.getContext('2d').getImageData(0, 0, img.width, img.height).data);
  }

  const data = _pixelCache.get(key);
  const x = Math.min(Math.floor(uv.x * img.width),  img.width  - 1);
  const y = Math.min(Math.floor((1 - uv.y) * img.height), img.height - 1);
  return data[(y * img.width + x) * 4 + 3]; // alpha channel 0–255
}

/* ── LOGO SCALE ──────────────────────────────────────────── */
export function applyLogoScale(mesh, scale) {
  const aspect = mesh.userData.aspect || 1;
  const factor = 0.15;
  const sv = new THREE.Vector3(scale * aspect * factor, scale * factor, 1);
  mesh.scale.copy(sv);
  mesh.userData.baseScale = sv.clone();
}

/* ── HOVER ANIMATION (called every render frame) ─────────── */
export function applyHoverEffect(mesh, isHovering) {
  // 🔹 posisi (shared untuk semua)
  if (mesh.userData.baseY === undefined) {
    mesh.userData.baseY = mesh.position.y;
  }

  const ty = isHovering
    ? mesh.userData.baseY + 0.008
    : mesh.userData.baseY;

  mesh.position.y += (ty - mesh.position.y) * 0.2;

  // 🔹 BASE → tambah opacity
  if (mesh.userData.type === 'base') {
    if (mesh.material) {
      const targetOpacity = isHovering ? 1.0 : 0.65;
      mesh.material.opacity += (targetOpacity - mesh.material.opacity) * 0.2;
    }
  }

  // 🔹 LOGO → scale
  if (mesh.userData.type === 'logo') {
    const bs = mesh.userData.baseScale || new THREE.Vector3(1, 1, 1);
    const s  = isHovering ? bs.y * 1.05 : bs.y;
    const aspect = mesh.userData.aspect || 1;

    mesh.scale.lerp(
      new THREE.Vector3(s * aspect, s, 1),
      0.15
    );
  }
}

/* ── MESH FACTORY ─────────────────────────────────────────── */
export function createBaseMesh(storeKey, color) {
  const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.155, 0.155), mat);
  mesh.userData.type = 'base';
  mesh.name = storeKey;
  return mesh;
}

/* ── STORE CONFIG ─────────────────────────────────────────── */
let _storeCache = null; // null = belum di-init, [] / [...] = sudah

/** Seed cache dari hasil fetchStores() saat startup */
export function initStoreCache(stores) {
  _storeCache = stores ?? [];
}

export function getStoreConfig() {
  if (_storeCache !== null) return _storeCache;
  try { return JSON.parse(localStorage.getItem('storeConfig') || '[]'); }
  catch { return []; }
}

export function saveStoreConfig(config, changedStore = null) {
  _storeCache = config;
  localStorage.setItem('storeConfig', JSON.stringify(config));
  // Push ke Supabase (fire-and-forget) — single-store upsert when possible
  if (changedStore) {
    import('./db.js').then(({ upsertStore }) => upsertStore(changedStore)).catch(() => {});
  } else {
    import('./db.js').then(({ upsertStores }) => upsertStores(config)).catch(() => {});
  }
}

export function findStore(storeKey, config) {
  return (config || getStoreConfig()).find(s => s.key === storeKey) || null;
}

/* ── DOM FORM HELPERS ─────────────────────────────────────── */
export function getFormValue(id, def = 0) {
  const el = document.getElementById(id);
  return el ? (parseFloat(el.value) || def) : def;
}

export function setFormValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
