import * as Utils from './utils.js';

const SLIDE_EASE = 'transform 0.38s cubic-bezier(0.25,0.46,0.45,0.94)';

const DAYS = [
  { key: 'min', label: 'Minggu' },
  { key: 'sen', label: 'Senin'  },
  { key: 'sel', label: 'Selasa' },
  { key: 'rab', label: 'Rabu'   },
  { key: 'kam', label: 'Kamis'  },
  { key: 'jum', label: 'Jumat'  },
  { key: 'sab', label: 'Sabtu'  },
];
const DEFAULT_DAY_HOURS = { open: '09:00', close: '21:00', closed: false };

let _sm          = null;   // storeManager reference
let _activeKey   = null;
let _tempEdit    = null;
let _dragCleanup = null;

/* ── PUBLIC API ──────────────────────────────────────────── */
export function init(storeManager) {
  _sm = storeManager;
  window.closeStorePopup   = close;
  window.switchTab         = switchTab;
  window.deletePhoto       = deletePhoto;
  window.spAddBase         = spAddBase;
  window.spResetBases      = spResetBases;
  window.spResetBaseColor  = spResetBaseColor;
}

export function open(storeKey) {
  _disableDrag();
  _resetPopupPosition();
  _activeKey = storeKey;
  _tempEdit  = null;

  const store = Utils.findStore(storeKey) || _sm.getOrCreateStore(storeKey);
  _showView();
  _renderViewMode(store, storeKey);

  _el('store-popup').classList.remove('hidden');
  _el('sp-popup-overlay').classList.remove('hidden');
}

export function isOpen() { return _activeKey !== null; }

export function close() {
  if (_activeKey && _tempEdit?.original) _sm.rollbackStore(_activeKey, _tempEdit.original);
  _activeKey = null;
  _tempEdit  = null;
  _disableDrag();

  _el('sp-lightbox')?.classList.add('hidden');
  _el('sp-popup-overlay').classList.add('hidden');

  const popup = _el('store-popup');
  if (popup.classList.contains('hidden') || popup.dataset.closing) return;

  popup.dataset.closing     = '1';
  popup.style.pointerEvents = 'none';
  popup.style.transition    = 'opacity 0.25s ease, transform 0.25s ease';
  popup.style.opacity       = '0';
  // slide down from current position — if dragged use translateY only, else keep horizontal centering
  popup.style.transform = popup.style.left
    ? 'translateY(40px)'
    : 'translateX(-50%) translateY(40px)';

  setTimeout(() => {
    delete popup.dataset.closing;
    popup.style.pointerEvents = '';
    popup.style.transition    = '';
    popup.style.opacity       = '';
    popup.style.transform     = '';
    popup.classList.add('hidden');
    _el('sp-save-footer').classList.add('hidden');
    _resetPopupPosition();
  }, 260);
}

/* ── HELPERS ─────────────────────────────────────────────── */
const _el = (id) => document.getElementById(id);

function _slideTransition(container, incoming, dir, onDone) {
  const current = container.querySelector('.sp-slide, .sp-lb-slide');
  incoming.style.transform = `translateX(${dir > 0 ? '100%' : '-100%'})`;
  container.insertBefore(incoming, container.firstChild);
  incoming.offsetWidth; // force reflow
  incoming.style.transition = SLIDE_EASE;
  incoming.style.transform  = 'translateX(0)';
  if (current) {
    current.style.transition = SLIDE_EASE;
    current.style.transform  = `translateX(${dir > 0 ? '-100%' : '100%'})`;
  }
  setTimeout(() => { current?.remove(); onDone?.(); }, 390);
}

/* ── DRAG (edit mode only) ───────────────────────────────── */
function _enableDrag() {
  const popup  = _el('store-popup');
  const handle = popup.querySelector('.sp-edit-topbar');

  // Convert CSS bottom/transform anchor to explicit top+left so we can drag
  const r = popup.getBoundingClientRect();
  popup.style.bottom    = 'auto';
  popup.style.top       = r.top  + 'px';
  popup.style.left      = r.left + 'px';
  popup.style.transform = 'none';
  handle.classList.add('sp-draggable');

  let ox = 0, oy = 0;

  const onDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, textarea, select, label')) return;
    const pr = popup.getBoundingClientRect();
    ox = e.clientX - pr.left;
    oy = e.clientY - pr.top;
    handle.classList.add('sp-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup',   onUp, { once: true });
    e.preventDefault();
  };

  const onMove = (e) => {
    popup.style.left = (e.clientX - ox) + 'px';
    popup.style.top  = (e.clientY - oy) + 'px';
  };

  const onUp = () => {
    handle.classList.remove('sp-dragging');
    document.removeEventListener('pointermove', onMove);
  };

  handle.addEventListener('pointerdown', onDown);
  _dragCleanup = () => {
    handle.removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointermove', onMove);
    handle.classList.remove('sp-draggable', 'sp-dragging');
    // position stays — reset happens in close() / open()
  };
}

function _disableDrag() {
  if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
}

function _resetPopupPosition() {
  const popup = _el('store-popup');
  popup.style.bottom    = '';
  popup.style.top       = '';
  popup.style.left      = '';
  popup.style.transform = '';
}

/* ── VIEW ────────────────────────────────────────────────── */
function _showView() {
  _el('sp-view').classList.remove('hidden');
  _el('sp-edit').classList.add('hidden');
  _el('sp-save-footer').classList.add('hidden');
}

function _renderViewMode(store, storeKey) {
  _renderHero(store.photos || []);

  const logoImg = _el('sp-logo-img');
  logoImg.src = store.logo || Utils.DEFAULT_LOGO;
  logoImg.onerror = () => { logoImg.src = Utils.DEFAULT_LOGO; };

  _el('sp-title').textContent = store.name || storeKey.replace(/_/g, ' ').toUpperCase();
  const catEl = _el('sp-category-text');
  catEl.textContent   = store.category || '';
  catEl.style.display = store.category ? '' : 'none';

  _renderStatus(store);
  _renderQuickActions(store);
  _renderInfoList(store);

  _el('sp-edit-btn').onclick = () => _openEditMode(storeKey);
  _renderNavButton(storeKey);
}

function _renderNavButton(storeKey) {
  const el = _el('sp-nav-btn');
  if (el) el.onclick = () => window.startNavigation?.(storeKey);
}

function _renderHero(photos) {
  const hero = _el('sp-hero');
  hero.querySelectorAll('.sp-hero-nav, .sp-photo-counter, .sp-slide').forEach(el => el.remove());

  if (!photos.length) {
    hero.classList.add('sp-hero--empty');
    hero.style.cursor = '';
    hero.onclick = null;
    return;
  }

  hero.classList.remove('sp-hero--empty');
  let idx = 0;
  let animating = false;

  hero.insertBefore(_createSlide(photos[0]), hero.firstChild);

  if (photos.length > 1) {
    const counter = document.createElement('div');
    counter.className = 'sp-photo-counter';
    counter.textContent = `1 / ${photos.length}`;

    const goTo = (dir) => {
      if (animating) return;
      animating = true;
      const newIdx = (idx + dir + photos.length) % photos.length;
      _slideTransition(hero, _createSlide(photos[newIdx]), dir, () => { animating = false; });
      idx = newIdx;
      counter.textContent = `${idx + 1} / ${photos.length}`;
    };

    const prev = document.createElement('button');
    prev.className = 'sp-hero-nav sp-hero-nav--prev';
    prev.innerHTML = '&#8249;';
    prev.onclick = (e) => { e.stopPropagation(); goTo(-1); };

    const next = document.createElement('button');
    next.className = 'sp-hero-nav sp-hero-nav--next';
    next.innerHTML = '&#8250;';
    next.onclick = (e) => { e.stopPropagation(); goTo(1); };

    hero.append(prev, next, counter);
  }

  hero.style.cursor = 'zoom-in';
  hero.onclick = (e) => {
    if (e.target.closest('.sp-hero-nav, .sp-close-btn')) return;
    _openLightbox(photos, idx);
  };
}

function _createSlide(src) {
  const div = document.createElement('div');
  div.className = 'sp-slide';
  div.style.backgroundImage = `url('${src}')`;
  return div;
}

function _openLightbox(photos, startIdx) {
  if (!photos.length) return;
  let idx = startIdx;
  let animating = false;

  let lb = _el('sp-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'sp-lightbox';
    document.body.appendChild(lb);
  }
  lb.innerHTML = '';
  lb.classList.remove('hidden');

  const stage = document.createElement('div');
  stage.className = 'sp-lb-stage';

  const createLbSlide = (src) => {
    const div = document.createElement('div');
    div.className = 'sp-lb-slide';
    const img = document.createElement('img');
    img.src = src;
    img.className = 'sp-lb-img';
    div.appendChild(img);
    return div;
  };

  stage.appendChild(createLbSlide(photos[idx]));
  lb.appendChild(stage);

  let counterEl = null;
  if (photos.length > 1) {
    counterEl = document.createElement('div');
    counterEl.className = 'sp-lb-counter';
    counterEl.textContent = `${idx + 1} / ${photos.length}`;
    lb.appendChild(counterEl);
  }

  const closeLb = () => {
    lb.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  };

  const lbGoTo = (dir) => {
    if (animating || photos.length <= 1) return;
    animating = true;
    const newIdx = (idx + dir + photos.length) % photos.length;
    _slideTransition(stage, createLbSlide(photos[newIdx]), dir, () => { animating = false; });
    idx = newIdx;
    if (counterEl) counterEl.textContent = `${idx + 1} / ${photos.length}`;
  };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'sp-lb-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = (e) => { e.stopPropagation(); closeLb(); };
  lb.appendChild(closeBtn);

  if (photos.length > 1) {
    const prev = document.createElement('button');
    prev.className = 'sp-lb-nav sp-lb-nav--prev';
    prev.innerHTML = '&#8249;';
    prev.onclick = (e) => { e.stopPropagation(); lbGoTo(-1); };

    const next = document.createElement('button');
    next.className = 'sp-lb-nav sp-lb-nav--next';
    next.innerHTML = '&#8250;';
    next.onclick = (e) => { e.stopPropagation(); lbGoTo(1); };

    lb.append(prev, next);
  }

  lb.onclick = (e) => { if (!e.target.closest('.sp-lb-nav, .sp-lb-close')) closeLb(); };

  const onKey = (e) => {
    if (e.key === 'Escape')     closeLb();
    if (e.key === 'ArrowLeft')  lbGoTo(-1);
    if (e.key === 'ArrowRight') lbGoTo(1);
  };
  document.addEventListener('keydown', onKey);
}

function _renderStatus(store) {
  const el = _el('sp-status');
  if (!store.hours) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const s = _getOpenStatus(store);
  el.innerHTML = `<span class="sp-badge sp-badge--${s.isOpen ? 'open' : 'closed'}">${s.isOpen ? 'Buka' : 'Tutup'}</span><span class="sp-status-detail">${_esc(s.label)}</span>`;
}

function _renderQuickActions(store) {
  const el = _el('sp-quick');
  const btns = [];
  if (store.phone)   btns.push(`<a href="tel:${_esc(store.phone)}" class="sp-qbtn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.35 2 2 0 0 1 3.58 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.72 16z"/></svg>Telepon</a>`);
  if (store.website) btns.push(`<a href="${_esc(store.website)}" target="_blank" rel="noopener" class="sp-qbtn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Website</a>`);
  el.innerHTML = btns.join('');
  el.style.display = btns.length ? '' : 'none';
}

function _renderInfoList(store) {
  const el = _el('sp-infolist');
  let html = '';
  if (store.description) html += _infoRow('ℹ️', `<p>${_esc(store.description)}</p>`);
  if (store.phone)        html += _infoRow('📞', `<a href="tel:${_esc(store.phone)}">${_esc(store.phone)}</a>`);
  if (store.website)      html += _infoRow('🌐', `<a href="${_esc(store.website)}" target="_blank" rel="noopener">${_esc(store.website)}</a>`);
  if (store.hours)        html += _buildHoursAccordion(store.hours);
  if (!html) html = `<p class="sp-empty-hint">Belum ada informasi. Klik <b>Edit</b> untuk menambahkan.</p>`;
  el.innerHTML = html;
}

function _infoRow(icon, content) {
  return `<div class="sp-infoitem"><span class="sp-infoitem-icon">${icon}</span><div class="sp-infoitem-body">${content}</div></div>`;
}

function _buildHoursAccordion(hours) {
  const todayIdx = new Date().getDay();
  const rows = DAYS.map((d, i) => {
    const h = hours[d.key] || DEFAULT_DAY_HOURS;
    const timeStr = h.closed ? '<span class="sp-closed-txt">Tutup</span>' : `${h.open} – ${h.close}`;
    return `<div class="sp-hours-row${i === todayIdx ? ' sp-hours-row--today' : ''}"><span>${d.label}</span><span>${timeStr}</span></div>`;
  }).join('');
  return `<details class="sp-hours-accordion"><summary><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Jam Operasional<svg class="sp-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></summary><div class="sp-hours-table">${rows}</div></details>`;
}

function _getOpenStatus(store) {
  const now = new Date();
  const h   = store.hours?.[DAYS[now.getDay()].key];
  if (!h || h.closed) return { isOpen: false, label: 'Tutup hari ini' };
  const cur  = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = (h.open  || '00:00').split(':').map(Number);
  const [ch, cm] = (h.close || '00:00').split(':').map(Number);
  if (cur < oh * 60 + om) return { isOpen: false, label: `Buka pukul ${h.open}` };
  if (cur < ch * 60 + cm) return { isOpen: true,  label: `Tutup pukul ${h.close}` };
  return { isOpen: false, label: 'Sudah tutup' };
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── EDIT MODE ───────────────────────────────────────────── */
function _openEditMode(storeKey) {
  const store = Utils.findStore(storeKey);
  if (!store) return;
  _tempEdit = { original: structuredClone(store), photos: [...(store.photos || [])] };

  _el('sp-view').classList.add('hidden');
  _el('sp-edit').classList.remove('hidden');
  _el('sp-save-footer').classList.remove('hidden');
  _el('sp-popup-overlay').classList.add('hidden');
  _enableDrag();

  _loadInfoPanel(store, storeKey);
  _loadPhotosPanel(store);
  _loadHoursPanel(store);
  _loadModelPanel(storeKey);
  switchTab('info');

  _el('sp-save-btn').onclick = () => _saveEditMode(storeKey);
  _el('sp-back-btn').onclick = _cancelEditMode;
}

function _cancelEditMode() {
  if (_activeKey && _tempEdit?.original) _sm.rollbackStore(_activeKey, _tempEdit.original);
  _tempEdit = null;
  _disableDrag();
  _el('sp-popup-overlay').classList.remove('hidden');
  const store = Utils.findStore(_activeKey);
  if (store) _renderViewMode(store, _activeKey);
  _showView();
}

async function _saveEditMode(storeKey) {
  const saveBtn = _el('sp-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }

  try {
    const fd = {
      name:         _el('sp-name').value.trim(),
      category:     _el('sp-category').value.trim(),
      description:  _el('sp-description').value.trim(),
      phone:        _el('sp-phone').value.trim(),
      website:      _el('sp-website').value.trim(),
      photos:       [...(_tempEdit?.photos || [])],
      hours:        _collectHours(),
      offsetX:      Utils.getFormValue('offsetX'),
      offsetZ:      Utils.getFormValue('offsetZ'),
      logoScale:    Utils.getFormValue('logoScale', 0.8),
      logoRotation: Utils.getFormValue('logoRotation'),
      baseOffsetX:  Utils.getFormValue('baseOffsetX'),
      baseOffsetZ:  Utils.getFormValue('baseOffsetZ'),
      baseScaleX:   Utils.getFormValue('baseScaleX', 1),
      baseScaleZ:   Utils.getFormValue('baseScaleZ', 1),
      baseIndex:    Utils.getFormValue('baseIndex'),
      ...(_tempEdit?.newLogo     ? { newLogo:     _tempEdit.newLogo     } : {}),
      ...(_tempEdit?.baseTexture ? { baseTexture: _tempEdit.baseTexture, baseIndex: _tempEdit.baseIndex } : {}),
      ...('baseColor' in (_tempEdit || {}) ? { baseColor: _tempEdit.baseColor } : {}),
    };

    // Upload data: URLs to Supabase Storage (if configured)
    const { isConfigured, uploadAsset, deleteAssets, getAssetPath } = await import('./db.js');
    if (isConfigured()) {
      const original = _tempEdit?.original;
      const toDelete = [];
      const safeKey  = storeKey.replace(/[^a-z0-9_-]/gi, '_');

      // Logo
      if (fd.newLogo?.startsWith('data:')) {
        const ext  = fd.newLogo.includes('image/png') ? 'png' : 'jpg';
        const url  = await uploadAsset(_b64ToBlob(fd.newLogo), `logos/${safeKey}_${Date.now()}.${ext}`);
        if (url) {
          const oldPath = getAssetPath(original?.logo);
          if (oldPath) toDelete.push(oldPath);
          fd.newLogo = url;
        }
      }

      // Photos — upload any new data: entries, keep existing URLs as-is
      const uploadedPhotos = [];
      for (const photo of fd.photos) {
        if (photo.startsWith('data:')) {
          const url = await uploadAsset(
            _b64ToBlob(photo, 'image/jpeg'),
            `photos/${safeKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`,
          );
          uploadedPhotos.push(url || photo);
        } else {
          uploadedPhotos.push(photo);
        }
      }
      // Queue Supabase photos that the user deleted
      for (const p of (original?.photos || [])) {
        if (!uploadedPhotos.includes(p)) {
          const path = getAssetPath(p);
          if (path) toDelete.push(path);
        }
      }
      fd.photos = uploadedPhotos;

      // Base texture
      if (fd.baseTexture?.startsWith('data:')) {
        const ext = fd.baseTexture.includes('image/png') ? 'png' : 'jpg';
        const url = await uploadAsset(_b64ToBlob(fd.baseTexture), `textures/${safeKey}_${Date.now()}.${ext}`);
        if (url) fd.baseTexture = url;
      }

      if (toDelete.length) deleteAssets(toDelete).catch(() => {});
    }

    const saved = _sm.saveStoreChanges(storeKey, fd);
    if (saved) {
      _tempEdit = { original: structuredClone(saved), photos: [...(saved.photos || [])] };
      _renderViewMode(saved, storeKey);
    }
    _disableDrag();
    _el('sp-popup-overlay').classList.remove('hidden');
    _showView();
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
  }
}

/** Convert a base64 data URL to a Blob. */
function _b64ToBlob(b64, fallbackType = 'image/jpeg') {
  const parts = b64.split(',');
  const mime  = parts[0].match(/:(.*?);/)?.[1] || fallbackType;
  const raw   = atob(parts[1]);
  const u8    = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

/** Extract storage path from a Supabase public URL, or null. */
function _getStoragePath(url) {
  const marker = '/object/public/store-assets/';
  const idx = url?.indexOf(marker) ?? -1;
  return idx >= 0 ? decodeURIComponent(url.slice(idx + marker.length)) : null;
}

/* ── TABS ────────────────────────────────────────────────── */
export function switchTab(name) {
  document.querySelectorAll('#sp-tabs .sp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.sp-panel').forEach(p  => p.classList.toggle('hidden', p.id !== `sp-panel-${name}`));
}

document.querySelectorAll('#sp-tabs .sp-tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ── INFO PANEL ──────────────────────────────────────────── */
function _loadInfoPanel(store, storeKey) {
  Utils.setFormValue('sp-name',        store.name        || '');
  Utils.setFormValue('sp-category',    store.category    || '');
  _el('sp-description').value = store.description || '';
  Utils.setFormValue('sp-phone',       store.phone       || '');
  Utils.setFormValue('sp-website',     store.website     || '');
  Utils.setFormValue('offsetX',        store.logoOffset?.x ?? 0);
  Utils.setFormValue('offsetZ',        store.logoOffset?.z ?? 0);
  Utils.setFormValue('logoScale',      store.logoScale    ?? 0.8);
  Utils.setFormValue('logoRotation',   store.logoRotation ?? 0);

  ['offsetX','offsetZ','logoScale','logoRotation'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.oninput = () => _sm.applyLogoForm(storeKey);
  });

  _el('sp-change-logo-btn').onclick = () => _el('sp-logo-input').click();
  const logoInput = _el('sp-logo-input');
  logoInput.value = '';
  logoInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const b64 = ev.target.result;
      _el('sp-logo-img').src = b64;
      const data = _sm.getStoreData(storeKey);
      if (data?.logo) {
        data.logo.material.map = Utils.getTexture(b64, (tex) => {
          data.logo.userData.aspect = tex.image.width / tex.image.height;
          Utils.applyLogoScale(data.logo, Utils.getFormValue('logoScale', 0.8));
        });
        data.logo.material.needsUpdate = true;
      }
      _tempEdit = _tempEdit || {};
      _tempEdit.newLogo = b64;
    };
    reader.readAsDataURL(file);
  };
}

/* ── PHOTOS PANEL ────────────────────────────────────────── */
function _loadPhotosPanel(store) {
  _renderPhotoGrid(_tempEdit?.photos || store.photos || []);
  const addBtn     = _el('sp-add-photo-btn');
  const photoInput = _el('sp-photo-input');
  addBtn.onclick   = () => photoInput.click();
  photoInput.multiple = true;
  photoInput.value = '';
  photoInput.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const photos    = _tempEdit?.photos || [];
    const remaining = 5 - photos.length;
    if (remaining <= 0) { alert('Maksimal 5 foto.'); photoInput.value = ''; return; }
    const toAdd = files.slice(0, remaining);
    if (files.length > remaining) alert(`Hanya ${remaining} foto lagi yang bisa ditambahkan (maks. 5).`);
    for (const file of toAdd) photos.push(await _compressImage(file));
    if (_tempEdit) _tempEdit.photos = photos;
    _renderPhotoGrid(photos);
    photoInput.value = '';
  };
}

function _renderPhotoGrid(photos) {
  _el('sp-photo-grid').innerHTML = photos.map((src, i) =>
    `<div class="sp-pgrid-item"><img src="${src}" class="sp-pgrid-img" /><button class="sp-pgrid-del" onclick="deletePhoto(${i})">✕</button></div>`
  ).join('');
}

function deletePhoto(idx) {
  if (!_tempEdit?.photos) return;
  _tempEdit.photos.splice(idx, 1);
  _renderPhotoGrid(_tempEdit.photos);
}

async function _compressImage(file, maxW = 900) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ratio  = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width  = img.width  * ratio;
        canvas.height = img.height * ratio;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ── HOURS PANEL ─────────────────────────────────────────── */
function _loadHoursPanel(store) {
  const hours = store.hours || {};
  _el('sp-hours-edit').innerHTML = DAYS.map(d => {
    const h = hours[d.key] || { ...DEFAULT_DAY_HOURS };
    return `<div class="sp-hours-edit-row" data-day="${d.key}">
      <div class="sp-hours-day-label">
        <span>${d.label}</span>
        <label class="sp-toggle-mini" title="${h.closed ? 'Buka' : 'Tutup hari ini'}">
          <input type="checkbox" class="sp-day-closed" ${h.closed ? 'checked' : ''} />
          <span class="sp-toggle-mini-track"></span>
        </label>
      </div>
      <div class="sp-hours-times${h.closed ? ' hidden' : ''}">
        <input type="time" class="sp-time-input sp-open-time"  value="${h.open  || '09:00'}" />
        <span class="sp-time-sep">–</span>
        <input type="time" class="sp-time-input sp-close-time" value="${h.close || '21:00'}" />
      </div>
      <p class="sp-day-closed-label${h.closed ? '' : ' hidden'}">Tutup</p>
    </div>`;
  }).join('');

  document.querySelectorAll('.sp-day-closed').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = cb.closest('.sp-hours-edit-row');
      row.querySelector('.sp-hours-times').classList.toggle('hidden', cb.checked);
      row.querySelector('.sp-day-closed-label').classList.toggle('hidden', !cb.checked);
    });
  });
}

function _collectHours() {
  const result = {};
  document.querySelectorAll('.sp-hours-edit-row').forEach(row => {
    result[row.dataset.day] = {
      open:   row.querySelector('.sp-open-time').value  || '09:00',
      close:  row.querySelector('.sp-close-time').value || '21:00',
      closed: row.querySelector('.sp-day-closed').checked,
    };
  });
  return result;
}

/* ── MODEL PANEL ─────────────────────────────────────────── */
function _loadModelPanel(storeKey) {
  Utils.setFormValue('baseIndex', 0);
  _sm.loadBaseToForm(storeKey);
  _updateBaseIndexLimit(storeKey);

  ['baseOffsetX','baseOffsetZ','baseScaleX','baseScaleZ'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.oninput = () => _sm.applyBaseForm(storeKey);
  });
  const biEl = _el('baseIndex');
  if (biEl) biEl.onchange = () => _sm.loadBaseToForm(storeKey);

  const btEl = _el('sp-base-texture-input');
  if (btEl) {
    btEl.value = '';
    btEl.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const b64  = ev.target.result;
        const bi   = Utils.getFormValue('baseIndex');
        const mesh = _sm.getStoreData(storeKey)?.bases?.[bi];
        if (!mesh) return;
        mesh.material.map       = Utils.getTexture(b64);
        mesh.material.alphaTest = 0.5;
        mesh.material.needsUpdate = true;
        _tempEdit = _tempEdit || {};
        _tempEdit.baseTexture = b64;
        _tempEdit.baseIndex   = bi;
      };
      reader.readAsDataURL(file);
    };
  }

  // Base color picker
  const store    = Utils.findStore(storeKey);
  const colorEl  = _el('sp-base-color');
  if (colorEl) {
    colorEl.value = store?.baseColor || _sm._cachedColor;
    _updateBaseColorLabel(!!store?.baseColor);
    colorEl.oninput = () => {
      _tempEdit = _tempEdit || {};
      _tempEdit.baseColor = colorEl.value;
      _updateBaseColorLabel(true);
      _sm.getStoreData(storeKey)?.bases?.forEach(m => {
        if (!m.material.map) m.material.color.set(colorEl.value);
      });
    };
  }
}

function _updateBaseColorLabel(isCustom) {
  const lbl = _el('sp-base-color-label');
  if (lbl) lbl.textContent = isCustom ? 'Custom' : 'Mengikuti default';
}

function spResetBaseColor() {
  if (!_activeKey) return;
  _tempEdit = _tempEdit || {};
  _tempEdit.baseColor = null;
  const defaultColor = _sm._cachedColor;
  const colorEl = _el('sp-base-color');
  if (colorEl) colorEl.value = defaultColor;
  _updateBaseColorLabel(false);
  _sm.getStoreData(_activeKey)?.bases?.forEach(m => {
    if (!m.material.map) m.material.color.set(defaultColor);
  });
}

function _updateBaseIndexLimit(storeKey) {
  const data = _sm.getStoreData(storeKey);
  const inp  = _el('baseIndex');
  if (inp && data) inp.max = Math.max(0, (data.bases?.length || 1) - 1);
}

function spAddBase() {
  if (!_activeKey) return;
  const idx = _sm.addBase(_activeKey);
  Utils.setFormValue('baseIndex', idx);
  _updateBaseIndexLimit(_activeKey);
  _sm.loadBaseToForm(_activeKey);
}

function spResetBases() {
  if (!_activeKey) return;
  _sm.resetBases(_activeKey);
  Utils.setFormValue('baseIndex', 0);
  _updateBaseIndexLimit(_activeKey);
  _sm.loadBaseToForm(_activeKey);
}
