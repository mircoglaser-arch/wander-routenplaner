/* Wander-Routenplaner – Wegenetz in Kacheln: vorbereitete Daten (GitHub), Gerätespeicher, Overpass als Rückfall */
(function (root) {
  'use strict';
  const TLAT = 0.1, TLON = 0.15;          // ca. 11 × 10,5 km pro Kachel
  const STATIC = 'https://raw.githubusercontent.com/mircoglaser-arch/wander-routenplaner/data/';
  const DBN = 'wander-routenplaner-6', ST = 'tiles';
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
        const r = await fetch(STATIC + 'index.json?t=' + Math.floor(Date.now() / 60000), { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        const ix = await r.json();
        const info = {};
        for (const [name, keys] of Object.entries(ix.sets || {})) {
          const set = new Set(keys); let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
          for (const k of keys) { const [i, j] = k.split('_').map(Number); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
          info[name] = { set, i0, i1, j0, j1 };
        }
        const ixd = { gen: ix.generated, sets: info, cover: ix.cover ? new Set(ix.cover) : null };
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
    if (ix.cover) return ix.cover.has(k) ? 'empty' : 'outside';
    const [i, j] = k.split('_').map(Number);
    return (i > s.i0 && i < s.i1 && j > s.j0 && j < s.j1) ? 'empty' : 'outside';
  }
  async function gunzipJSON(resp) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip');
    const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  async function fetchStatic(set, k, gen) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`${STATIC}${set}/${k}.json.gz?g=${encodeURIComponent(gen || '')}`);
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

  // Verbindungswege kommen kompakt (ganzzahlige Differenzen in 1e-5 Grad) und ohne Routen
  function decodeWay(w) {
    let c;
    if (w.q) {
      c = new Float32Array(w.q.length); let la = 0, lo = 0;
      for (let i = 0; i < w.q.length; i += 2) { la += w.q[i]; lo += w.q[i + 1]; c[i] = la / 1e5; c[i + 1] = lo / 1e5; }
    } else c = Float32Array.from(w.c);
    return { id: w.id, routes: w.routes || [], c, j: Float64Array.from(w.j), s: w.s || 0, f: w.f == null ? -1 : w.f, k: w.q ? 1 : 0 };
  }

  /* ---------- Laden ---------- */
  // set: 'all' (alle markierten Wege) oder 'long' (Fern- und Regionalwege)
  async function load(keys, set, onProgress, isCancelled) {
    const ix = await index();
    const gen = ix ? ix.gen : 'overpass';
    // Verbindungswege gibt es nur aus den vorbereiteten Daten (Deutschland), nicht über Overpass
    if (set === 'conn') {
      if (!ix || !ix.sets.conn) return { parts: [], failed: 0, cached: 0, source: 'none' };
      keys = keys.filter(k => coverage(ix, set, k) !== 'outside');
    }
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
    const fetchOne = async ({ k, cov }) => {
      try {
        const d = cov === 'have' ? await fetchStatic(set, k, gen) : await fetchOverpass(set, k);
        // Nur Kacheln speichern, die zum aktuellen Datenstand passen (CDN kann kurz Altes liefern)
        const fresh = cov !== 'have' || !d.gen || d.gen === gen;
        const v = { gen: cov === 'have' ? (fresh ? gen : 'stale') : 'overpass', ts: Date.now(), rels: d.rels, ways: d.ways.map(decodeWay) };
        if (fresh) await put(`${set}:${k}`, v); else mem.set(`${set}:${k}`, v);
        parts.push(v);
        return true;
      } catch (e) { return false; }
    };
    const pool = (list, lanes, onFail, stop) => {
      let i = 0;
      const w = async () => {
        while (i < list.length) {
          if ((isCancelled && isCancelled()) || (stop && stop())) return;
          const t = list[i++];
          if (!(await fetchOne(t))) onFail();
          done++; report();
        }
      };
      return Promise.all(Array.from({ length: lanes }, w));
    };
    const stat = todo.filter(t => t.cov === 'have'), out = todo.filter(t => t.cov !== 'have');
    // Vorbereitete Kacheln vom CDN: viele gleichzeitig. Kacheln außerhalb Deutschlands über Overpass:
    // höchstens 2 gleichzeitig und – wenn es vorbereitete Daten gibt – nur so lange, wie die Zeit reicht.
    const budget = ix ? 8000 : Infinity; const t0 = Date.now();
    let expired = false;
    const outP = pool(out, 2, () => { if (!ix) failed++; }, () => expired);
    await pool(stat, 12, () => { failed++; });
    if (out.length) {
      const left = budget - (Date.now() - t0);
      if (left === Infinity) await outP;
      else await Promise.race([outP, new Promise(r => setTimeout(r, Math.max(0, left)))]);
      expired = true;   // laufende Abfragen dürfen fertig werden und landen für das nächste Mal im Speicher
    }
    return { parts: parts.slice(), failed, cached, source: ix ? 'static' : 'overpass' };
  }

  root.Tiles = { tilesCircle, tilesCorridor, tilesRegion, load, index, storedKeys, clear, REGION };
})(typeof globalThis !== 'undefined' ? globalThis : this);
