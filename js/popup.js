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
  const type  = store.type || Utils.getEntityType(storeKey);
  _setPopupType(type);
  _showView();
  _renderViewMode(store, storeKey);

  _el('store-popup').classList.remove('hidden');
  _el('sp-popup-overlay').classList.remove('hidden');
}

function _setPopupType(type) {
  const popup = _el('store-popup');
  popup.classList.remove('popup-type-store', 'popup-type-fasilitas', 'popup-type-event');
  popup.classList.add(`popup-type-${type}`);
}

/** True if current viewer can edit this entity. */
function _canEdit(store) {
  if (!!window.__isAdmin) return true;
  const email = window.__tenantEmail;
  if (!email) return false;
  // Store tenant
  if (store?.tenantEmail && email === store.tenantEmail) return true;
  // Event tenant: can open this venue to edit their event
  if (window.__tenantStoreKey != null && window.__tenantEventIdx != null && store?.key === window.__tenantStoreKey) return true;
  return false;
}

/** True if the current edit session is by a tenant (not admin). */
function _isTenantEdit(store) {
  if (window.__isAdmin || !window.__tenantEmail) return false;
  if (store?.tenantEmail && window.__tenantEmail === store.tenantEmail) return true;
  if (window.__tenantStoreKey != null && window.__tenantEventIdx != null && store?.key === window.__tenantStoreKey) return true;
  return false;
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
  const type = store.type || Utils.getEntityType(storeKey);

  // Hero: for event type with a live event having photos, use those; otherwise venue photos
  const liveEv = _liveEventWithPhotos(store);
  _renderHero((liveEv?.photos?.length ? liveEv.photos : store.photos) || []);

  const logoImg = _el('sp-logo-img');
  logoImg.src = store.logo || Utils.DEFAULT_LOGO;
  logoImg.onerror = () => { logoImg.src = Utils.DEFAULT_LOGO; };

  _el('sp-title').textContent = store.name || storeKey.replace(/_/g, ' ').toUpperCase();
  const catEl = _el('sp-category-text');
  catEl.textContent   = store.category || '';
  catEl.style.display = (type === 'store' && store.category) ? '' : 'none';

  // Edit button visibility per-type permission
  const editBtn = _el('sp-edit-btn');
  if (editBtn) {
    editBtn.style.display = _canEdit(store) ? 'flex' : 'none';
    editBtn.onclick = () => _openEditMode(storeKey);
  }

  _renderNavButton(storeKey);

  // Reset all view containers so stale content doesn't leak between popups
  ['sp-status', 'sp-quick', 'sp-infolist', 'sp-promos', 'sp-events-list'].forEach(id => {
    const el = _el(id);
    if (el) { el.innerHTML = ''; el.style.display = ''; }
  });
  _el('sp-infolist')?.classList.remove('is-live-event');

  // Rental banner: always shown for events, only when isEmpty for stores. Never for fasilitas.
  const rentalBanner = _el('sp-rental-banner');
  const navBtn       = _el('sp-nav-btn');
  const showRental   = type === 'event' || (type === 'store' && !!store.isEmpty);
  const hideNav      = type === 'store' && !!store.isEmpty; // empty store has no real destination
  if (showRental) {
    rentalBanner.classList.remove('hidden');
    _setupRentalBanner(store, type);
    // Position: top for store, bottom (after upcoming events) for event
    const view = _el('sp-view');
    if (view) {
      if (type === 'event') {
        view.appendChild(rentalBanner);
      } else {
        // Store: place above nav button (its original spot)
        const nav = _el('sp-nav-btn');
        if (nav && rentalBanner.nextSibling !== nav) view.insertBefore(rentalBanner, nav);
      }
    }
  } else {
    rentalBanner.classList.add('hidden');
  }
  if (navBtn) navBtn.style.display = hideNav ? 'none' : '';

  if (type === 'fasilitas') {
    _renderFasilitasView(store);
  } else if (type === 'event') {
    _renderEventView(store);
  } else if (store.isEmpty) {
    // Empty store — hide hours, status, quick actions, promos
    const statusEl = _el('sp-status');
    const quickEl  = _el('sp-quick');
    if (statusEl) { statusEl.innerHTML = ''; statusEl.style.display = 'none'; }
    if (quickEl)  { quickEl.innerHTML  = ''; quickEl.style.display  = 'none'; }
    _el('sp-infolist').innerHTML = store.description
      ? _infoRow('ℹ️', `<p>${_esc(store.description)}</p>`)
      : '';
  } else {
    _renderStatus(store);
    _renderQuickActions(store);
    _renderInfoList(store);
    _renderPromos(store);
  }
}

function _renderPromos(store) {
  const el = _el('sp-promos');
  if (!el) return;
  const promos = (store.promos || []).filter(p => p && (p.title || p.description));
  if (!promos.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="sp-promos-title">🎁 Promo Berjalan</div>
    ${promos.map(p => `
      <div class="sp-promo-card">
        ${p.image ? `<img class="sp-promo-img" src="${_esc(p.image)}" alt="" onerror="this.style.display='none'"/>` : ''}
        <div class="sp-promo-body">
          ${p.title       ? `<p class="sp-promo-title">${_esc(p.title)}</p>` : ''}
          ${p.description ? `<p class="sp-promo-desc">${_esc(p.description)}</p>` : ''}
          ${p.validUntil  ? `<p class="sp-promo-valid">Berlaku hingga ${_esc(_formatDate(p.validUntil))}</p>` : ''}
        </div>
      </div>
    `).join('')}
  `;
}

function _formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function _setupRentalBanner(store, type) {
  const titleEl  = _el('sp-rental-title');
  const subtitle = _el('sp-rental-subtitle');
  const waBtn    = _el('sp-rental-wa-btn');
  const noWaMsg  = _el('sp-rental-no-wa');
  const wa       = window.__adminWa || '';

  if (type === 'event') {
    if (titleEl)  titleEl.textContent  = 'Sewa Tempat untuk Event';
    if (subtitle) subtitle.textContent = 'Tempat ini bisa disewa untuk event Anda';
  } else {
    if (titleEl)  titleEl.textContent  = 'Tersedia untuk Disewa';
    if (subtitle) subtitle.textContent = 'Hubungi admin untuk informasi sewa toko';
  }

  if (wa) {
    waBtn.classList.remove('hidden');
    waBtn.disabled = false;
    noWaMsg.classList.add('hidden');
    const target = type === 'event' ? 'tempat event' : 'toko';
    const msg = encodeURIComponent(`Halo Admin, saya tertarik untuk menyewa ${target}: ${store.name || store.key}`);
    waBtn.onclick = () => window.open(`https://wa.me/${wa}?text=${msg}`, '_blank', 'noopener');
  } else {
    waBtn.classList.add('hidden');
    noWaMsg.classList.remove('hidden');
  }
}

/* ── FASILITAS VIEW ──────────────────────────────────────── */
const FACILITY_LABELS = {
  entrance:         { label: 'Pintu Masuk',        icon: '🚪' },
  parking:          { label: 'Parkiran',           icon: '🅿️' },
  toilet:           { label: 'Toilet',             icon: '🚻' },
  musholla:         { label: 'Musholla',           icon: '🕌' },
  lift:             { label: 'Lift',               icon: '🛗' },
  escalator:        { label: 'Eskalator',          icon: '🔼' },
  stairs:           { label: 'Tangga',             icon: '🪜' },
  emergency_stairs: { label: 'Tangga Darurat',     icon: '🆘' },
  atm:              { label: 'ATM',                icon: '🏧' },
  info:             { label: 'Customer Service',   icon: 'ℹ️' },
  other:            { label: 'Fasilitas',          icon: '📍' },
};

function _renderFasilitasView(store) {
  const meta = FACILITY_LABELS[store.facilityType] || FACILITY_LABELS.other;
  const badge = _el('sp-facility-badge');
  badge.textContent = `${meta.icon} ${meta.label}`;

  const list = _el('sp-infolist');
  let html = '';
  if (store.description)   html += _infoRow('ℹ️', `<p>${_esc(store.description)}</p>`);
  if (store.accessibility) html += _infoRow('♿', `<p>${_esc(store.accessibility)}</p>`);
  if (!html) html = `<p class="sp-empty-hint">Fasilitas ${meta.label.toLowerCase()}.</p>`;
  list.innerHTML = html;
}

function _renderEventView(store) {
  const events = (store.events || []).filter(e => e && (e.name || e.description));

  // Categorise into live + upcoming
  const now = Date.now();
  const live = [], upcoming = [];
  events.forEach(ev => {
    const start = ev.startDate ? _eventStartTimestamp(ev) : null;
    const end   = ev.endDate   ? _eventEndTimestamp(ev)   : start;
    if (start == null) { upcoming.push(ev); return; }
    if (end != null && end < now) return;
    if (start <= now && (end == null || end >= now)) live.push(ev);
    else upcoming.push(ev);
  });
  upcoming.sort((a, b) => _eventStartTimestamp(a) - _eventStartTimestamp(b));

  const liveEv = live[0]; // primary live event drives the popup chrome

  // Event context bar — visual differentiator from store popup
  _setupEventContextBar(store, liveEv, upcoming);

  // When a live event exists, popup behaves like a store popup using event data:
  // override category text, status (Buka/Tutup based on event date+time), quick actions, info list.
  const titleEl = _el('sp-title');
  const catEl   = _el('sp-category-text');
  if (liveEv) {
    if (titleEl) titleEl.textContent = liveEv.name || (store.name || store.key);
    if (catEl) {
      catEl.textContent   = liveEv.category || '';
      catEl.style.display = liveEv.category ? '' : 'none';
    }
    _renderEventQuickActions(liveEv);
    _renderEventInfoList(liveEv);
  } else {
    // No live event — show venue identity + venue description (or empty hint)
    if (catEl) catEl.style.display = 'none';
    const list = _el('sp-infolist');
    list.innerHTML = store.description
      ? _infoRow('ℹ️', `<p>${_esc(store.description)}</p>`)
      : (upcoming.length
          ? `<p class="sp-empty-hint">Tidak ada event yang sedang berlangsung. Lihat jadwal di bawah.</p>`
          : `<p class="sp-empty-hint">Belum ada event di tempat ini.</p>`);
  }

  // Upcoming events at the bottom
  const eventsEl = _el('sp-events-list');
  if (eventsEl) {
    eventsEl.innerHTML = upcoming.length ? `
      <div class="sp-events-section">
        <div class="sp-events-heading">📅 Jadwal Event Mendatang</div>
        ${upcoming.map(ev => _eventCardHtml(ev, false)).join('')}
      </div>
    ` : '';
  }
}

function _setupEventContextBar(store, liveEv, upcoming) {
  const bar     = _el('sp-event-context');
  const iconEl  = _el('sp-event-context-icon');
  const lineEl  = _el('sp-event-context-line');
  const venueEl = _el('sp-event-context-venue');
  if (!bar) return;
  bar.classList.remove('is-live');

  // When live, the "event sedang berlangsung" header lives inside the infolist
  // card (rendered by _renderEventInfoList). Hide the standalone bar to avoid duplication.
  if (liveEv) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';

  const venueName = store.name || store.key.replace(/_/g, ' ').toUpperCase();
  if (upcoming.length) {
    if (iconEl)  iconEl.textContent  = '📅';
    if (lineEl)  lineEl.textContent  = 'Area Event · Ada jadwal mendatang';
    if (venueEl) venueEl.textContent = venueName;
  } else {
    if (iconEl)  iconEl.textContent  = '🎪';
    if (lineEl)  lineEl.textContent  = 'Area Event';
    if (venueEl) venueEl.textContent = venueName;
  }
}

function _renderEventQuickActions(ev) {
  const el = _el('sp-quick');
  if (!el) return;
  const btns = [];
  if (ev.phone) {
    btns.push(`<a href="tel:${_esc(ev.phone)}" class="sp-qbtn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.35 2 2 0 0 1 3.58 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.72 16z"/></svg>Telepon</a>`);
  }
  if (ev.website) {
    btns.push(`<a href="${_esc(ev.website)}" target="_blank" rel="noopener" class="sp-qbtn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Website</a>`);
  }
  if (ev.organizerPhone) {
    const phone = ev.organizerPhone.replace(/\D/g, '');
    const msg   = encodeURIComponent(`Halo, saya tertarik dengan event ${ev.name || ''}`);
    btns.push(`<a href="https://wa.me/${phone}?text=${msg}" target="_blank" rel="noopener" class="sp-qbtn sp-qbtn--wa"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>WhatsApp</a>`);
  }
  el.innerHTML = btns.join('');
  el.style.display = btns.length ? '' : 'none';
}

function _renderEventInfoList(ev) {
  const el = _el('sp-infolist');
  if (!el) return;
  el.classList.add('is-live-event');

  const dateRange = _formatEventRange(ev);
  let html = `
    <div class="sp-infolist-event-header">
      <span class="sp-infolist-event-icon">🔴</span>
      <div class="sp-infolist-event-text">
        <span class="sp-infolist-event-title">Event sedang berlangsung</span>
        ${dateRange ? `<span class="sp-infolist-event-date">${_esc(dateRange)}</span>` : ''}
      </div>
    </div>
  `;
  if (ev.htm)         html += _infoRow('🎟️', `<p>HTM: <strong>${_esc(ev.htm)}</strong></p>`);
  if (ev.description) html += _infoRow('ℹ️', `<p>${_esc(ev.description)}</p>`);
  if (ev.phone)       html += _infoRow('📞', `<a href="tel:${_esc(ev.phone)}">${_esc(ev.phone)}</a>`);
  if (ev.website)     html += _infoRow('🌐', `<a href="${_esc(ev.website)}" target="_blank" rel="noopener">${_esc(ev.website)}</a>`);
  el.innerHTML = html;
}

function _eventCardHtml(ev, live) {
  const dateStr = _formatEventRange(ev);
  const photo   = (Array.isArray(ev.photos) && ev.photos[0]) || ev.image || '';
  return `
    <div class="sp-event-card${live ? ' sp-event-live' : ''}">
      ${photo ? `<img class="sp-event-img" src="${_esc(photo)}" alt="" onerror="this.style.display='none'"/>` : ''}
      <div class="sp-event-body">
        <p class="sp-event-title">${_esc(ev.name || 'Event')}${live ? '<span class="sp-event-live-badge">LIVE</span>' : ''}</p>
        ${dateStr        ? `<p class="sp-event-date">${dateStr}</p>` : ''}
        ${ev.description ? `<p class="sp-event-desc">${_esc(ev.description)}</p>` : ''}
      </div>
    </div>
  `;
}

function _formatEventRange(ev) {
  if (!ev.startDate) return '';
  const sd = _formatDate(ev.startDate);
  const ed = ev.endDate && ev.endDate !== ev.startDate ? _formatDate(ev.endDate) : '';
  const tRange = (ev.startTime && ev.endTime) ? ` · ${ev.startTime}–${ev.endTime}`
               : ev.startTime                   ? ` · mulai ${ev.startTime}`
               : '';
  return ed ? `${sd} – ${ed}${tRange}` : `${sd}${tRange}`;
}

function _eventStartTimestamp(ev) {
  if (!ev.startDate) return null;
  const t = ev.startTime || '00:00';
  return new Date(`${ev.startDate}T${t}:00`).getTime();
}
function _eventEndTimestamp(ev) {
  const date = ev.endDate || ev.startDate;
  if (!date) return null;
  const t = ev.endTime || '23:59';
  return new Date(`${date}T${t}:00`).getTime();
}

/** Returns the live event whose photos should drive the hero, or null. */
function _liveEventWithPhotos(store) {
  if (store.type !== 'event') return null;
  const now = Date.now();
  return (store.events || []).find(ev => {
    if (!ev || !Array.isArray(ev.photos) || !ev.photos.length) return false;
    const start = _eventStartTimestamp(ev);
    const end   = _eventEndTimestamp(ev);
    return start != null && start <= now && (end == null || end >= now);
  }) || null;
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
  if (!html) html = `<p class="sp-empty-hint">Belum ada informasi.</p>`;
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

function _showToast(msg, isError = false) {
  let el = document.getElementById('sp-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sp-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className   = 'sp-toast' + (isError ? ' sp-toast--error' : '');
  el.classList.add('sp-toast--show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('sp-toast--show'), 3000);
}

/* ── EDIT MODE ───────────────────────────────────────────── */
function _openEditMode(storeKey) {
  const store = Utils.findStore(storeKey);
  if (!store) return;
  _tempEdit = { original: structuredClone(store), photos: [...(store.photos || [])] };

  const type = store.type || Utils.getEntityType(storeKey);
  const titleEl = _el('sp-edit-title');
  const nameLabel = _el('sp-name-label');
  if (type === 'fasilitas') {
    if (titleEl)   titleEl.textContent   = 'Edit Fasilitas';
    if (nameLabel) nameLabel.textContent = 'Nama Fasilitas';
  } else if (type === 'event') {
    if (titleEl)   titleEl.textContent   = 'Edit Event';
    if (nameLabel) nameLabel.textContent = 'Nama Tempat Event';
  } else {
    if (titleEl)   titleEl.textContent   = 'Edit Toko';
    if (nameLabel) nameLabel.textContent = 'Nama Toko';
  }

  const isTenant      = _isTenantEdit(store);
  const isEventTenant = isTenant && type === 'event';
  _el('store-popup').classList.toggle('popup-tenant-mode', isTenant);

  _el('sp-view').classList.add('hidden');
  _el('sp-edit').classList.remove('hidden');
  _el('sp-save-footer').classList.remove('hidden');
  _el('sp-popup-overlay').classList.add('hidden');
  _enableDrag();

  if (isEventTenant) {
    // Init events in tempEdit early (normally done by _loadEventsPanel)
    _tempEdit.events = (store.events || []).map(ev => ({
      ...ev,
      photos: Array.isArray(ev.photos) ? [...ev.photos] : (ev.image ? [ev.image] : []),
    }));
    // Only show Info + Foto tabs
    document.querySelectorAll('#sp-tabs .sp-tab').forEach(t => {
      const hide = t.dataset.tab !== 'info' && t.dataset.tab !== 'photos';
      t.style.display = hide ? 'none' : '';
    });
    _loadEventTenantInfoPanel(window.__tenantEventIdx);
    _loadEventTenantPhotosPanel(window.__tenantEventIdx);
    switchTab('info');
  } else {
    // Restore all tab visibility (in case previously hidden by event tenant)
    document.querySelectorAll('#sp-tabs .sp-tab').forEach(t => t.style.display = '');
    _loadInfoPanel(store, storeKey);
    _loadPhotosPanel(store);
    if (type === 'store') {
      _loadHoursPanel(store);
      _loadPromosPanel(store);
    }
    if (type === 'event') _loadEventsPanel(store);
    _loadModelPanel(storeKey);
    switchTab('info');
  }

  _el('sp-save-btn').onclick = () => _saveEditMode(storeKey);
  _el('sp-back-btn').onclick = _cancelEditMode;
}

async function _deleteEntity(storeKey) {
  const store = Utils.findStore(storeKey);
  const label = store?.name || storeKey;
  if (!confirm(`Hapus data "${label}"?\n\nData (info, foto, promo/event) akan terhapus.\nObjek 3D di peta tetap, dan akan menjadi entri baru saat halaman di-reload.`)) return;

  const delBtn = _el('sp-delete-entity-btn');
  const orig   = delBtn?.innerHTML;
  if (delBtn) { delBtn.disabled = true; delBtn.textContent = 'Menghapus...'; }

  try {
    if (typeof _sm.deleteStore === 'function') {
      await _sm.deleteStore(storeKey);
    }
  } catch (e) {
    console.warn('[popup] delete failed:', e);
  } finally {
    if (delBtn) {
      delBtn.disabled = false;
      delBtn.innerHTML = orig;
    }
  }
  // Bypass rollback — the store no longer exists, _tempEdit.original would re-create it.
  _tempEdit  = null;
  _activeKey = null;
  close();
}

function _cancelEditMode() {
  if (_activeKey && _tempEdit?.original) _sm.rollbackStore(_activeKey, _tempEdit.original);
  _tempEdit = null;
  _disableDrag();
  _el('store-popup').classList.remove('popup-tenant-mode');
  _resetEventTenantPanels();
  document.querySelectorAll('#sp-tabs .sp-tab').forEach(t => t.style.display = '');
  _el('sp-popup-overlay').classList.remove('hidden');
  const store = Utils.findStore(_activeKey);
  if (store) _renderViewMode(store, _activeKey);
  _showView();
}

async function _saveEditMode(storeKey) {
  const saveBtn = _el('sp-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }

  try {
    const storeForType = Utils.findStore(storeKey);
    const editType     = storeForType?.type || Utils.getEntityType(storeKey);
    const fd = {
      name:           _el('sp-name').value.trim(),
      category:       _el('sp-category').value.trim(),
      description:    _el('sp-description').value.trim(),
      phone:          _el('sp-phone').value.trim(),
      website:        _el('sp-website').value.trim(),
      facilityType:   _el('sp-facility-type')?.value || '',
      accessibility:  _el('sp-accessibility')?.value.trim() || '',
      isEmpty:        editType === 'store' ? !!_el('sp-is-empty')?.checked : undefined,
      tenantEmail:    editType === 'store' ? (_el('sp-tenant-email')?.value.trim()    || '') : undefined,
      tenantPassword: editType === 'store' ? (_el('sp-tenant-password')?.value         || '') : undefined,
      photos:         [...(_tempEdit?.photos || [])],
      promos:         editType === 'store' ? [...(_tempEdit?.promos || [])] : undefined,
      events:         editType === 'event' ? [...(_tempEdit?.events || [])] : undefined,
      hours:          editType === 'store' ? _collectHours() : undefined,
      offsetX:        Utils.getFormValue('offsetX'),
      offsetZ:        Utils.getFormValue('offsetZ'),
      logoScale:      Utils.getFormValue('logoScale', 0.8),
      logoRotation:   Utils.getFormValue('logoRotation'),
      logoSaturation: Utils.getFormValue('logoSaturation', 1),
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

      // Promo & event images
      const _uploadEntityImage = async (item, prefix) => {
        if (item?.image?.startsWith('data:')) {
          const url = await uploadAsset(
            _b64ToBlob(item.image, 'image/jpeg'),
            `${prefix}/${safeKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`,
          );
          if (url) item.image = url;
        }
      };
      if (Array.isArray(fd.promos)) {
        for (const p of fd.promos) await _uploadEntityImage(p, 'promos');
        // Queue removed promo images for deletion
        const oldImgs = (original?.promos || []).map(p => p?.image).filter(Boolean);
        const newImgs = fd.promos.map(p => p?.image).filter(Boolean);
        oldImgs.forEach(img => {
          if (!newImgs.includes(img)) {
            const path = getAssetPath(img);
            if (path) toDelete.push(path);
          }
        });
      }
      if (Array.isArray(fd.events)) {
        const collectAllImgs = list => {
          const all = [];
          (list || []).forEach(ev => {
            if (ev?.image) all.push(ev.image);
            (ev?.photos || []).forEach(p => p && all.push(p));
          });
          return all;
        };
        for (const ev of fd.events) {
          await _uploadEntityImage(ev, 'events');
          if (Array.isArray(ev.photos)) {
            const uploaded = [];
            for (const p of ev.photos) {
              if (p?.startsWith('data:')) {
                const url = await uploadAsset(
                  _b64ToBlob(p, 'image/jpeg'),
                  `events/${safeKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`,
                );
                uploaded.push(url || p);
              } else {
                uploaded.push(p);
              }
            }
            ev.photos = uploaded;
          }
        }
        const oldImgs = collectAllImgs(original?.events);
        const newImgs = collectAllImgs(fd.events);
        oldImgs.forEach(img => {
          if (!newImgs.includes(img)) {
            const path = getAssetPath(img);
            if (path) toDelete.push(path);
          }
        });
      }

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

    // Await Supabase sync dan tampilkan hasilnya
    try {
      const { upsertStore, isConfigured } = await import('./db.js');
      if (isConfigured() && saved) await upsertStore(saved);
      _showToast('Perubahan berhasil disimpan');
    } catch (err) {
      console.error('[Supabase] Gagal sync:', err);
      _showToast('Tersimpan lokal · Gagal sync ke server — pastikan sudah login sebagai Admin', true);
    }

    _disableDrag();
    _el('store-popup').classList.remove('popup-tenant-mode');
    _resetEventTenantPanels();
    document.querySelectorAll('#sp-tabs .sp-tab').forEach(t => t.style.display = '');
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

  const facTypeEl = _el('sp-facility-type');
  if (facTypeEl) facTypeEl.value = store.facilityType || '';
  Utils.setFormValue('sp-accessibility', store.accessibility || '');

  // Rental controls (store + event)
  const isEmptyEl     = _el('sp-is-empty');
  const tenantEmailEl = _el('sp-tenant-email');
  const tenantWrap    = _el('sp-tenant-email-wrap');
  if (isEmptyEl)     isEmptyEl.checked  = !!store.isEmpty;
  if (tenantEmailEl) tenantEmailEl.value = store.tenantEmail || '';
  const tenantPassEl = _el('sp-tenant-password');
  if (tenantPassEl)  tenantPassEl.value  = store.tenantPassword || '';
  const delBtn = _el('sp-delete-entity-btn');
  if (delBtn) {
    delBtn.onclick = () => _deleteEntity(storeKey);
  }
  Utils.setFormValue('offsetX',        store.logoOffset?.x ?? 0);
  Utils.setFormValue('offsetZ',        store.logoOffset?.z ?? 0);
  Utils.setFormValue('logoScale',      store.logoScale    ?? 0.8);
  Utils.setFormValue('logoRotation',   store.logoRotation ?? 0);

  ['offsetX','offsetZ','logoScale','logoRotation'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.oninput = () => _sm.applyLogoForm(storeKey);
  });

  const satVal = store.logoSaturation ?? 1;
  const satEl  = _el('logoSaturation');
  const satLbl = _el('logoSaturation-val');
  if (satEl) {
    satEl.value = satVal;
    if (satLbl) satLbl.textContent = satVal.toFixed(2);
    satEl.oninput = () => {
      const v = parseFloat(satEl.value) || 1;
      if (satLbl) satLbl.textContent = v.toFixed(2);
      _sm.applyLogoSaturation(storeKey, v);
    };
  }

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

/* ── PROMOS PANEL ────────────────────────────────────────── */
function _loadPromosPanel(store) {
  if (!_tempEdit) return;
  if (!_tempEdit.promos) _tempEdit.promos = [...(store.promos || [])];
  _renderPromosEditor();
  const addBtn = _el('sp-add-promo-btn');
  if (addBtn) addBtn.onclick = () => {
    _tempEdit.promos.push({ title: '', description: '', validUntil: '', image: '' });
    _renderPromosEditor();
  };
}

function _renderPromosEditor() {
  const wrap = _el('sp-promos-edit');
  if (!wrap) return;
  const items = _tempEdit?.promos || [];
  if (!items.length) { wrap.innerHTML = `<p class="sp-empty-hint">Belum ada promo.</p>`; return; }
  wrap.innerHTML = items.map((p, i) => `
    <div class="sp-list-editor-item" data-idx="${i}">
      <div class="sp-list-editor-row">
        <div class="sp-list-editor-thumb" data-promo-thumb="${i}" style="${p.image ? `background-image:url('${_esc(p.image)}')` : ''}">${p.image ? '' : '+'}</div>
        <div style="flex:1; display:flex; flex-direction:column; gap:6px">
          <input type="text" data-promo-field="title"       data-idx="${i}" placeholder="Judul promo..." value="${_esc(p.title || '')}" />
          <input type="date" data-promo-field="validUntil"  data-idx="${i}" value="${_esc(p.validUntil || '')}" />
          <textarea data-promo-field="description" data-idx="${i}" placeholder="Deskripsi promo...">${_esc(p.description || '')}</textarea>
        </div>
      </div>
      <div class="sp-list-editor-actions">
        <button class="sp-list-editor-del" data-promo-del="${i}" type="button">Hapus</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-promo-field]').forEach(el => {
    el.oninput = () => {
      const idx = +el.dataset.idx;
      const fld = el.dataset.promoField;
      if (_tempEdit.promos[idx]) _tempEdit.promos[idx][fld] = el.value;
    };
  });
  wrap.querySelectorAll('[data-promo-del]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.promoDel;
      _tempEdit.promos.splice(idx, 1);
      _renderPromosEditor();
    };
  });
  wrap.querySelectorAll('[data-promo-thumb]').forEach(thumb => {
    thumb.onclick = () => {
      const idx = +thumb.dataset.promoThumb;
      _pickListImage((b64) => {
        _tempEdit.promos[idx].image = b64;
        _renderPromosEditor();
      });
    };
  });
}

/* ── EVENT TENANT PANELS ─────────────────────────────────── */
function _resetEventTenantPanels() {
  const panel = _el('sp-panel-info');
  if (panel) {
    panel.classList.remove('sp-event-tenant-mode');
    panel.querySelector('.sp-event-tenant-overlay')?.remove();
  }
  const hint = _el('sp-panel-photos')?.querySelector('.sp-hint-text');
  if (hint) hint.textContent = 'Maks. 5 foto · Dikompres otomatis ke JPEG';
}

function _loadEventTenantInfoPanel(eventIdx) {
  const panel = _el('sp-panel-info');
  if (!panel) return;
  panel.classList.add('sp-event-tenant-mode');

  let overlay = panel.querySelector('.sp-event-tenant-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sp-event-tenant-overlay';
    panel.appendChild(overlay);
  }

  const ev = _tempEdit.events?.[eventIdx] || {};
  overlay.innerHTML = `
    <div class="sp-field-full">
      <label>Nama Event</label>
      <input type="text" data-event-field="name" data-idx="${eventIdx}"
        placeholder="Nama event..." value="${_esc(ev.name || '')}" />
    </div>
    <div class="sp-field-full">
      <label>Kategori</label>
      <input type="text" data-event-field="category" data-idx="${eventIdx}"
        placeholder="Konser, Expo, Bazaar..." value="${_esc(ev.category || '')}" />
    </div>
    <div class="sp-field-row">
      <div class="sp-field">
        <label>Tanggal Mulai</label>
        <input type="date" data-event-field="startDate" data-idx="${eventIdx}" value="${_esc(ev.startDate || '')}" />
      </div>
      <div class="sp-field">
        <label>Jam Mulai</label>
        <input type="time" data-event-field="startTime" data-idx="${eventIdx}" value="${_esc(ev.startTime || '')}" />
      </div>
    </div>
    <div class="sp-field-row">
      <div class="sp-field">
        <label>Tanggal Selesai</label>
        <input type="date" data-event-field="endDate" data-idx="${eventIdx}" value="${_esc(ev.endDate || '')}" />
      </div>
      <div class="sp-field">
        <label>Jam Selesai</label>
        <input type="time" data-event-field="endTime" data-idx="${eventIdx}" value="${_esc(ev.endTime || '')}" />
      </div>
    </div>
    <div class="sp-field-full">
      <label>HTM / Tiket</label>
      <input type="text" data-event-field="htm" data-idx="${eventIdx}"
        placeholder="Rp 50.000 / Gratis" value="${_esc(ev.htm || '')}" />
    </div>
    <div class="sp-field-full">
      <label>Deskripsi</label>
      <textarea data-event-field="description" data-idx="${eventIdx}"
        placeholder="Deskripsi singkat event..." rows="4">${_esc(ev.description || '')}</textarea>
    </div>
    <div class="sp-field-row">
      <div class="sp-field">
        <label>Telepon</label>
        <input type="tel" data-event-field="phone" data-idx="${eventIdx}"
          placeholder="08..." value="${_esc(ev.phone || '')}" />
      </div>
      <div class="sp-field">
        <label>Website</label>
        <input type="url" data-event-field="website" data-idx="${eventIdx}"
          placeholder="https://..." value="${_esc(ev.website || '')}" />
      </div>
    </div>
    <div class="sp-field-full">
      <label>No. WA Penyelenggara</label>
      <input type="tel" data-event-field="organizerPhone" data-idx="${eventIdx}"
        placeholder="628..." value="${_esc(ev.organizerPhone || '')}" />
    </div>
  `;

  overlay.querySelectorAll('[data-event-field]').forEach(el => {
    el.oninput = () => {
      const fld = el.dataset.eventField;
      if (_tempEdit.events?.[eventIdx] != null) _tempEdit.events[eventIdx][fld] = el.value;
    };
  });
}

function _loadEventTenantPhotosPanel(eventIdx) {
  const hint = _el('sp-panel-photos')?.querySelector('.sp-hint-text');
  if (hint) hint.textContent = 'Foto event · Maks. 5 foto · Dikompres otomatis ke JPEG';

  const grid       = _el('sp-photo-grid');
  const addBtn     = _el('sp-add-photo-btn');
  const photoInput = _el('sp-photo-input');

  const getPhotos = () => _tempEdit.events?.[eventIdx]?.photos || [];

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = getPhotos().map((src, i) =>
      `<div class="sp-pgrid-item">
        <img src="${src}" class="sp-pgrid-img" />
        <button class="sp-pgrid-del" data-evp-del="${i}">✕</button>
      </div>`
    ).join('');
    grid.querySelectorAll('[data-evp-del]').forEach(btn => {
      btn.onclick = () => {
        const photos = _tempEdit.events?.[eventIdx]?.photos;
        if (photos) { photos.splice(+btn.dataset.evpDel, 1); renderGrid(); }
      };
    });
  }

  renderGrid();

  if (addBtn && photoInput) {
    photoInput.multiple = true;
    photoInput.value    = '';
    addBtn.onclick      = () => photoInput.click();
    photoInput.onchange = async (e) => {
      const files   = Array.from(e.target.files);
      if (!files.length) return;
      const photos    = _tempEdit.events?.[eventIdx]?.photos;
      if (!photos) return;
      const remaining = 5 - photos.length;
      if (remaining <= 0) { alert('Maksimal 5 foto.'); photoInput.value = ''; return; }
      const toAdd = files.slice(0, remaining);
      if (files.length > remaining) alert(`Hanya ${remaining} foto lagi yang bisa ditambahkan.`);
      for (const f of toAdd) photos.push(await _compressImage(f));
      renderGrid();
      photoInput.value = '';
    };
  }
}

/* ── EVENTS PANEL ────────────────────────────────────────── */
function _loadEventsPanel(store) {
  if (!_tempEdit) return;
  if (!_tempEdit.events) {
    // Migrate legacy single `image` → `photos[]`
    _tempEdit.events = (store.events || []).map(ev => ({
      ...ev,
      photos: Array.isArray(ev.photos) ? [...ev.photos] : (ev.image ? [ev.image] : []),
    }));
  }
  _renderEventsEditor();
  const addBtn = _el('sp-add-event-btn');
  if (addBtn) addBtn.onclick = () => {
    _tempEdit.events.push({
      name: '', category: '', startDate: '', endDate: '', startTime: '', endTime: '',
      description: '', phone: '', website: '',
      tenantEmail: '', organizerPhone: '', htm: '', photos: [],
    });
    if (!_tempEdit._eventsExpanded) _tempEdit._eventsExpanded = new Set();
    _tempEdit._eventsExpanded.add(_tempEdit.events.length - 1);
    _renderEventsEditor();
  };
}

function _renderEventsEditor() {
  const wrap = _el('sp-events-edit');
  if (!wrap) return;
  const allItems = _tempEdit?.events || [];

  // Event tenant only sees their own event
  const tenantIdx = window.__tenantEventIdx;
  const isTenantMode = !window.__isAdmin && tenantIdx != null;
  const slots = isTenantMode
    ? allItems.map((ev, i) => ({ ev, i })).filter(({ i }) => i === tenantIdx)
    : allItems.map((ev, i) => ({ ev, i }));

  if (!slots.length) { wrap.innerHTML = `<p class="sp-empty-hint">Belum ada event.</p>`; return; }

  if (!_tempEdit._eventsExpanded) _tempEdit._eventsExpanded = new Set();
  const expanded = _tempEdit._eventsExpanded;

  wrap.innerHTML = slots.map(({ ev, i }) => {
    const isOpen    = expanded.has(i);
    const dateLabel = _formatEventRange(ev) || 'Belum dijadwalkan';
    return `
      <div class="sp-list-editor-item sp-event-edit-item${isOpen ? ' is-expanded' : ''}" data-idx="${i}">
        <div class="sp-event-edit-header" data-event-toggle="${i}">
          <div class="sp-event-edit-summary">
            <span class="sp-event-edit-name">${_esc(ev.name || '(Event tanpa nama)')}</span>
            <span class="sp-event-edit-date">${_esc(dateLabel)}</span>
          </div>
          <span class="sp-event-edit-chevron">${isOpen ? '▾' : '▸'}</span>
        </div>
        ${isOpen ? _eventEditFieldsHtml(ev, i) : ''}
      </div>
    `;
  }).join('');

  // Toggle expand/collapse
  wrap.querySelectorAll('[data-event-toggle]').forEach(el => {
    el.onclick = (e) => {
      // Don't toggle when clicking inputs/buttons inside the body
      if (e.target.closest('input, textarea, button')) return;
      const idx = +el.dataset.eventToggle;
      if (expanded.has(idx)) expanded.delete(idx); else expanded.add(idx);
      _renderEventsEditor();
    };
  });

  wrap.querySelectorAll('[data-event-field]').forEach(el => {
    el.oninput = () => {
      const idx = +el.dataset.idx;
      const fld = el.dataset.eventField;
      if (_tempEdit.events[idx]) _tempEdit.events[idx][fld] = el.value;
    };
  });
  wrap.querySelectorAll('[data-event-del]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.eventDel;
      _tempEdit.events.splice(idx, 1);
      expanded.delete(idx);
      _renderEventsEditor();
    };
  });
  wrap.querySelectorAll('[data-event-photo-add]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.eventPhotoAdd;
      _pickListImage((b64) => {
        if (!_tempEdit.events[idx].photos) _tempEdit.events[idx].photos = [];
        _tempEdit.events[idx].photos.push(b64);
        _renderEventsEditor();
      }, /*multiple*/true);
    };
  });
  wrap.querySelectorAll('[data-event-photo-del]').forEach(btn => {
    btn.onclick = () => {
      const [evIdx, phIdx] = btn.dataset.eventPhotoDel.split('_').map(Number);
      _tempEdit.events[evIdx].photos.splice(phIdx, 1);
      _renderEventsEditor();
    };
  });
}

function _eventEditFieldsHtml(ev, i) {
  return `
    <div class="sp-event-edit-body">
      <input type="text" data-event-field="name"     data-idx="${i}" placeholder="Nama event..." value="${_esc(ev.name || '')}" />
      <input type="text" data-event-field="category" data-idx="${i}" placeholder="Kategori (Konser, Expo, Bazaar...)" value="${_esc(ev.category || '')}" />
      <div style="display:flex; gap:6px">
        <input type="date" data-event-field="startDate" data-idx="${i}" value="${_esc(ev.startDate || '')}" style="flex:1" title="Tanggal mulai" />
        <input type="time" data-event-field="startTime" data-idx="${i}" value="${_esc(ev.startTime || '')}" style="flex:1" title="Jam mulai" />
      </div>
      <div style="display:flex; gap:6px">
        <input type="date" data-event-field="endDate"   data-idx="${i}" value="${_esc(ev.endDate || '')}"   style="flex:1" title="Tanggal selesai" />
        <input type="time" data-event-field="endTime"   data-idx="${i}" value="${_esc(ev.endTime || '')}"   style="flex:1" title="Jam selesai" />
      </div>
      <input type="text" data-event-field="htm"      data-idx="${i}" placeholder="HTM (mis. Rp 50.000 / Gratis)" value="${_esc(ev.htm || '')}" />
      <textarea          data-event-field="description" data-idx="${i}" placeholder="Deskripsi event...">${_esc(ev.description || '')}</textarea>
      <input type="tel"   data-event-field="phone"   data-idx="${i}" placeholder="Telepon kontak event" value="${_esc(ev.phone || '')}" />
      <input type="url"   data-event-field="website" data-idx="${i}" placeholder="Website event (https://...)" value="${_esc(ev.website || '')}" />
      <input type="tel"   data-event-field="organizerPhone" data-idx="${i}" placeholder="No. WA penyelenggara (628...)" value="${_esc(ev.organizerPhone || '')}" />
      <div class="admin-edit-only" style="display:contents">
        <input type="email" data-event-field="tenantEmail"    data-idx="${i}" placeholder="Email pengelola event..." value="${_esc(ev.tenantEmail || '')}" />
        <input type="text"  data-event-field="tenantPassword" data-idx="${i}" placeholder="Password pengelola event..." value="${_esc(ev.tenantPassword || '')}" autocomplete="off" />
        <p class="field-hint" style="margin:0 0 4px">Admin isi email + password agar pengelola bisa login dan edit event ini.</p>
      </div>

      <div class="sp-event-photos-row">
        <span class="sp-event-photos-label">Foto event:</span>
        <div class="sp-event-photos-grid" data-event-photos="${i}">
          ${(ev.photos || []).map((src, pi) => `
            <div class="sp-event-photo-thumb" style="background-image:url('${_esc(src)}')">
              <button type="button" class="sp-event-photo-del" data-event-photo-del="${i}_${pi}" title="Hapus foto">×</button>
            </div>
          `).join('')}
          <button type="button" class="sp-event-photo-add" data-event-photo-add="${i}" title="Tambah foto">+</button>
        </div>
      </div>

      <div class="sp-list-editor-actions admin-edit-only">
        <button class="sp-list-editor-del" data-event-del="${i}" type="button">Hapus Event</button>
      </div>
    </div>
  `;
}

function _pickListImage(onPicked, multiple = false) {
  const inp = document.createElement('input');
  inp.type     = 'file';
  inp.accept   = 'image/*';
  inp.multiple = !!multiple;
  inp.onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (multiple) {
      for (const f of files) {
        const b64 = await _compressImage(f, 700);
        onPicked(b64);
      }
    } else {
      const b64 = await _compressImage(files[0], 600);
      onPicked(b64);
    }
  };
  inp.click();
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
        m.material.color.set(colorEl.value);
        m.material.needsUpdate = true;
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
    m.material.color.set(defaultColor);
    m.material.needsUpdate = true;
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
