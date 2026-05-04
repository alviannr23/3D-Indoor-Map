/* ══════════════════════════════════════════════════════════
   db.js — Supabase client + helpers
   Isi SUPABASE_URL dan SUPABASE_KEY dari:
   Dashboard → Settings → API
   ══════════════════════════════════════════════════════════ */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://wjozhvkwcuxyjygdcwth.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indqb3podmt3Y3V4eWp5Z2Rjd3RoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3OTkwNjcsImV4cCI6MjA5MzM3NTA2N30.TsDjGGojjozheT6qxQJ5k2uS8HsYM0BspwPm8wXE8ww';

/* Supabase hanya dibuat jika credentials sudah diisi */
let supabase = null;
try {
  if (!SUPABASE_URL.startsWith('YOUR') && !SUPABASE_KEY.startsWith('YOUR')) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
} catch (e) {
  console.warn('[db] Supabase init gagal:', e);
}

export const isConfigured = () => supabase !== null;

/* ── Store Config ─────────────────────────────────────────── */

export async function fetchStores() {
  if (!supabase) return null;
  const { data, error } = await supabase.from('stores').select('key, data');
  if (error) { console.warn('[db] fetchStores:', error.message); return null; }
  return data.map(row => ({ ...row.data, key: row.key }));
}

export async function upsertStores(stores) {
  if (!supabase || !stores?.length) return;
  const rows = stores.map(s => ({ key: s.key, data: s }));
  const { error } = await supabase.from('stores').upsert(rows, { onConflict: 'key' });
  if (error) console.warn('[db] upsertStores:', error.message);
}

export async function upsertStore(store) {
  if (!supabase || !store?.key) return;
  const { error } = await supabase
    .from('stores')
    .upsert({ key: store.key, data: store }, { onConflict: 'key' });
  if (error) console.warn('[db] upsertStore:', error.message);
}

/* ── Map Config ───────────────────────────────────────────── */

export async function fetchMapConfig() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('map_config').select('data').eq('id', 1).maybeSingle();
  if (error) { console.warn('[db] fetchMapConfig:', error.message); return null; }
  return data?.data ?? null;
}

export async function saveMapConfig(config) {
  if (!supabase) return;
  const { error } = await supabase
    .from('map_config')
    .upsert({ id: 1, data: config }, { onConflict: 'id' });
  if (error) console.warn('[db] saveMapConfig:', error.message);
}

/* ── Storage ──────────────────────────────────────────────── */
const BUCKET = 'store-assets';

/**
 * Upload a Blob/File to Supabase Storage.
 * Returns the public URL, or null on failure.
 */
export async function uploadAsset(blob, storagePath) {
  if (!supabase) return null;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, blob, { upsert: true, contentType: blob.type || 'application/octet-stream' });
  if (error) { console.warn('[db] uploadAsset:', error.message); return null; }
  return supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

/** Delete one or more files from Storage (best-effort). */
export async function deleteAssets(storagePaths) {
  if (!supabase || !storagePaths?.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(storagePaths);
  if (error) console.warn('[db] deleteAssets:', error.message);
}

/** Extract the storage path from a Supabase public URL, or null if not a storage URL. */
export function getAssetPath(publicUrl) {  // (alias kept for popup.js)
  if (!publicUrl) return null;
  const marker = `/object/public/${BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  return idx >= 0 ? decodeURIComponent(publicUrl.slice(idx + marker.length)) : null;
}

/* ── Auth ─────────────────────────────────────────────────── */

export async function signIn(email, password) {
  if (!supabase) return { user: null, error: 'Supabase tidak dikonfigurasi' };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { user: data?.user ?? null, error: error?.message ?? null };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function getUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}

/* ── Nav Graph ────────────────────────────────────────────── */

export async function fetchNavGraph(floorKey) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('nav_graphs').select('*').eq('floor_key', floorKey).maybeSingle();
  if (error) { console.warn('[db] fetchNavGraph:', error.message); return null; }
  return data;
}

export async function saveNavGraph(floorKey, nodes, edges, nextId) {
  if (!supabase) return;
  const { error } = await supabase.from('nav_graphs').upsert(
    { floor_key: floorKey, nodes, edges, next_id: nextId },
    { onConflict: 'floor_key' },
  );
  if (error) console.warn('[db] saveNavGraph:', error.message);
}
