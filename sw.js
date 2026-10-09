/* Who Chop My Data? service worker.
 * 1. Offline app shell: the game opens instantly and works with no network.
 * 2. Background sync: uploads the IndexedDB outbox even if the tab was closed.
 * Updates never reload the game under the player; the page offers "Update ready" at the menu.
 * BUILD is stamped by scripts/stamp.py so every deploy gets a new cache and an update. */
const BUILD = 'c9b86d48c128';
const SHELL = 'wcmd-shell-' + BUILD;
const DATA = 'wcmd-data';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('wcmd-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });

async function shell(e) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match('index.html');
  const net = fetch(e.request).then((res) => { if (res.ok) cache.put('index.html', res.clone()); return res; }).catch(() => null);
  if (hit) { try { e.waitUntil(net); } catch (_) {} return hit; }
  return (await net) || new Response('Offline. Open the game once with data to install it.', { status: 503 });
}

async function networkFirst(req, name, ms) {
  const cache = await caches.open(name);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req)) || new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  }
}

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.includes('/api/v1/')) {
    if (u.pathname.endsWith('/boards')) e.respondWith(networkFirst(r, DATA, 4000));
    return; // sync, recover, delete: always straight to the network
  }
  if (r.mode === 'navigate') return e.respondWith(shell(e));
  e.respondWith(caches.match(r).then((hit) => hit || fetch(r)));
});

/* ---- IndexedDB (same schema as the page) ---- */
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('wcmd', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    if (!d.objectStoreNames.contains('ob')) d.createObjectStore('ob', { keyPath: 'q' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (db, st, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(st, mode), out = fn(t.objectStore(st));
  t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
  t.onerror = t.onabort = () => rej(t.error);
});

/* Upload pending operations. The page creates the player identity; this only flushes. */
async function flush() {
  const db = await idb();
  const meta = await tx(db, 'kv', 'readonly', (s) => s.get('meta'));
  if (!meta || !meta.token) return;
  const all = (await tx(db, 'ob', 'readonly', (s) => s.getAll())).sort((a, b) => a.q - b.q);
  if (!all.length) return;
  const ops = all.slice(0, 60);
  const body = JSON.stringify({ dev: meta.dev, ops: ops.map((o) => ({ id: o.id, t: o.t, ts: o.ts, d: o.d })) });
  const r = await fetch((meta.api || '/api/v1') + '/sync', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + meta.token },
  });
  if (r.status === 401) return; // the page will re-register
  if (!r.ok) throw new Error('http ' + r.status); // rejecting makes the browser retry with backoff
  const j = await r.json();
  const acked = ops.filter((o) => j.results[o.id] !== undefined).map((o) => o.q);
  const prev = await tx(db, 'kv', 'readonly', (s) => s.get('srvseq'));
  await tx(db, 'ob', 'readwrite', (s) => { acked.forEach((q) => s.delete(q)); });
  if (prev == null || j.seq >= prev) await tx(db, 'kv', 'readwrite', (s) => { s.put(j.profile, 'srv'); s.put(j.seq, 'srvseq'); });
  for (const c of await self.clients.matchAll()) c.postMessage({ t: 'synced' });
  if (all.length > ops.length) await flush();
}

self.addEventListener('sync', (e) => { if (e.tag === 'wcmd-sync') e.waitUntil(flush()); });
