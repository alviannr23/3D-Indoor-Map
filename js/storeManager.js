import * as THREE from 'three';
import * as Utils from './utils.js';

export class StoreManager {
  constructor(scene, initialStoreColor = '#1500ff') {
    this.scene        = scene;
    this.storeMeshes  = {};  // storeKey → { logo, bases[] }
    this.logos        = [];  // all interactable meshes (logos + bases)
    this._cachedColor = initialStoreColor;
  }

  /* ── STORE CONFIG ──────────────────────────────────────── */
  getOrCreateStore(storeKey) {
    let cfg   = Utils.getStoreConfig();
    let store = Utils.findStore(storeKey, cfg);
    if (!store) {
      const type = Utils.getEntityType(storeKey);
      store = {
        key:          storeKey,
        type,
        name:         storeKey.replace(/_/g, ' ').toUpperCase(),
        logo:         Utils.DEFAULT_LOGO,
        category:     '',
        description:  '',
        phone:        '',
        website:      '',
        photos:       [],
        hours:        null,
        bases:        [{ offset: { x: 0, z: 0 }, scale: { x: 1, z: 1 } }],
        logoOffset:   { x: 0, z: 0 },
        logoScale:    0.8,
        logoRotation: 0,
        baseHeight:   0.002,
        logoHeight:   0.005,
      };
      if (type === 'fasilitas') {
        store.facilityType  = '';
        store.accessibility = '';
      } else if (type === 'event') {
        store.events        = [];
        store.tenantEmail    = '';
        store.tenantPassword = '';
      } else {
        store.promos      = [];
        store.isEmpty     = false;
        store.tenantEmail    = '';
        store.tenantPassword = '';
      }
      cfg.push(store);
      Utils.saveStoreConfig(cfg);
    } else if (!store.type) {
      // Backfill type for stores created before type field existed
      store.type = Utils.getEntityType(storeKey);
    }
    return store;
  }

  /* ── LOGO MESH ─────────────────────────────────────────── */
  createLogoPlaneMesh(store, center, topY) {
    const mat  = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.userData.type   = 'logo';
    mesh.userData.origin = { x: center.x, z: center.z };
    mesh.name = store.key;

    mesh.position.set(
      center.x + (store.logoOffset?.x || 0),
      topY     + (store.logoHeight   || 0.005),
      center.z + (store.logoOffset?.z || 0),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = THREE.MathUtils.degToRad(store.logoRotation || 0);

    Utils.applyLogoScale(mesh, store.logoScale || 0.8);

    const logoSrc = store.isEmpty ? Utils.RENTAL_LOGO : store.logo;
    mat.map = Utils.getTexture(logoSrc, (tex) => {
      const w = tex.image?.width, h = tex.image?.height;
      if (!w || !h) return;
      mesh.userData.aspect = w / h;
      Utils.applyLogoScale(mesh, store.logoScale || 0.8);
    });
    mat.needsUpdate = true;

    return mesh;
  }

  /* ── BASE MESHES ───────────────────────────────────────── */
  createBaseMeshes(store, storeKey, center, topY, parent = null) {
    const target     = parent || this.scene;
    const storeColor = store.baseColor || this._cachedColor;
    const bases = [];

    (store.bases || [{ offset: { x: 0, z: 0 }, scale: { x: 1, z: 1 } }]).forEach(bc => {
      const mesh = Utils.createBaseMesh(storeKey, storeColor);
      mesh.userData.origin = { x: center.x, z: center.z };

      mesh.position.set(
        center.x + (bc.offset?.x || 0),
        topY     + (bc.height ?? store.baseHeight ?? 0.002),
        center.z + (bc.offset?.z || 0),
      );
      mesh.scale.set(bc.scale?.x || 1, bc.scale?.z || 1, 1);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = THREE.MathUtils.degToRad(store.baseRotation || 0);

      if (bc.baseTexture) {
        mesh.material.map       = Utils.getTexture(bc.baseTexture);
        mesh.material.alphaTest = 0.5;
        mesh.material.needsUpdate = true;
      }

      target.add(mesh);
      this.logos.push(mesh);
      bases.push(mesh);
    });

    return bases;
  }

  registerStoreData(storeKey, logoMesh, baseMeshes) {
    this.storeMeshes[storeKey] = { logo: logoMesh, bases: baseMeshes || [] };
  }

  getStoreData(key) { return this.storeMeshes[key]; }

  /* ── REAL-TIME FORM APPLY ──────────────────────────────── */
  applyLogoForm(storeKey) {
    const mesh = this.storeMeshes[storeKey]?.logo;
    if (!mesh) return;
    const o = mesh.userData.origin;
    mesh.position.x = o.x + Utils.getFormValue('offsetX');
    mesh.position.z = o.z + Utils.getFormValue('offsetZ');
    Utils.applyLogoScale(mesh, Utils.getFormValue('logoScale', 0.8));
    mesh.rotation.z = THREE.MathUtils.degToRad(Utils.getFormValue('logoRotation'));
  }

  applyBaseForm(storeKey) {
    const data = this.storeMeshes[storeKey];
    if (!data) return;
    const bi   = Utils.getFormValue('baseIndex');
    const mesh = data.bases?.[bi];
    if (!mesh) return;
    const o = mesh.userData.origin;
    mesh.position.x = o.x + Utils.getFormValue('baseOffsetX');
    mesh.position.z = o.z + Utils.getFormValue('baseOffsetZ');
    mesh.scale.set(Utils.getFormValue('baseScaleX', 1), Utils.getFormValue('baseScaleZ', 1), 1);
  }

  /* ── SAVE ──────────────────────────────────────────────── */
  saveStoreChanges(storeKey, fd) {
    const cfg   = Utils.getStoreConfig();
    const store = Utils.findStore(storeKey, cfg);
    if (!store) return;

    if (fd.name          !== undefined) store.name          = fd.name        || store.name;
    if (fd.category      !== undefined) store.category      = fd.category;
    if (fd.description   !== undefined) store.description   = fd.description;
    if (fd.phone         !== undefined) store.phone         = fd.phone;
    if (fd.website       !== undefined) store.website       = fd.website;
    if (fd.photos        !== undefined) store.photos        = fd.photos;
    if (fd.hours         !== undefined) store.hours         = fd.hours;
    if (fd.facilityType  !== undefined) store.facilityType  = fd.facilityType;
    if (fd.accessibility !== undefined) store.accessibility = fd.accessibility;
    if (fd.isEmpty       !== undefined) {
      const prev = !!store.isEmpty;
      store.isEmpty = fd.isEmpty;
      if (prev !== !!fd.isEmpty) {
        // Refresh live logo texture to match new state
        const logoMesh = this.storeMeshes[storeKey]?.logo;
        if (logoMesh) {
          const src = store.isEmpty ? Utils.RENTAL_LOGO : store.logo;
          logoMesh.material.map = Utils.getTexture(src, (tex) => {
            const w = tex.image?.width, h = tex.image?.height;
            if (!w || !h) return;
            logoMesh.userData.aspect = w / h;
            Utils.applyLogoScale(logoMesh, store.logoScale || 0.8);
          });
          logoMesh.material.needsUpdate = true;
        }
      }
    }
    if (fd.tenantEmail    !== undefined) store.tenantEmail    = fd.tenantEmail;
    if (fd.tenantPassword !== undefined) store.tenantPassword = fd.tenantPassword;
    if (fd.promos        !== undefined) store.promos        = fd.promos;
    if (fd.events        !== undefined) store.events        = fd.events;
    store.logoOffset   = { x: fd.offsetX, z: fd.offsetZ };
    store.logoScale    = fd.logoScale;
    store.logoRotation = fd.logoRotation;
    if (fd.newLogo) store.logo = fd.newLogo;
    if ('baseColor' in fd) {
      store.baseColor = fd.baseColor || null;
      // Apply color immediately to existing meshes
      const color = store.baseColor || this._cachedColor;
      this.storeMeshes[storeKey]?.bases?.forEach(m => {
        m.material.color.set(color);
        m.material.needsUpdate = true;
      });
    }

    const bi = fd.baseIndex;
    if (store.bases?.[bi]) {
      store.bases[bi].offset = { x: fd.baseOffsetX, z: fd.baseOffsetZ };
      store.bases[bi].scale  = { x: fd.baseScaleX,  z: fd.baseScaleZ  };
      if (fd.baseTexture) store.bases[bi].baseTexture = fd.baseTexture;
    }

    Utils.saveStoreConfig(cfg, store);
    return Utils.findStore(storeKey, cfg); // return saved version
  }

  /* ── ADD / RESET BASES ─────────────────────────────────── */
  _addBaseToScene(storeKey, origin, ref, data, parent = null) {
    const target = parent || ref?.parent || this.scene;
    const mesh = Utils.createBaseMesh(storeKey, this._cachedColor);
    mesh.userData.origin = origin;
    mesh.position.set(origin.x, ref.position.y - 0.03, origin.z);
    mesh.rotation.x = -Math.PI / 2;
    target.add(mesh);
    data.bases.push(mesh);
    this.logos.push(mesh);
    return mesh;
  }

  addBase(storeKey) {
    const cfg   = Utils.getStoreConfig();
    const store = Utils.findStore(storeKey, cfg);
    const data  = this.storeMeshes[storeKey];
    if (!store || !data) return -1;

    store.bases = store.bases || [];
    store.bases.push({ offset: { x: 0, z: 0 }, scale: { x: 1, z: 1 } });

    const ref = data.logo || data.bases[0];
    this._addBaseToScene(storeKey, ref.userData.origin, ref, data, ref?.parent);

    Utils.saveStoreConfig(cfg);
    return store.bases.length - 1;
  }

  resetBases(storeKey) {
    const cfg   = Utils.getStoreConfig();
    const store = Utils.findStore(storeKey, cfg);
    const data  = this.storeMeshes[storeKey];
    if (!store || !data) return;

    data.bases.forEach(m => {
      (m.parent || this.scene).remove(m);
      this.logos = this.logos.filter(l => l !== m);
    });
    data.bases = [];
    store.bases = [{ offset: { x: 0, z: 0 }, scale: { x: 1, z: 1 } }];

    const ref = data.logo;
    this._addBaseToScene(storeKey, ref.userData.origin, ref, data, ref?.parent);

    Utils.saveStoreConfig(cfg);
  }

  /* ── DELETE ────────────────────────────────────────────── */
  // Removes the store config + uploaded assets. Visual meshes (logo + bases) stay
  // until the next reload — they'll regenerate as a fresh empty store from the GLB.
  async deleteStore(storeKey) {
    const cfg  = Utils.getStoreConfig();
    const idx  = cfg.findIndex(s => s.key === storeKey);
    if (idx < 0) return;
    const store = cfg[idx];
    cfg.splice(idx, 1);

    Utils.saveStoreConfig(cfg);

    // Clean up Supabase row + uploaded assets (best-effort, non-blocking)
    try {
      const { deleteStore, deleteAssets, getAssetPath, isConfigured } = await import('./db.js');
      deleteStore(storeKey).catch(() => {});
      if (isConfigured()) {
        const paths = [];
        if (store.logo) { const p = getAssetPath(store.logo); if (p) paths.push(p); }
        (store.photos || []).forEach(ph => { const p = getAssetPath(ph); if (p) paths.push(p); });
        (store.promos || []).forEach(p => { const pp = getAssetPath(p?.image); if (pp) paths.push(pp); });
        (store.events || []).forEach(ev => {
          (ev.photos || []).forEach(ph => { const pp = getAssetPath(ph); if (pp) paths.push(pp); });
          const pp = getAssetPath(ev.image); if (pp) paths.push(pp);
        });
        if (paths.length) deleteAssets(paths).catch(() => {});
      }
    } catch {}
  }

  /* ── FORM LOAD ─────────────────────────────────────────── */
  loadBaseToForm(storeKey) {
    const store = Utils.findStore(storeKey);
    if (!store) return;
    const bi   = Utils.getFormValue('baseIndex');
    const base = store.bases?.[bi];
    if (!base) return;
    Utils.setFormValue('baseOffsetX', base.offset?.x || 0);
    Utils.setFormValue('baseOffsetZ', base.offset?.z || 0);
    Utils.setFormValue('baseScaleX',  base.scale?.x  || 1);
    Utils.setFormValue('baseScaleZ',  base.scale?.z  || 1);
  }

  /* ── ROLLBACK (close without save) ────────────────────── */
  rollbackStore(storeKey, original) {
    const data = this.storeMeshes[storeKey];
    if (!data || !original) return;

    if (data.logo) {
      const mesh = data.logo;
      const o    = mesh.userData.origin;
      mesh.position.x = o.x + (original.logoOffset?.x || 0);
      mesh.position.z = o.z + (original.logoOffset?.z || 0);
      Utils.applyLogoScale(mesh, original.logoScale || 0.8);
      mesh.rotation.z = THREE.MathUtils.degToRad(original.logoRotation || 0);
      mesh.material.map = Utils.getTexture(original.logo);
      mesh.material.needsUpdate = true;
    }

    data.bases?.forEach((mesh, i) => {
      const base = original.bases?.[i];
      if (!mesh || !base) return;
      const o = mesh.userData.origin;
      mesh.position.x = o.x + (base.offset?.x || 0);
      mesh.position.z = o.z + (base.offset?.z || 0);
      mesh.scale.set(base.scale?.x || 1, base.scale?.z || 1, 1);
      mesh.material.color.set(original.baseColor || this._cachedColor);
      mesh.material.needsUpdate = true;
    });
  }

  /* ── UPDATE ALL BASE COLORS ────────────────────────────── */
  updateBaseColors(color) {
    this._cachedColor = color;
    Object.entries(this.storeMeshes).forEach(([key, data]) => {
      const store = Utils.findStore(key);
      if (store?.baseColor) return; // skip stores with custom color
      data.bases?.forEach(m => { m.material.color.set(color); m.material.needsUpdate = true; });
    });
  }
}
