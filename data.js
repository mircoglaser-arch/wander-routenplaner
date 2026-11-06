/* Wander-Routenplaner – Wegenetz in Kacheln: vorbereitete Daten (GitHub), Gerätespeicher, Overpass als Rückfall */
(function (root) {
  'use strict';
  const TLAT = 0.1, TLON = 0.15;          // ca. 11 × 10,5 km pro Kachel
  const STATIC = 'https://raw.githubusercontent.com/mircoglaser-arch/wander-routenplaner/data/';
  const DBN = 'wander-routenplaner', ST = 'tiles';
  const REGION = [49.9, 6.0, 51.5, 8.7];   // Köln, Bergisches Land, Eifel, Sauerland, Siebengebirge, Mosel, Rhein
  const SERVERS = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  const mem = new Map();
  let dbp = null, idxp = null;

  /* ---------- Gerätespeicher ---------- */
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(res => {
      try {
        const r = indexedDB.open(DBN, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(ST);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  const req = (fn, fallback) => db().then(d => d ? new Promise(res => {
    try { const r = fn(d); r.onsuccess = () => res(r.result); r.onerror = () => res(fallback); } catch (e) { res(fallback); }
  }) : fallback);
  async function get(k) {
    if (mem.has(k)) return mem.get(k);
    const v = await req(d => d.transaction(ST).objectStore(ST).get(k), null);
    if (v) mem.set(k, v);
    return v || null;
  }
  async function put(k, v) { mem.set(k, v); await req(d => d.transaction(ST, 'readwrite').objectStore(ST).put(v, k), null); }
  async function storedKeys() { const k = await req(d => d.transaction(ST).objectStore(ST).getAllKeys(), null); return k || [...mem.keys()]; }
  async function clear() { mem.clear(); await req(d => d.transaction(ST, 'readwrite').objectStore(ST).clear(), null); }

  /* ---------- Kachelraster ---------- */
  const key = (i, j) => i + '_' + j;
  const tileOf = ll => [Math.floor(ll[0] / TLAT), Math.floor(ll[1] / TLON)];
  const bbox = k => { const [i, j] = k.split('_').map(Number); return [i * TLAT, j * TLON, (i + 1) * TLAT, (j + 1) * TLON]; };
  function distToBox(ll, b) {
    const la = Math.max(b[0], Math.min(b[2], ll[0])), lo = Math.max(b[1], Math.min(b[3], ll[1]));
    return WK.hav(ll, [la, lo]);
  }
  function tilesCircle(c, r) {
    const dLat = r / 111000, dLon = r / (111000 * Math.cos(c[0] * Math.PI / 180));
    const [i0, j0] = tileOf([c[0] - dLat, c[1] - dLon]), [i1, j1] = tileOf([c[0] + dLat, c[1] + dLon]);
    const out = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (distToBox(c, bbox(k)) <= r) out.push(k); }
    return out;
  }
  function tilesCorridor(a, b, buf) {
    const d = WK.hav(a, b); const n = Math.max(1, Math.ceil(d / 4000)); const set = new Set();
    for (let s = 0; s <= n; s++) {
      const t = s / n; const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const k of tilesCircle(p, buf)) set.add(k);
    }
    return [...set];
  }
  function tilesRegion() {
    const [i0, j0] = tileOf([REGION[0], REGION[1]]), [i1, j1] = tileOf([REGION[2] - 1e-9, REGION[3] - 1e-9]);
    const out = []; for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(key(i, j));
    return out;
  }

  /* ---------- Vorbereitete Daten ---------- */
  function index() {
    if (idxp) return idxp;
    idxp = (async () => {
      try {
        const r = await fetch(STATIC + 'index.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        const ix = await r.json();
        const info = {};
        for (const [name, keys] of Object.entries(ix.sets || {})) {
          const set = new Set(keys); let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
          for (const k of keys) { const [i, j] = k.split('_').map(Number); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
          info[name] = { set, i0, i1, j0, j1 };
        }
        const ixd = { gen: ix.generated, sets: info };
        await put('meta:index', ixd);
        return ixd;
      } catch (e) {
        const old = await get('meta:index');   // offline: zuletzt bekannter Stand
        return old || null;
      }
    })();
    return idxp;
  }
  // 'have' = Datei vorhanden, 'empty' = im abgedeckten Gebiet ohne Wanderwege, 'outside' = nicht abgedeckt
  function coverage(ix, set, k) {
    const s = ix && ix.sets[set]; if (!s) return 'outside';
    if (s.set.has(k)) return 'have';
    const [i, j] = k.split('_').map(Number);
    return (i > s.i0 && i < s.i1 && j > s.j0 && j < s.j1) ? 'empty' : 'outside';
  }
  async function gunzipJSON(resp) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip');
    const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  async function fetchStatic(set, k) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`${STATIC}${set}/${k}.json.gz`);
        if (r.status === 404) return { rels: [], ways: [] };
        if (!r.ok) throw new Error(r.status);
        return await gunzipJSON(r);
      } catch (e) { if (a === 2) throw e; await new Promise(s => setTimeout(s, 800 * (a + 1))); }
    }
  }

  /* ---------- Overpass (außerhalb des aufbereiteten Gebiets) ---------- */
  let rot = 0;
  async function fetchOverpass(set, k) {
    const b = bbox(k).map(x => x.toFixed(4)).join(',');
    const net = set === 'long' ? '["network"~"^(rwn|nwn|iwn)$"]' : '';
    const q = `[out:json][timeout:90];relation["route"~"^(hiking|foot)$"]${net}(${b})->.r;.r out body;way(r.r)(${b});out skel geom qt;`;
    const ctls = [];
    const one = async (n) => {
      const si = (rot + n) % SERVERS.length;
      const ctl = new AbortController(); ctls.push(ctl);
      const t = setTimeout(() => ctl.abort(), 95000);
      try {
        const r = await fetch(SERVERS[si], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark)) throw new Error(j.remark);
        rot = si; return j;
      } finally { clearTimeout(t); }
    };
    const j = await new Promise((resolve, reject) => {
      let started = 0, failed = 0, done = false, timer = null;
      const launch = () => {
        if (done || started >= SERVERS.length + 1) return;
        const n = started++;
        one(n).then(v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
          .catch(() => { failed++; if (failed >= started && started >= SERVERS.length + 1) { done = true; reject(new Error('tile')); } else if (!done) { clearTimeout(timer); launch(); } });
        timer = setTimeout(launch, 25000);
      };
      launch();
    });
    ctls.forEach(c => { try { c.abort(); } catch (e) { } });
    return WK.compactFromOverpass(j);
  }

  /* ---------- Laden ---------- */
  // set: 'all' (alle markierten Wege) oder 'long' (Fern- und Regionalwege)
  async function load(keys, set, onProgress, isCancelled) {
    const ix = await index();
    const gen = ix ? ix.gen : 'overpass';
    const parts = []; let done = 0, cached = 0, failed = 0, slow = 0;
    const todo = [];
    for (const k of keys) {
      const cov = coverage(ix, set, k);
      if (cov === 'empty') { done++; continue; }
      const v = await get(`${set}:${k}`);
      if (v && (v.gen === gen || cov === 'outside')) { parts.push(v); cached++; done++; continue; }
      todo.push({ k, cov });
      if (cov === 'outside') slow++;
    }
    const report = () => onProgress && onProgress({ done, total: keys.length, cached, failed, slow });
    report();
    let idx = 0;
    const worker = async (lane) => {
      while (idx < todo.length) {
        if (isCancelled && isCancelled()) return;
        const { k, cov } = todo[idx++];
        try {
          const d = cov === 'have' ? await fetchStatic(set, k) : await fetchOverpass(set, k);
          const v = { gen: cov === 'have' ? gen : 'overpass', ts: Date.now(), rels: d.rels, ways: d.ways.map(w => ({ id: w.id, routes: w.routes, c: Float32Array.from(w.c), j: Float64Array.from(w.j) })) };
          await put(`${set}:${k}`, v); parts.push(v);
        } catch (e) { failed++; }
        done++; report();
      }
    };
    // Vorbereitete Kacheln kommen vom CDN: mehrere gleichzeitig; Overpass schonen
    const lanes = todo.some(t => t.cov === 'outside') ? 2 : 6;
    await Promise.all(Array.from({ length: lanes }, (_, i) => worker(i)));
    return { parts, failed, cached, source: ix ? 'static' : 'overpass' };
  }

  root.Tiles = { tilesCircle, tilesCorridor, tilesRegion, load, index, storedKeys, clear, REGION };
})(typeof globalThis !== 'undefined' ? globalThis : this);
