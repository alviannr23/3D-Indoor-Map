import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as THREE     from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { StoreManager } from './storeManager.js';
import * as Utils       from './utils.js';
import * as Popup       from './popup.js';
import { NavigationGraph } from './NavigationGraph.js';
import { NavEditor }        from './navEditor.js';
import { findPath, findPathMultiFloor } from './AStar.js';
import { PathRenderer }     from './PathRenderer.js';
import {
  fetchStores, fetchMapConfig, saveMapConfig,
  fetchNavGraph, saveNavGraph, isConfigured,
  signIn, signOut, getUser, onAuthChange,
} from './db.js';

/* ── KONSTANTA ────────────────────────────────────────────── */
const MODEL_ALTITUDE = 0;
const STYLE_LIGHT    = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const STYLE_DARK     = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/* ── STATE ───────────────────────────────────────────────── */
const _FLOOR_DEFAULTS = { offsetX: 0, offsetY: 0, rotationY: 0, scale: 38, altitudeM: 0 };

const DEFAULTS = {
  lon:      112.7344,
  lat:     -7.309221,
  floors: [
    { ..._FLOOR_DEFAULTS, path: 'mall.glb',  label: 'Lantai 1', altitudeM: 0 },
    { ..._FLOOR_DEFAULTS, path: 'mall2.glb', label: 'Lantai 2', altitudeM: 5 },
  ],
  darkMode: true,
  light: { floorColor: '#d4d4d8', defaultColor: '#e4e4e7', storeColor: '#1500ff' },
  dark:  { floorColor: '#3a3a4a', defaultColor: '#4a4a5a', storeColor: '#1500ff' },
  categoryFilters: [],
};

let _isAdmin = false; // true when admin is logged in

let S = (() => {
  try {
    const raw = localStorage.getItem('imap_cfg');
    if (!raw) return { ...DEFAULTS, light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } };
    const saved = JSON.parse(raw);
    // Migrate: old format had global offsetX/Y/rotationY/scale at root level
    const g = { offsetX: saved.offsetX || 0, offsetY: saved.offsetY || 0, rotationY: saved.rotationY || 0, scale: saved.scale || 38 };
    const floors = saved.floors
      ? saved.floors.map((f, i) => ({
          ..._FLOOR_DEFAULTS,
          ...(DEFAULTS.floors[i] || { path: `mall${i+1}.glb`, label: `Lantai ${i+1}` }),
          // apply old global as base if floor has no per-floor scale yet
          ...( f.scale === undefined ? { ...g, ...(i > 0 ? { offsetX: 0, offsetY: 0, rotationY: 0 } : {}) } : {} ),
          ...f,
        }))
      : DEFAULTS.floors.map((f, i) => ({ ...f, ...g, ...(i > 0 ? { offsetX: 0, offsetY: 0, rotationY: 0 } : {}) }));
    return {
      ...DEFAULTS, ...saved,
      floors,
      light: { ...DEFAULTS.light, ...(saved.light || {}) },
      dark:  { ...DEFAULTS.dark,  ...(saved.dark  || {}) },
    };
  } catch { return { ...DEFAULTS, light: { ...DEFAULTS.light }, dark: { ...DEFAULTS.dark } }; }
})();

/* ── SUPABASE STARTUP SYNC (background — tidak blokir map) ── */
async function _dbSync() {
  try {
    const [dbConfig, dbStores] = await Promise.all([
      fetchMapConfig().catch(() => null),
      fetchStores().catch(() => null),
    ]);

    if (dbConfig) {
      S = {
        ...DEFAULTS,
        ...dbConfig,
        light: { ...DEFAULTS.light, ...(dbConfig.light || {}) },
        dark:  { ...DEFAULTS.dark,  ...(dbConfig.dark  || {}) },
      };
      localStorage.setItem('imap_cfg', JSON.stringify(S));
    } else {
      saveMapConfig(S).catch(() => {});
    }

    if (dbStores && dbStores.length > 0) {
      Utils.initStoreCache(dbStores);
    } else {
      const localStores = JSON.parse(localStorage.getItem('storeConfig') || '[]');
      Utils.initStoreCache(localStores);
      if (localStores.length > 0) {
        import('./db.js').then(({ upsertStores }) => upsertStores(localStores)).catch(() => {});
      }
    }

    const currentUser = await getUser().catch(() => null);
    _applyAdminState(!!currentUser);
    onAuthChange(user => _applyAdminState(!!user));
  } catch (e) {
    console.warn('[DB] Startup sync gagal, pakai localStorage:', e);
    _applyAdminState(true);
  }
}

const _dbSyncPromise = isConfigured() ? _dbSync() : Promise.resolve();
if (!isConfigured()) _applyAdminState(true);

/* current-mode color shorthand */
function C() { return S[S.darkMode ? 'dark' : 'light']; }

const persist = () => {
  localStorage.setItem('imap_cfg', JSON.stringify(S));
  saveMapConfig(S); // async, fire-and-forget
};

/* ── TRANSFORM ────────────────────────────────────────────── */
let xf     = {};
let rotMat = new THREE.Matrix4();

function computeFloorL(f) {
  const { lon, lat } = S;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const origin = [lon + f.offsetX / mPerDegLon, lat + f.offsetY / mPerDegLat];
  const merc   = maplibregl.MercatorCoordinate.fromLngLat(origin, f.altitudeM || 0);
  const s      = merc.meterInMercatorCoordinateUnits() * f.scale;
  const ry     = f.rotationY * Math.PI / 180;
  const rot    = new THREE.Matrix4()
    .makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), ry));
  return new THREE.Matrix4().makeTranslation(merc.x, merc.y, merc.z).scale(new THREE.Vector3(s, -s, s)).multiply(rot);
}

function recompute() {
  // Keep xf/rotMat for floor 0 — used by nav animation (_buildLMatrix)
  const f = S.floors[0];
  const { lon, lat } = S;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const origin = [lon + f.offsetX / mPerDegLon, lat + f.offsetY / mPerDegLat];
  const merc   = maplibregl.MercatorCoordinate.fromLngLat(origin, MODEL_ALTITUDE);
  xf = { tx: merc.x, ty: merc.y, tz: merc.z, s: merc.meterInMercatorCoordinateUnits() * f.scale };
  const ry = f.rotationY * Math.PI / 180;
  rotMat = new THREE.Matrix4()
    .makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), ry));
}
recompute();

/* ── THREE.JS STATE ──────────────────────────────────────── */
let lastMVP    = null;          // last MVP matrix — used for raycasting
const raycaster = new THREE.Raycaster();
let storeManager  = null;
let floorMeshes   = [];
const floorGroups = [];         // Three.Group per lantai, index matches S.floors
const logoGroups  = [];         // Three.Group for logos+bases per floor (identity matrix)
let hoveredKey    = null;       // currently hovered store key
let highlightKey  = null;       // store being blinked after search
let highlightStart = 0;
const HIGHLIGHT_MS = 2800;

/* ── CATEGORY FILTER STATE ───────────────────────────────── */
let _catFilterLabel   = null;   // active category label
let _catHighlightKeys = null;   // Set of matching store keys
let _catHighlightStart = 0;
let _catFilterTimeout = null;

/* ── NAVIGATION STATE ────────────────────────────────────── */
let navGraph       = null;   // points to navGraphs[_viewFloorIdx]
let navEditor      = null;   // points to navEditors[_viewFloorIdx]
const navGraphs    = [];     // one NavigationGraph per floor
const navEditors   = [];     // one NavEditor per floor
let pathRenderer   = null;
let _navDest       = null;
let _navStart      = null;   // start store key for current active navigation
let _navPath       = null;   // full multi-floor path (array of full IDs) for active navigation
let _nodePropsId   = null;   // node ID shown in the props panel
let _linkState     = null;   // { srcFloor, srcNodeId, destFloor? } — during link-pick flow
let _navRouteType  = 'main'; // 'main' | 'fastest'
let _navAutoTimer  = null;
let _navAnimating  = false;
let _lastRenderT   = 0;
let _boxSel        = null;   // { x0,y0,x1,y1 } client coords during box-select drag
let _boxWasDrag    = false;  // true if mousedown+shift moved enough to count as drag

/* ── MAP ─────────────────────────────────────────────────── */
function mapBounds(lon, lat, padKm = 1) {
  const dLat = padKm / 111.32;
  const dLon = padKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]];
}

const map = new maplibregl.Map({
  container: 'map',
  style:     S.darkMode ? STYLE_DARK : STYLE_LIGHT,
  center:    [S.lon, S.lat],
  zoom:      17,
  minZoom:   17,
  maxBounds: mapBounds(S.lon, S.lat),
  pitch:     52,
  bearing:  -25,
  antialias: true,
  attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'bottom-right');
setLoadingText('Memuat peta...');

// Timeout: jika peta tidak muat dalam 20 detik, tampilkan opsi reload
const _mapLoadTimeout = setTimeout(() => {
  setLoadingText('Koneksi lambat. <a href="" style="color:#a5b4fc">Coba lagi</a>');
}, 20000);

map.on('error', (e) => {
  console.warn('[Map error]', e.error);
  setLoadingText('Gagal memuat peta. <a href="" style="color:#a5b4fc">Coba lagi</a>');
});

/* ══════════════════════════════════════════════════════════
   CUSTOM THREE.JS LAYER
   ══════════════════════════════════════════════════════════ */
const modelLayer = {
  id:            '3d-model',
  type:          'custom',
  renderingMode: '3d',

  onAdd(map, gl) {
    this.map = map;

    if (!this.camera) {
      this.camera = new THREE.Camera();
      this.scene  = new THREE.Scene();

      this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      const hemi = new THREE.HemisphereLight(0xddeeff, 0x3a3a3a, 0.8);
      this.scene.add(hemi);
      const sun = new THREE.DirectionalLight(0xfff5e0, 1.5);
      sun.position.set(100, 200, 100);
      this.scene.add(sun);

      storeManager = new StoreManager(this.scene, C().storeColor);
      Popup.init(storeManager);
      loadFloors(this.scene);

      for (let fi = 0; fi < S.floors.length; fi++) {
        const key = fi === 0 ? 'imap_navgraph' : `imap_navgraph_${fi}`;
        navGraphs[fi] = new NavigationGraph(key);
        navEditors[fi] = new NavEditor(this.scene, navGraphs[fi]);
        if (isConfigured()) navGraphs[fi].loadFromDB().catch(() => {});
      }
      navGraph  = navGraphs[0];
      navEditor = navEditors[0];
      pathRenderer = new PathRenderer(this.scene);
      window.startNavigation     = startNavigation;
      window.selectNavStart      = selectNavStart;
      window.clearNavigation     = clearNavigation;
      window.navEdSetTool        = (t) => navEditor?.setTool(t);
      window.navEdSetWidth       = (w) => navEditor?.setEdgeWidth(w);
      window.setNavRouteType     = (t) => {
        _navRouteType = t;
        _syncRouteTypeBtns();
        if (_navStart && _navDest) _runPath(_navStart, _navDest);
      };
      window.navEdDeleteSelected = () => navEditor?.deleteSelected();
      window.navEdClearAll       = () => { navEditor?.clearAll(); };
      window.navEdUndo           = () => navEditor?.undo();
      window.navEdRedo           = () => navEditor?.redo();
      window.toggleNavEditor     = (on) => {
        navEditor?.setActive(on);
        on ? map.boxZoom.disable() : map.boxZoom.enable();
        document.getElementById('panel-btn-nav')?.classList.toggle('active', on);
      };
    }

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
    }
  },

  render(gl, matrix) {
    // Lerp hover animations every frame
    if (storeManager) {
      storeManager.logos.forEach(obj => Utils.applyHoverEffect(obj, obj.name === hoveredKey));
    }

    // Blink highlighted store bases after search selection
    if (highlightKey && storeManager) {
      const elapsed = performance.now() - highlightStart;
      const data    = storeManager.getStoreData(highlightKey);
      if (elapsed >= HIGHLIGHT_MS) {
        data?.bases?.forEach(m => { m.material.opacity = 0.65; });
        highlightKey = null;
      } else {
        const blink = 0.5 + 0.5 * Math.sin(elapsed * 0.012);
        data?.bases?.forEach(m => { m.material.opacity = blink; });
      }
    }

    // Blink category filter stores (current floor only)
    if (_catHighlightKeys?.size && storeManager) {
      const elapsed = performance.now() - _catHighlightStart;
      const blink   = 0.55 + 0.45 * Math.sin(elapsed * 0.009);
      _catHighlightKeys.forEach(key => {
        const fi = parseInt(key.match(/^f(\d+)_/)?.[1] ?? '1') - 1;
        if (fi !== _viewFloorIdx) return;
        storeManager.getStoreData(key)?.bases?.forEach(m => { m.material.opacity = blink; });
      });
    }

    const _now = performance.now();
    const _dt  = Math.min((_now - _lastRenderT) / 1000, 0.1);
    _lastRenderT = _now;
    pathRenderer?.update(_dt);

    const m  = new THREE.Matrix4().fromArray(matrix);
    const l0 = computeFloorL(S.floors[0]);

    this.camera.projectionMatrix = m.clone().multiply(l0);
    lastMVP = this.camera.projectionMatrix.clone();

    // Apply relative transform to each additional floor group
    if (S.floors.length > 1) {
      const l0inv = l0.clone().invert();
      for (let fi = 1; fi < S.floors.length; fi++) {
        const fg = floorGroups[fi];
        if (!fg) continue;
        fg.matrixAutoUpdate = false;
        fg.matrix.multiplyMatrices(l0inv, computeFloorL(S.floors[fi]));
        fg.matrixWorldNeedsUpdate = true;
      }
    }

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  },
};

/* ── FLOOR LOADING ───────────────────────────────────────── */
let _gltfLoader = null;
function _getLoader() {
  if (_gltfLoader) return _gltfLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  _gltfLoader = new GLTFLoader();
  _gltfLoader.setDRACOLoader(draco);
  return _gltfLoader;
}

function loadFloors(scene) {
  S.floors.forEach((_, i) => _loadSingleFloor(scene, i));
}

function _loadSingleFloor(scene, i) {
  const f = S.floors[i];
  const group = new THREE.Group();
  group.name = `floor_${i}`;
  group.matrixAutoUpdate = false;
  // Floor 0: identity (camera matrix handles l0). Others: relative to floor 0.
  if (i === 0) {
    group.matrix.identity();
  } else {
    const l0 = computeFloorL(S.floors[0]);
    group.matrix.multiplyMatrices(l0.clone().invert(), computeFloorL(f));
  }
  scene.add(group);
  floorGroups[i] = group;
  group.visible = (i === _viewFloorIdx);

  const logoGroup = new THREE.Group();
  logoGroup.name = `floor_logos_${i}`;
  scene.add(logoGroup);
  logoGroups[i] = logoGroup;
  logoGroup.visible = (i === _viewFloorIdx);

  if (i === 0) _setModelBar('Memuat model 3D...');
  _getLoader().load(
    f.path,
    (gltf) => {
      group.add(gltf.scene);
      group.updateMatrixWorld(true);
      setupMaterials(gltf.scene);
      setupStores(gltf.scene, i);
      if (i === 0) _hideModelBar();
      _buildFloorSwitcher();
      map.triggerRepaint();
    },
    (p) => {
      if (i === 0 && p.total > 0) _setModelBar(`Memuat model... ${((p.loaded / p.total) * 100) | 0}%`);
    },
    (err) => {
      console.warn(`[GLB floor${i}: ${f.path}]`, err);
      if (i === 0) { _setModelBar('⚠ Gagal memuat model'); setTimeout(_hideModelBar, 4000); }
    }
  );
}

/* ── MATERIAL SETUP ──────────────────────────────────────── */
function setupMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const mat = child.material;
    if (!mat) return;

    const { isFloor, isStore, isEscalator } = getObjectType(child, root.parent);

    // Tag type first so applyMapColors can always find this mesh
    if (isFloor)      child.userData.type = 'floor';
    else if (isStore) child.userData.type = 'store';
    else              child.userData.type = 'other';

    // Track floor meshes for targeted color updates
    if (isFloor) floorMeshes.push(child);

    // Keep GLB textures on floor/store meshes; clear textures on other/escalator
    if (mat.map && !isEscalator && child.userData.type !== 'other') return;

    if (isFloor) {
      mat.color.set(C().floorColor);
    } else if (isStore) {
      mat.color.set(C().storeColor);
    } else {
      mat.color.set(C().defaultColor);
      if (mat.map) mat.map = null;
    }
    mat.roughness    = 1;
    mat.metalness    = 0;
    mat.needsUpdate  = true;
  });
}

/* ── STORE DETECTION & LOGO CREATION ─────────────────────── */
function setupStores(root, floorIdx = 0) {
  const lg = logoGroups[floorIdx] || null;
  // Group meshes by store key
  const groups = new Map();
  root.traverse((child) => {
    if (!child.isMesh) return;
    const key = getStoreKey(child);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(child);
  });

  groups.forEach((meshes, rawKey) => {
    const storeKey = `f${floorIdx + 1}_${rawKey}`;
    const store = storeManager.getOrCreateStore(storeKey);

    // Bounding box of all meshes in this store group
    const box = new THREE.Box3();
    meshes.forEach(m => box.expandByObject(m));
    const center = box.getCenter(new THREE.Vector3());
    const topY   = box.max.y;

    const logo = storeManager.createLogoPlaneMesh(store, center, topY);
    (lg || modelLayer.scene).add(logo);
    storeManager.logos.push(logo);

    const bases = storeManager.createBaseMeshes(store, storeKey, center, topY, lg);
    storeManager.registerStoreData(storeKey, logo, bases);
  });
}

/* Walk up parent chain to detect floor / store / escalator / storeKey.
   stopAt: stop before reaching this node (pass gltf.scene.parent = floorGroup)
   so the outer "floor_0" wrapper group doesn't taint every mesh as isFloor. */
function getObjectType(obj, stopAt) {
  let isFloor = false, isStore = false, isEscalator = false, cur = obj;
  while (cur && cur !== stopAt) {
    const name = cur.name?.toLowerCase() || '';
    if (name.includes('floor'))                              isFloor      = true;
    if (name.includes('toko'))                               isStore      = true;
    if (name.includes('escalat') || name.includes('eskalat')) isEscalator = true;
    cur = cur.parent;
  }
  return { isFloor, isStore, isEscalator };
}

function getStoreKey(obj) {
  let cur = obj;
  while (cur) {
    const name = cur.name?.toLowerCase() || '';
    if (name.includes('toko')) return name;
    cur = cur.parent;
  }
  return null;
}

/* ── MAP EVENTS ──────────────────────────────────────────── */
map.on('movestart', (e) => {
  if (e.originalEvent) _navAnimating = false;
});

map.on('load', () => {
  clearTimeout(_mapLoadTimeout);
  hideLoading();
  _setModelBar('Memuat model 3D...');

  // Compass button: clone untuk hapus semua listener MapLibre (touch & click),
  // lalu pasang handler kita sendiri untuk toggle top-down ↔ tampilan 3D
  const isMobile = () => window.innerWidth < 640;
  let topDownActive = false;
  const oldCompass = document.querySelector('.maplibregl-ctrl-compass');
  if (oldCompass) {
    const compass = oldCompass.cloneNode(true);
    compass.title = 'Fokus ke Peta';
    compass.setAttribute('aria-label', 'Fokus ke Peta');
    oldCompass.parentNode.replaceChild(compass, oldCompass);
    compass.addEventListener('click', () => {
      if (topDownActive) {
        map.easeTo({ center: [S.lon, S.lat], zoom: isMobile() ? 17 : 18, pitch: isMobile() ? 45 : 58, bearing: -30, duration: 900, easing: ease });
      } else {
        map.easeTo({ center: [S.lon, S.lat], bearing: 0, pitch: 0, zoom: isMobile() ? 16 : 17.5, duration: 900, easing: ease });
      }
      topDownActive = !topDownActive;
    });
  }

  setTimeout(() => {
    const mobile = isMobile();
    map.easeTo({ center: [S.lon, S.lat], zoom: mobile ? 17 : 18, pitch: mobile ? 45 : 58, bearing: -30, duration: 1600, easing: ease });
  }, 300);

  // Tunggu sync Supabase selesai (biasanya sudah selesai saat tiles load),
  // lalu baru tambahkan layer 3D dan bangun category bar
  _dbSyncPromise.then(() => {
    map.addLayer(modelLayer);
    buildCategoryBar();
  });
});

/* ── RAYCASTING ──────────────────────────────────────────── */
function ndcFromEvent(e) {
  const rect = map.getCanvas().getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1,
  );
}

/* Three.js intersectObjects does NOT skip hidden parent groups — check manually. */
function _isAncestorVisible(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

function raycastLogos(ndc) {
  if (!lastMVP || !storeManager?.logos.length) return [];
  const inv  = lastMVP.clone().invert();
  const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inv);
  const far  = new THREE.Vector3(ndc.x, ndc.y,  1).applyMatrix4(inv);
  raycaster.set(near, far.clone().sub(near).normalize());

  return raycaster.intersectObjects(storeManager.logos, false).filter(hit => {
    if (!_isAncestorVisible(hit.object)) return false;
    const mat = hit.object.material;
    if (!mat?.map || !hit.uv) return true;
    return Utils.getTextureAlphaAt(mat.map, hit.uv) > 128;
  });
}

/* ── MOUSE INTERACTION ───────────────────────────────────── */
map.getCanvas().addEventListener('mousedown', (e) => {
  if (!navEditor?.active || navEditor.tool !== 'node' || !e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  _boxSel     = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  _boxWasDrag = false;
  const box = document.getElementById('nav-sel-box');
  if (box) { box.style.display = 'block'; _updateBoxEl(box); }
});

map.getCanvas().addEventListener('mousemove', (e) => {
  if (_boxSel) {
    _boxSel.x1 = e.clientX; _boxSel.y1 = e.clientY;
    const moved = Math.abs(_boxSel.x1 - _boxSel.x0) + Math.abs(_boxSel.y1 - _boxSel.y0);
    if (moved > 5) _boxWasDrag = true;
    const box = document.getElementById('nav-sel-box');
    if (box) _updateBoxEl(box);
    return;
  }
  if (navEditor?.active) {
    const hits = _raycastAgainst(ndcFromEvent(e), navEditor.getNodeMeshes());
    map.getCanvas().style.cursor = hits.length ? 'pointer' : (navEditor.tool === 'node' ? 'crosshair' : '');
    return;
  }
  if (!storeManager) return;
  const hits   = raycastLogos(ndcFromEvent(e));
  const newKey = hits.length > 0 ? hits[0].object.name : null;
  if (newKey !== hoveredKey) {
    hoveredKey = newKey;
    map.getCanvas().style.cursor = newKey ? 'pointer' : '';
  }
});

document.addEventListener('mouseup', () => {
  if (!_boxSel) return;
  const box = document.getElementById('nav-sel-box');
  if (box) box.style.display = 'none';

  if (_boxWasDrag && navEditor && navGraph) {
    const minX = Math.min(_boxSel.x0, _boxSel.x1);
    const maxX = Math.max(_boxSel.x0, _boxSel.x1);
    const minY = Math.min(_boxSel.y0, _boxSel.y1);
    const maxY = Math.max(_boxSel.y0, _boxSel.y1);
    const selected = [];
    for (const [id, node] of Object.entries(navGraph.nodes)) {
      const pt = _projectToScreen(node);
      if (pt && pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) selected.push(id);
    }
    navEditor.selectNodes(selected);
  }
  _boxSel = null;
});

map.getCanvas().addEventListener('click', (e) => {
  if (_boxWasDrag) { _boxWasDrag = false; return; }

  // Link-pick mode: intercept all node clicks on the destination floor
  if (_linkState?.destFloor !== undefined && navEditor?.active) {
    const hits = _raycastAgainst(ndcFromEvent(e), navEditor.getNodeMeshes());
    if (hits.length > 0) _completeLinkPick(hits[0].object.userData.nodeId);
    return;
  }

  if (navEditor?.active) {
    _handleEditorClick(e);
    return;
  }
  if (!storeManager || Popup.isOpen()) return;
  const hits = raycastLogos(ndcFromEvent(e));
  if (hits.length > 0) Popup.open(hits[0].object.name);
});

/* ── RAYCASTING HELPER ───────────────────────────────────── */
function _raycastAgainst(ndc, objects) {
  if (!lastMVP || !objects.length) return [];
  const inv  = lastMVP.clone().invert();
  const near = new THREE.Vector3(ndc.x, ndc.y, -1).applyMatrix4(inv);
  const far  = new THREE.Vector3(ndc.x, ndc.y,  1).applyMatrix4(inv);
  raycaster.set(near, far.clone().sub(near).normalize());
  return raycaster.intersectObjects(objects, false);
}

/* ── EDITOR CLICK HANDLER ────────────────────────────────── */
function _handleEditorClick(e) {
  const ndc = ndcFromEvent(e);
  const nodeMeshes = navEditor.getNodeMeshes();
  if (nodeMeshes.length) {
    const hits = _raycastAgainst(ndc, nodeMeshes);
    if (hits.length > 0) {
      navEditor.handleNodeClick(hits[0].object.userData.nodeId);
      return;
    }
  }
  if (navEditor.tool === 'node') {
    const floorHits = _raycastAgainst(ndc, floorMeshes).filter(h => _isAncestorVisible(h.object));
    if (floorHits.length > 0) navEditor.handleFloorHit(floorHits[0].point);
  }
}

/* ── BOX-SELECT HELPERS ──────────────────────────────────── */
function _projectToScreen(node) {
  if (!lastMVP) return null;
  const v = new THREE.Vector4(node.x, node.y, node.z, 1.0);
  v.applyMatrix4(lastMVP);
  if (v.w <= 0) return null;
  const rect = map.getCanvas().getBoundingClientRect();
  return {
    x: (v.x / v.w * 0.5 + 0.5) * rect.width  + rect.left,
    y: (1 - (v.y / v.w * 0.5 + 0.5)) * rect.height + rect.top,
  };
}

function _updateBoxEl(el) {
  const minX = Math.min(_boxSel.x0, _boxSel.x1);
  const minY = Math.min(_boxSel.y0, _boxSel.y1);
  el.style.left   = minX + 'px';
  el.style.top    = minY + 'px';
  el.style.width  = Math.abs(_boxSel.x1 - _boxSel.x0) + 'px';
  el.style.height = Math.abs(_boxSel.y1 - _boxSel.y0) + 'px';
}

/* ── NAVIGATION MATRIX HELPERS ───────────────────────────── */
function _buildLMatrix() {
  return new THREE.Matrix4()
    .makeTranslation(xf.tx, xf.ty, xf.tz)
    .scale(new THREE.Vector3(xf.s, -xf.s, xf.s))
    .multiply(rotMat);
}

function _nodeToLngLat(node) {
  const L = _buildLMatrix();
  const m = new THREE.Vector3(node.x, node.y, node.z).applyMatrix4(L);
  return new maplibregl.MercatorCoordinate(m.x, m.y, m.z).toLngLat();
}

/* ── MULTI-FLOOR HELPERS ─────────────────────────────────── */
function _floorIdxFromKey(storeKey) {
  const m = storeKey.match(/^f(\d+)_/);
  return m ? parseInt(m[1]) - 1 : 0;
}

function _splitFullId(fullId) {
  const colon = fullId.indexOf(':');
  if (colon === -1) return [_viewFloorIdx, fullId];
  return [parseInt(fullId.slice(0, colon)), fullId.slice(colon + 1)];
}

function _getNode(fullId) {
  const [fi, id] = _splitFullId(fullId);
  return navGraphs[fi]?.nodes[id];
}

function _renderPathForFloor(floorIdx) {
  if (!_navPath) { pathRenderer?.clear(); return; }
  const nodes = _navPath
    .filter(fullId => _splitFullId(fullId)[0] === floorIdx)
    .map(id => _getNode(id))
    .filter(Boolean);
  if (nodes.length > 1) pathRenderer.render(nodes);
  else pathRenderer.clear();
}

const CONNECTOR_STEP_INFO = {
  escalator_up:   { text: 'Naik via Eskalator' },
  escalator_down: { text: 'Turun via Eskalator' },
  escalator_both: { text: 'via Eskalator' },
  lift:           { text: 'via Lift' },
  stairs:         { text: 'via Tangga' },
};

/* ── NODE PROPERTIES PANEL ───────────────────────────────── */
window._navNodeSelected = (nodeId, graph) => {
  _nodePropsId = nodeId;
  _updateNodePropsPanel(nodeId, graph);
};

function _updateNodePropsPanel(nodeId, graph) {
  const panel = document.getElementById('node-props-panel');
  if (!panel) return;
  if (!nodeId) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const node   = graph?.nodes[nodeId];
  const tagSel = document.getElementById('np-tag-select');
  if (tagSel) tagSel.value = node?.tag || '';

  const hasTag  = Boolean(node?.tag);
  const hasConn = Boolean(node?.connectedTo);

  const connRow = document.getElementById('np-connector-row');
  if (connRow) connRow.classList.toggle('hidden', !hasTag && !hasConn);

  const connInfo = document.getElementById('np-connector-info');
  if (connInfo) {
    if (hasConn) {
      const { floorIdx, nodeId: otherId } = node.connectedTo;
      const lbl = S.floors[floorIdx]?.label || `Lantai ${floorIdx + 1}`;
      connInfo.textContent = `Terhubung ke ${lbl} (titik ${otherId})`;
    } else {
      connInfo.textContent = 'Belum terhubung ke lantai lain';
    }
  }

  const linkBtn   = document.getElementById('np-link-btn');
  const unlinkBtn = document.getElementById('np-unlink-btn');
  if (linkBtn)   linkBtn.style.display   = (hasTag && !hasConn && S.floors.length > 1) ? '' : 'none';
  if (unlinkBtn) unlinkBtn.style.display = hasConn ? '' : 'none';
}

window.navEdSetNodeTag = (tag) => {
  if (!_nodePropsId) return;
  navGraph.setNodeTag(_nodePropsId, tag || null);
  _updateNodePropsPanel(_nodePropsId, navGraph);
};

window.navEdStartLink = () => {
  if (!_nodePropsId || S.floors.length < 2) return;
  _linkState = { srcFloor: _viewFloorIdx, srcNodeId: _nodePropsId };
  const btnsEl = document.getElementById('lfm-floor-btns');
  if (btnsEl) {
    btnsEl.innerHTML = S.floors.map((f, i) =>
      i === _viewFloorIdx ? '' :
      `<button class="nav-ed-btn" onclick="navEdPickFloorForLink(${i})">${f.label}</button>`
    ).join('');
  }
  document.getElementById('link-floor-modal')?.classList.remove('hidden');
};

window.navEdPickFloorForLink = (floorIdx) => {
  document.getElementById('link-floor-modal')?.classList.add('hidden');
  if (!_linkState) return;
  _linkState.destFloor = floorIdx;
  window.switchFloor(floorIdx);
  document.getElementById('link-pick-hint')?.classList.remove('hidden');
};

window.navEdCancelLink = () => {
  _linkState = null;
  document.getElementById('link-floor-modal')?.classList.add('hidden');
  document.getElementById('link-pick-hint')?.classList.add('hidden');
};

window.navEdUnlink = () => {
  if (!_nodePropsId) return;
  const node = navGraph.nodes[_nodePropsId];
  if (node?.connectedTo) {
    const { floorIdx: otherFi, nodeId: otherId } = node.connectedTo;
    navGraphs[otherFi]?.clearNodeConnector(otherId);
  }
  navGraph.clearNodeConnector(_nodePropsId);
  _updateNodePropsPanel(_nodePropsId, navGraph);
};

function _completeLinkPick(destNodeId) {
  if (!_linkState || _linkState.destFloor === undefined) return;
  const { srcFloor, srcNodeId, destFloor } = _linkState;
  _linkState = null;
  document.getElementById('link-pick-hint')?.classList.add('hidden');

  navGraphs[srcFloor].setNodeConnector(srcNodeId, destFloor, destNodeId);

  // For bidirectional connectors (lift, stairs, escalator_both) — auto-set reverse
  const srcNode = navGraphs[srcFloor].nodes[srcNodeId];
  const tag = srcNode?.tag;
  if (!tag || tag === 'lift' || tag === 'stairs' || tag === 'escalator_both') {
    navGraphs[destFloor].setNodeTag(destNodeId, tag || 'lift');
    navGraphs[destFloor].setNodeConnector(destNodeId, srcFloor, srcNodeId);
  }

  window.switchFloor(srcFloor);
  _updateNodePropsPanel(srcNodeId, navGraphs[srcFloor]);
}

/* ── NAVIGATION FUNCTIONS ────────────────────────────────── */
let _navStartStores = [];

function _renderNavStartList(query) {
  const list = document.getElementById('nav-start-list');
  if (!list) return;
  const ql = query.trim().toLowerCase();
  const hits = ql
    ? _navStartStores.filter(s => s.name?.toLowerCase().includes(ql) || s.key?.toLowerCase().includes(ql))
    : _navStartStores;
  list.innerHTML = hits.map(s =>
    `<button class="nav-start-item" onclick="selectNavStart('${s.key}')">
       <div class="nav-start-thumb"><img src="${s.logo || Utils.DEFAULT_LOGO}" alt=""/></div>
       <div class="nav-start-name">${s.name || s.key}</div>
     </button>`
  ).join('') || '<p class="nav-start-empty">Toko tidak ditemukan.</p>';
}

function startNavigation(destStoreKey) {
  if (!navGraph || navGraph.nodeCount() === 0) {
    alert('Belum ada waypoint navigasi. Tambahkan waypoint di Pengaturan → Editor Navigasi.');
    return;
  }
  Popup.close();
  _navDest = destStoreKey;
  _navStartStores = Utils.getStoreConfig().filter(s => s.key !== destStoreKey && storeManager?.getStoreData(s.key));

  const searchEl = document.getElementById('nav-start-search');
  if (searchEl) {
    searchEl.value = '';
    searchEl.oninput = () => _renderNavStartList(searchEl.value);
  }

  _renderNavStartList('');
  document.getElementById('nav-start-modal')?.classList.remove('hidden');
  setTimeout(() => searchEl?.focus(), 80);
}

function selectNavStart(startStoreKey) {
  document.getElementById('nav-start-modal')?.classList.add('hidden');
  _navStart = startStoreKey;
  _runPath(startStoreKey, _navDest);
}

function _runPath(startStoreKey, destStoreKey) {
  const startData = storeManager.getStoreData(startStoreKey);
  const endData   = storeManager.getStoreData(destStoreKey);
  if (!startData || !endData) return;

  const sp = startData.logo?.position ?? startData.bases?.[0]?.position;
  const ep = endData.logo?.position   ?? endData.bases?.[0]?.position;
  if (!sp || !ep) return;

  const startFi    = _floorIdxFromKey(startStoreKey);
  const goalFi     = _floorIdxFromKey(destStoreKey);
  const startGraph = navGraphs[startFi];
  const goalGraph  = navGraphs[goalFi];
  if (!startGraph || !goalGraph) return;

  const startNode = startGraph.nearest(sp.x, sp.z);
  const endNode   = goalGraph.nearest(ep.x, ep.z);
  if (!startNode || !endNode) { alert('Tidak ada waypoint terdekat.'); return; }

  document.getElementById('nav-step-panel')?.classList.remove('hidden');
  document.getElementById('nav-step-title').textContent = `Menuju ${Utils.findStore(destStoreKey)?.name || destStoreKey}`;
  _syncRouteTypeBtns();

  const loadEl = document.getElementById('nav-step-list');
  if (loadEl) loadEl.innerHTML = '<div class="nav-step-loading">Menghitung jalur...</div>';

  clearTimeout(_navAutoTimer);
  setTimeout(() => {
    const path = findPathMultiFloor(navGraphs, startFi, startNode, goalFi, endNode, _navRouteType);
    if (!path) {
      if (loadEl) loadEl.innerHTML = '<div class="nav-step-loading">Jalur tidak ditemukan.</div>';
      return;
    }
    _navPath = path;
    _renderPathForFloor(startFi);
    _buildStepList(path, startStoreKey, destStoreKey);
    _animateCameraAlongPath(path);
    _navAutoTimer = setTimeout(clearNavigation, 30000);
  }, 500);
}

function _syncRouteTypeBtns() {
  ['main','fastest'].forEach(t => {
    document.getElementById(`nav-rt-main`)?.classList.toggle('active', _navRouteType === 'main');
    document.getElementById(`nav-rt-fast`)?.classList.toggle('active', _navRouteType === 'fastest');
    document.getElementById(`nav-sp-rt-main`)?.classList.toggle('active', _navRouteType === 'main');
    document.getElementById(`nav-sp-rt-fast`)?.classList.toggle('active', _navRouteType === 'fastest');
  });
}

/* Returns turn info or null if too shallow to call a turn */
function _getTurnDir(a, b, c) {
  const dx1 = b.x - a.x, dz1 = b.z - a.z;
  const dx2 = c.x - b.x, dz2 = c.z - b.z;
  const cross = dx1 * dz2 - dz1 * dx2;
  const dot   = dx1 * dx2 + dz1 * dz2;
  const angle = Math.atan2(Math.abs(cross), dot); // 0 = straight, π = U-turn
  if (angle < 0.35) return null;                  // < 20° — ignore
  const side = cross > 0 ? 'kanan' : 'kiri';
  let type;
  if      (angle < 0.7)  type = 'slight';  // 20–40°
  else if (angle < 2.1)  type = 'normal';  // 40–120°
  else                   type = 'sharp';   // > 120°
  return { side, type, angle };
}

/* Inline SVG arrow — base points up, rotated for each direction */
function _arrowSvg(deg, color) {
  return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="${color}" `
    + `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" `
    + `style="transform:rotate(${deg}deg);display:block">`
    + `<path d="M10 16V4M6 9l4-5 4 5"/></svg>`;
}

function _stepHtml(iconClass, iconSvg, text, dist) {
  const distHtml = dist > 0 ? `<span class="nav-step-dist">±${Math.round(dist)}m</span>` : '';
  return `<div class="nav-step-item">
    <div class="nav-step-icon ${iconClass}">${iconSvg}</div>
    <div class="nav-step-text">${text}${distHtml}</div>
  </div>`;
}

function _floorChangeStepHtml(text, destLabel, tag) {
  const iconMap = { escalator_up: '🔼', escalator_down: '🔽', escalator_both: '↕', lift: '🛗', stairs: '🪜' };
  const icon = iconMap[tag] || '⬆';
  return `<div class="nav-step-item nav-step-item--floor">
    <div class="nav-step-icon nav-step-icon--floor">${icon}</div>
    <div class="nav-step-text">${text} ke <b>${destLabel}</b></div>
  </div>`;
}

function _buildStepList(path, startKey, endKey) {
  const el = document.getElementById('nav-step-list');
  if (!el) return;
  const startName = Utils.findStore(startKey)?.name || startKey;
  const endName   = Utils.findStore(endKey)?.name   || endKey;

  const startSvg = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round">
    <circle cx="10" cy="8" r="3"/><path d="M10 2a6 6 0 0 1 0 12C6 14 4 11 4 8a6 6 0 0 1 6-6z"/></svg>`;
  const endSvg = `<svg width="15" height="15" viewBox="0 0 20 20" fill="#6366f1">
    <circle cx="10" cy="10" r="5"/></svg>`;

  const items = [_stepHtml('nav-step-icon--start', startSvg, `Mulai dari <b>${startName}</b>`, 0)];

  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    const prevFull = path[i - 1], curFull = path[i];
    const [prevFi, prevId] = _splitFullId(prevFull);
    const [curFi,  curId]  = _splitFullId(curFull);
    const isLast = i === path.length - 1;

    if (prevFi !== curFi) {
      // Floor transition
      if (dist > 1) items.push(_stepHtml('nav-step-icon--straight', _arrowSvg(0, '#38bdf8'), 'Jalan lurus', dist));
      dist = 0;
      const srcNode = navGraphs[prevFi]?.nodes[prevId];
      const tag  = srcNode?.tag || 'lift';
      const info = CONNECTOR_STEP_INFO[tag] || { text: 'Pindah lantai' };
      const destLabel = S.floors[curFi]?.label || `Lantai ${curFi + 1}`;
      items.push(_floorChangeStepHtml(info.text, destLabel, tag));
      continue;
    }

    dist += navGraphs[prevFi].dist(prevId, curId) * S.floors[prevFi].scale;

    if (!isLast) {
      const [nextFi] = _splitFullId(path[i + 1]);
      if (nextFi !== curFi) continue; // next step is a floor transition — skip turn check
      const turn = _getTurnDir(_getNode(prevFull), _getNode(curFull), _getNode(path[i + 1]));
      if (turn) {
        if (dist > 1) items.push(_stepHtml('nav-step-icon--straight', _arrowSvg(0, '#38bdf8'), 'Jalan lurus', dist));
        const isRight = turn.side === 'kanan';
        const deg     = turn.type === 'slight' ? (isRight ? 40 : -40)
                      : turn.type === 'sharp'  ? (isRight ? 140 : -140)
                      :                          (isRight ? 90 : -90);
        const label   = turn.type === 'slight' ? `Sedikit ke ${turn.side}`
                      : turn.type === 'sharp'  ? `Belok tajam ke ${turn.side}`
                      :                          `Belok ${turn.side}`;
        items.push(_stepHtml('nav-step-icon--turn', _arrowSvg(deg, '#fbbf24'), label, 0));
        dist = 0;
      }
    } else {
      if (dist > 1) items.push(_stepHtml('nav-step-icon--straight', _arrowSvg(0, '#38bdf8'), 'Jalan lurus', dist));
      items.push(_stepHtml('nav-step-icon--end', endSvg, `Tiba di <b>${endName}</b>`, 0));
    }
  }

  el.innerHTML = items.join('');
}

async function _animateCameraAlongPath(path) {
  if (!path.length) return;
  _navAnimating = true;
  if (window.innerWidth < 640) document.getElementById('nav-step-panel')?.classList.add('minimized');

  // Split path into ordered floor segments
  const segments = [];
  for (const fullId of path) {
    const [fi] = _splitFullId(fullId);
    const last = segments[segments.length - 1];
    if (!last || last.floorIdx !== fi) segments.push({ floorIdx: fi, nodes: [] });
    segments[segments.length - 1].nodes.push(fullId);
  }

  for (let si = 0; si < segments.length; si++) {
    if (!_navAnimating) return;
    const seg     = segments[si];
    const isLastSeg = si === segments.length - 1;

    // Switch floor and show only this segment's path
    if (_viewFloorIdx !== seg.floorIdx) window.switchFloor(seg.floorIdx);
    pathRenderer.render(seg.nodes.map(id => _getNode(id)).filter(Boolean));

    // Pick a handful of keypoints to fly through
    const subset = seg.nodes.filter((_, i) =>
      i === 0 || i === seg.nodes.length - 1 ||
      i % Math.max(1, Math.floor(seg.nodes.length / 4)) === 0
    );

    for (let i = 0; i < subset.length; i++) {
      if (!_navAnimating) return;
      const node = _getNode(subset[i]);
      if (!node) continue;
      const center = _nodeToLngLat(node);
      const isLast = isLastSeg && i === subset.length - 1;
      await new Promise(resolve => {
        map.easeTo({ center, zoom: isLast ? 19.5 : 19, pitch: 60, bearing: -30, duration: 900, easing: ease });
        setTimeout(resolve, 950);
      });
    }
  }

  _navAnimating = false;
  document.getElementById('nav-step-panel')?.classList.remove('minimized');
}

window.toggleNavPanel = () => {
  document.getElementById('nav-step-panel')?.classList.toggle('minimized');
};

function clearNavigation() {
  clearTimeout(_navAutoTimer);
  _navAutoTimer = null;
  _navAnimating = false;
  _navDest  = null;
  _navStart = null;
  _navPath  = null;
  pathRenderer?.clear();
  document.getElementById('nav-step-panel')?.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════
   SETTINGS MODAL
   ══════════════════════════════════════════════════════════ */
const _PANEL_TITLES = { map: 'Pengaturan Map', nav: 'Editor Navigasi', categories: 'Filter Kategori' };

window.openPanel = (type) => {
  ['map', 'nav', 'categories'].forEach(t => {
    document.getElementById(`section-${t}`)?.classList.toggle('hidden', t !== type);
  });
  document.getElementById('modal-title').textContent = _PANEL_TITLES[type] || '';

  if (type === 'map') {
    document.getElementById('inp-lon').value = S.lon;
    document.getElementById('inp-lat').value = S.lat;
    _buildFloorUI();
    document.getElementById('inp-floor-color').value   = C().floorColor;
    document.getElementById('inp-default-color').value = C().defaultColor;
    document.getElementById('inp-store-color').value   = C().storeColor;
  }
  if (type === 'categories') {
    _buildCategoryAdminUI();
  }
  if (type === 'nav') {
    const tog = document.getElementById('nav-ed-toggle');
    if (tog) tog.checked = navEditor?.active || false;
  }
  document.getElementById('settings-modal').classList.remove('hidden');
};

window.openSettings = () => window.openPanel('map');

window.closeSettings = () => {
  document.getElementById('settings-modal').classList.add('hidden');
};

/* ══════════════════════════════════════════════════════════
   AUTH / ADMIN
   ══════════════════════════════════════════════════════════ */
function _applyAdminState(isAdmin) {
  _isAdmin = isAdmin;
  document.body.classList.toggle('is-admin', isAdmin);
  const label = document.getElementById('admin-btn-label');
  if (label) label.textContent = isAdmin ? 'Logout' : 'Admin';
}

window.openAdminLogin = () => {
  document.getElementById('admin-login-modal')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('admin-email')?.focus(), 80);
};

window.closeAdminLogin = () => {
  document.getElementById('admin-login-modal')?.classList.add('hidden');
  const err = document.getElementById('admin-login-error');
  if (err) err.textContent = '';
};

window.doLogin = async () => {
  const email = document.getElementById('admin-email')?.value.trim();
  const pass  = document.getElementById('admin-password')?.value;
  if (!email || !pass) return;
  const btn = document.getElementById('admin-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Masuk...'; }
  const { user, error } = await signIn(email, pass);
  if (btn) { btn.disabled = false; btn.textContent = 'Masuk'; }
  if (error) {
    const err = document.getElementById('admin-login-error');
    if (err) err.textContent = error;
    return;
  }
  if (user) window.closeAdminLogin();
  // _applyAdminState dipanggil otomatis oleh onAuthChange
};

window.doLogout = async () => {
  await signOut();
  // _applyAdminState dipanggil otomatis oleh onAuthChange
};

window._onAdminBtnClick = () => {
  if (_isAdmin) window.doLogout();
  else window.openAdminLogin();
};

// Ctrl+Shift+Alt+A — tampilkan/sembunyikan tombol login admin
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key === 'A') {
    document.body.classList.toggle('show-admin-btn');
  }
});

window.applyCoordinates = () => {
  const lon = parseFloat(document.getElementById('inp-lon').value);
  const lat = parseFloat(document.getElementById('inp-lat').value);
  if (isNaN(lon) || isNaN(lat)) return;
  S.lon = lon; S.lat = lat;
  persist(); recompute();
  map.setMaxBounds(mapBounds(S.lon, S.lat));
  map.flyTo({ center: [S.lon, S.lat], zoom: 17, pitch: 52, bearing: -25, duration: 1200, easing: ease });
  map.triggerRepaint();
};

window.toggleMapStyle = async (isDark) => {
  S.darkMode = isDark;
  localStorage.setItem('imap_cfg', JSON.stringify(S));
  try { await saveMapConfig(S); } catch {}
  location.reload();
};

window.applyMapColors = () => {
  C().floorColor   = document.getElementById('inp-floor-color').value;
  C().defaultColor = document.getElementById('inp-default-color').value;
  C().storeColor   = document.getElementById('inp-store-color').value;
  persist();

  floorMeshes.forEach(m => {
    m.material.color.set(C().floorColor);
    m.material.needsUpdate = true;
  });

  if (modelLayer.scene) {
    modelLayer.scene.traverse((child) => {
      if (!child.isMesh) return;
      if (child.userData.type === 'store') {
        child.material.color.set(C().storeColor);
        child.material.needsUpdate = true;
      } else if (child.userData.type === 'other') {
        child.material.color.set(C().defaultColor);
        child.material.needsUpdate = true;
      }
    });
  }

  storeManager?.updateBaseColors(C().storeColor);
  map.triggerRepaint();
};

/* ── SLIDER BINDINGS ─────────────────────────────────────── */
// (per-floor sliders are built dynamically in _buildFloorUI)

/* ── HELPERS ─────────────────────────────────────────────── */
function bindSD(name, onChange) {
  const sld = document.getElementById(`sld-${name}`);
  const inp = document.getElementById(`inp-${name}`);
  if (sld) sld.addEventListener('input', () => { inp.value = sld.value; onChange(+sld.value); });
  if (inp) inp.addEventListener('input', () => { sld.value = inp.value; onChange(+inp.value); });
}

function syncSD(name, value) {
  const sld = document.getElementById(`sld-${name}`);
  const inp = document.getElementById(`inp-${name}`);
  if (sld) sld.value = value;
  if (inp) inp.value = value;
}

let _activeFloorIdx = 0;
let _viewFloorIdx   = 0; // which floor is currently visible to user

function _buildFloorUI() {
  const container = document.getElementById('floor-manager');
  if (!container) return;
  const f = S.floors[_activeFloorIdx];
  const i = _activeFloorIdx;
  const tabs = S.floors.map((fl, ti) =>
    `<button class="floor-tab${ti === i ? ' active' : ''}" onclick="window.selectFloor(${ti})">${fl.label}</button>`
  ).join('') + `<button class="floor-tab floor-tab-add" onclick="window.addFloor()">+ Tambah</button>`;

  container.innerHTML = `
    <div class="floor-tabs">${tabs}</div>
    <div class="floor-panel">
      <div class="floor-field-row">
        <span class="floor-field-label">File GLB</span>
        <div class="floor-glb-row">
          <input class="floor-text-inp" id="finp-path" type="text" value="${f.path}" placeholder="mall3.glb" />
          <input type="file" id="finp-glb-input" accept=".glb,.gltf" style="display:none" />
          <button class="floor-upload-btn" id="finp-upload-btn" title="Upload GLB ke Supabase Storage">Upload</button>
        </div>
      </div>
      <div class="floor-field-row">
        <span class="floor-field-label">Label</span>
        <input class="floor-text-inp" id="finp-label" type="text" value="${f.label}" />
      </div>
      ${_fSlider('Ketinggian','alt', f.altitudeM,  0,    30,  0.5,'m')}
      ${_fSlider('Offset X',  'ox',  f.offsetX,    -500, 500, 1,  'm · timur+/barat−')}
      ${_fSlider('Offset Y',  'oy',  f.offsetY,    -500, 500, 1,  'm · utara+/selatan−')}
      ${_fSlider('Rotasi',    'rot', f.rotationY,  0,    360, 1,  '°')}
      ${_fSlider('Ukuran',    'scl', f.scale,      1,    200, 1,  'skala')}
      ${S.floors.length > 1 ? `<button class="floor-delete-btn" onclick="window.deleteFloor(${i})">Hapus ${f.label}</button>` : ''}
    </div>`;

  document.getElementById('finp-path')?.addEventListener('change', e => { S.floors[i].path = e.target.value.trim(); persist(); });

  const uploadBtn = document.getElementById('finp-upload-btn');
  const glbInput  = document.getElementById('finp-glb-input');
  if (uploadBtn && glbInput) {
    if (!isConfigured()) { uploadBtn.disabled = true; uploadBtn.title = 'Supabase belum dikonfigurasi'; }
    uploadBtn.onclick = () => glbInput.click();
    glbInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading...';
      glbInput.value = '';
      const { uploadAsset } = await import('./db.js');
      const url = await uploadAsset(file, `models/${file.name}`);
      if (url) {
        const bustedUrl = `${url}?t=${Date.now()}`;
        S.floors[i].path = bustedUrl;
        document.getElementById('finp-path').value = bustedUrl;
        persist();
        uploadBtn.textContent = '✓ Berhasil';
        setTimeout(() => {
          if (confirm('GLB berhasil diupload. Muat ulang halaman untuk memuat model baru?')) {
            location.reload();
          } else {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload';
          }
        }, 400);
      } else {
        alert('Upload gagal. Cek konsol untuk detail.');
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload';
      }
    };
  }
  document.getElementById('finp-label')?.addEventListener('input', e => {
    S.floors[i].label = e.target.value; persist();
    document.querySelectorAll('.floor-tab')[i].textContent = e.target.value;
  });
  _bfSlider('alt', v => { S.floors[i].altitudeM = v; _fChanged(); });
  _bfSlider('ox',  v => { S.floors[i].offsetX   = v; if (i === 0) recompute(); _fChanged(); });
  _bfSlider('oy',  v => { S.floors[i].offsetY   = v; if (i === 0) recompute(); _fChanged(); });
  _bfSlider('rot', v => { S.floors[i].rotationY = v; if (i === 0) recompute(); _fChanged(); });
  _bfSlider('scl', v => { S.floors[i].scale     = v; if (i === 0) recompute(); _fChanged(); });
}

function _fSlider(label, key, val, min, max, step, hint) {
  return `<div class="slider-group"><div class="slider-header">
    <span class="slider-name">${label} <span class="axis-hint">(${hint})</span></span>
    <input class="num-inp" type="number" id="fnum-${key}" step="${step}" min="${min}" max="${max}" value="${val}" />
  </div><input class="range-slider" type="range" id="fsld-${key}" min="${min}" max="${max}" step="${step}" value="${val}" /></div>`;
}

function _bfSlider(key, cb) {
  const s = document.getElementById(`fsld-${key}`), n = document.getElementById(`fnum-${key}`);
  if (!s || !n) return;
  s.addEventListener('input', () => { n.value = s.value; cb(+s.value); });
  n.addEventListener('input', () => { s.value = n.value; cb(+n.value); });
}

function _fChanged() { map.triggerRepaint(); persist(); }

window.selectFloor = (i) => { _activeFloorIdx = i; _buildFloorUI(); };

function _buildFloorSwitcher() {
  const el = document.getElementById('floor-badge');
  if (!el) return;
  if (S.floors.length < 2) {
    el.innerHTML = '&#x1F4CD; ' + (S.floors[0]?.label || 'Lantai 1');
    el.style.padding = '';
    return;
  }
  const i    = _viewFloorIdx;
  const prev = i > 0                    ? `onclick="window.switchFloor(${i - 1})"` : 'disabled';
  const next = i < S.floors.length - 1 ? `onclick="window.switchFloor(${i + 1})"` : 'disabled';
  el.style.padding = '6px 14px';
  el.innerHTML =
    `<button class="fb-arrow" ${prev}>&#x2039;</button>` +
    `<span class="fb-label">&#x1F4CD; ${S.floors[i].label}</span>` +
    `<button class="fb-arrow" ${next}>&#x203A;</button>`;
}

window.switchFloor = (i) => {
  const wasActive = navEditor?.active;
  if (wasActive) navEditor.setActive(false);

  _viewFloorIdx = i;
  floorGroups.forEach((g, gi) => { if (g) g.visible = (gi === i); });
  logoGroups.forEach((g, gi)  => { if (g) g.visible = (gi === i); });

  navGraph  = navGraphs[i]  || navGraphs[0];
  navEditor = navEditors[i] || navEditors[0];
  if (wasActive) navEditor.setActive(true);

  if (_navPath) _renderPathForFloor(i);

  _buildFloorSwitcher();
  map.triggerRepaint();
};

window.addFloor = () => {
  const idx = S.floors.length, base = S.floors[0];
  S.floors.push({ ..._FLOOR_DEFAULTS, path: `mall${idx + 1}.glb`, label: `Lantai ${idx + 1}`, altitudeM: idx * 5, offsetX: base.offsetX, offsetY: base.offsetY, rotationY: base.rotationY, scale: base.scale });
  persist();
  if (modelLayer.scene) {
    _loadSingleFloor(modelLayer.scene, idx);
    const key = `imap_navgraph_${idx}`;
    navGraphs[idx]  = new NavigationGraph(key);
    navEditors[idx] = new NavEditor(modelLayer.scene, navGraphs[idx]);
  }
  _activeFloorIdx = idx;
  _buildFloorUI();
  _buildFloorSwitcher();
};

window.deleteFloor = (i) => {
  if (S.floors.length <= 1) return;
  const group = floorGroups[i];
  if (group) { modelLayer.scene?.remove(group); floorGroups.splice(i, 1); }
  const lg = logoGroups[i];
  if (lg) { modelLayer.scene?.remove(lg); logoGroups.splice(i, 1); }
  navEditors[i]?.setActive(false);
  navEditors.splice(i, 1);
  navGraphs.splice(i, 1);
  S.floors.splice(i, 1);
  if (_activeFloorIdx >= S.floors.length) _activeFloorIdx = S.floors.length - 1;
  if (_viewFloorIdx >= S.floors.length) {
    _viewFloorIdx = 0;
    floorGroups.forEach((g, gi) => { if (g) g.visible = (gi === 0); });
    logoGroups.forEach((g, gi)  => { if (g) g.visible = (gi === 0); });
    navGraph  = navGraphs[0];
    navEditor = navEditors[0];
  }
  persist(); _buildFloorUI(); _buildFloorSwitcher(); map.triggerRepaint();
};

function setThemeLabels(isDark) {
  document.getElementById('lbl-light').classList.toggle('active', !isDark);
  document.getElementById('lbl-dark').classList.toggle('active',  isDark);
}

function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function setLoadingText(msg) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = msg;
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}

function _setModelBar(msg) {
  const bar = document.getElementById('model-loading-bar');
  const txt = document.getElementById('model-loading-text');
  if (!bar) return;
  if (txt) txt.textContent = msg;
  bar.classList.remove('hidden');
}

function _hideModelBar() {
  const bar = document.getElementById('model-loading-bar');
  if (bar) bar.classList.add('hidden');
}

/* ── CATEGORY FILTER ─────────────────────────────────────── */
function buildCategoryBar() {
  const bar = document.getElementById('category-bar');
  if (!bar) return;
  const cats = S.categoryFilters || [];
  bar.innerHTML = cats.map(c => {
    const lbl = c.label.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `<button class="cat-chip" data-cat="${lbl}"
      onclick="window.applyCategoryFilter('${lbl}')">
      ${c.icon ? `<span>${c.icon}</span>` : ''}<span>${c.label}</span>
    </button>`;
  }).join('');
}

window.applyCategoryFilter = (label) => {
  if (_catFilterLabel === label) { clearCategoryFilter(); return; }
  clearTimeout(_catFilterTimeout);

  // Reset opacity of previous filter
  if (_catHighlightKeys && storeManager) {
    _catHighlightKeys.forEach(k => {
      storeManager.getStoreData(k)?.bases?.forEach(m => { m.material.opacity = 0.65; });
    });
  }

  // Fokus ke peta seperti tombol compass
  const mobile = window.innerWidth < 640;
  map.easeTo({ center: [S.lon, S.lat], zoom: mobile ? 17 : 18, pitch: mobile ? 45 : 58, bearing: -30, duration: 900, easing: ease });

  _catFilterLabel = label;
  document.querySelectorAll('.cat-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.cat === label)
  );

  const cfg = Utils.getStoreConfig();
  const matching = cfg.filter(s =>
    s.category && s.category.toLowerCase().includes(label.toLowerCase())
  );

  if (!matching.length) { _catHighlightKeys = null; return; }

  _catHighlightKeys  = new Set(matching.map(s => s.key));
  _catHighlightStart = performance.now();

  // Group by floor index, then animate per floor in order
  const byFloor = {};
  matching.forEach(s => {
    const fi = parseInt(s.key.match(/^f(\d+)_/)?.[1] ?? '1') - 1;
    if (!byFloor[fi]) byFloor[fi] = [];
    byFloor[fi].push(s.key);
  });

  const floors = Object.keys(byFloor).map(Number).sort();
  _runCatFloorSeq(floors, 0);
};

function _runCatFloorSeq(floors, idx) {
  if (!_catFilterLabel || idx >= floors.length) return;
  window.switchFloor(floors[idx]);
  _catHighlightStart = performance.now();
  if (idx < floors.length - 1) {
    _catFilterTimeout = setTimeout(() => _runCatFloorSeq(floors, idx + 1), 3200);
  }
}

function clearCategoryFilter() {
  clearTimeout(_catFilterTimeout);
  if (_catHighlightKeys && storeManager) {
    _catHighlightKeys.forEach(k => {
      storeManager.getStoreData(k)?.bases?.forEach(m => { m.material.opacity = 0.65; });
    });
  }
  _catFilterLabel   = null;
  _catHighlightKeys = null;
  document.querySelectorAll('.cat-chip').forEach(b => b.classList.remove('active'));
}

/* ── CATEGORY ADMIN UI ───────────────────────────────────── */
function _buildCategoryAdminUI() {
  const el = document.getElementById('cat-admin-list');
  if (!el) return;
  if (!S.categoryFilters) S.categoryFilters = [];
  el.innerHTML = S.categoryFilters.map((c, i) => `
    <div class="cat-admin-row">
      <input class="cat-admin-icon" type="text" maxlength="4"
        value="${(c.icon || '').replace(/"/g, '&quot;')}" placeholder="😀"
        oninput="window._catSetIcon(${i}, this.value)" />
      <input class="cat-admin-label" type="text"
        value="${(c.label || '').replace(/"/g, '&quot;')}" placeholder="Nama kategori"
        oninput="window._catSetLabel(${i}, this.value)"
        onblur="window._catSave()" />
      <button class="cat-admin-del" onclick="window._catDelete(${i})">✕</button>
    </div>
  `).join('') + `<button class="cat-admin-add-btn" onclick="window._catAdd()">+ Tambah</button>`;
}

window._catSetIcon  = (i, v) => { S.categoryFilters[i].icon  = v; buildCategoryBar(); };
window._catSetLabel = (i, v) => { S.categoryFilters[i].label = v; buildCategoryBar(); };
window._catSave     = ()     => persist();
window._catDelete   = (i)    => {
  S.categoryFilters.splice(i, 1);
  _buildCategoryAdminUI();
  buildCategoryBar();
  persist();
};
window._catAdd = () => {
  S.categoryFilters.push({ label: '', icon: '' });
  _buildCategoryAdminUI();
  persist();
};

/* ── SEARCH SELECT ───────────────────────────────────────── */
function searchSelectStore(key) {
  highlightKey   = key;
  highlightStart = performance.now();

  const data = storeManager?.getStoreData(key);
  const l = new THREE.Matrix4()
    .makeTranslation(xf.tx, xf.ty, xf.tz)
    .scale(new THREE.Vector3(xf.s, -xf.s, xf.s))
    .multiply(rotMat);

  const toLL = pt => {
    const m = pt.clone().applyMatrix4(l);
    return new maplibregl.MercatorCoordinate(m.x, m.y, m.z).toLngLat();
  };

  // Bounding box of all base meshes → 4 corners → geographic bounds → auto zoom
  const box = new THREE.Box3();
  data?.bases?.forEach(m => box.expandByObject(m));

  if (!box.isEmpty()) {
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    ];
    const lngs = corners.map(c => toLL(c).lng);
    const lats  = corners.map(c => toLL(c).lat);
    const bounds = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    const cam = map.cameraForBounds(bounds, { padding: 120, maxZoom: 21 });
    if (cam) {
      map.flyTo({ ...cam, pitch: 58, bearing: -30, duration: 1000, easing: ease });
      return;
    }
  }

  // Fallback: fly to logo/base center point
  const mesh = data?.logo || data?.bases?.[0];
  if (mesh) map.flyTo({ center: toLL(mesh.position), zoom: 19, pitch: 58, bearing: -30, duration: 1000, easing: ease });
}

/* ── SEARCH ──────────────────────────────────────────────── */
const srchInput   = document.getElementById('srch-input');
const srchResults = document.getElementById('srch-results');
const srchClear   = document.getElementById('srch-clear');

function srchClose() {
  srchResults.classList.add('hidden');
}

function srchOpen(q) {
  const all  = Utils.getStoreConfig().filter(s => storeManager?.getStoreData(s.key));
  const ql   = q.toLowerCase();
  const hits = all
    .filter(s => s.name?.toLowerCase().includes(ql) || s.key?.toLowerCase().includes(ql))
    .slice(0, 6);

  srchResults.innerHTML = '';

  if (!hits.length) {
    srchResults.innerHTML = '<div class="srch-empty">Toko tidak ditemukan</div>';
  } else {
    hits.forEach(s => {
      const el  = document.createElement('div');
      el.className = 'srch-item';
      el.innerHTML = `
        <div class="srch-thumb"><img src="${s.logo || Utils.DEFAULT_LOGO}" alt="" /></div>
        <div>
          <div class="srch-item-name">${s.name || s.key}</div>
          ${s.category ? `<div class="srch-item-cat">${s.category}</div>` : ''}
        </div>`;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur before click fires
        srchInput.value = '';
        srchClear.classList.add('hidden');
        srchClose();
        searchSelectStore(s.key);
      });
      srchResults.appendChild(el);
    });
  }

  srchResults.classList.remove('hidden');
}

srchInput.addEventListener('input', () => {
  const q = srchInput.value.trim();
  srchClear.classList.toggle('hidden', !q);
  if (q) srchOpen(q); else srchClose();
});

srchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    srchInput.value = '';
    srchClear.classList.add('hidden');
    srchClose();
    srchInput.blur();
  }
});

srchInput.addEventListener('blur', () => {
  setTimeout(srchClose, 150);
});

srchClear.addEventListener('click', () => {
  srchInput.value = '';
  srchClear.classList.add('hidden');
  srchClose();
  srchInput.focus();
});

/* ── NAV EDITOR KEYBOARD SHORTCUTS ──────────────────────── */
document.addEventListener('keydown', (e) => {
  if (!navEditor?.active) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); navEditor.undo(); return; }
  if (e.ctrlKey && (e.key === 'y' || (e.key === 'Z' && e.shiftKey))) { e.preventDefault(); navEditor.redo(); return; }

  if (e.key === 'Delete') { e.preventDefault(); navEditor.deleteSelected(); return; }

  const STEP = e.shiftKey ? 0.001 : 0.005;
  const dirs = { w: [0, -STEP], s: [0, STEP], a: [-STEP, 0], d: [STEP, 0] };
  const mv = dirs[e.key.toLowerCase()];
  if (mv) { e.preventDefault(); navEditor.moveSelected(mv[0], mv[1]); }
});

/* ── init panel theme toggle ─────────────────────────────── */
document.getElementById('toggle-dark').checked = S.darkMode;
setThemeLabels(S.darkMode);
