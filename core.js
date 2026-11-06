/* Wander-Routenplaner – Routing-Kern: Wegenetz aus OSM-Wanderrouten, Rundweg-Suche, Abschnitte */
(function (root) {
  'use strict';

  const R_EARTH = 6371008.8;
  const toRad = d => d * Math.PI / 180;

  function hav(a, b) {
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  const NET_RANK = { iwn: 4, nwn: 3, rwn: 2, lwn: 1 };
  const CONN_FACTOR = 1.6;   // ausgeschilderte Wege klar bevorzugen; Verbindungswege nur bei deutlicher Abkürzung
  const NET_FACTOR = { iwn: 0.85, nwn: 0.85, rwn: 0.92, lwn: 1 };
  const NET_LABEL = { iwn: 'Internationaler Weg', nwn: 'Fernwanderweg', rwn: 'Regionaler Weg', lwn: 'Lokaler Weg' };

  /* ---------- Kompaktformat ----------
     { rels: [{id, tags}], ways: [{id, routes:[relId], c:[lat,lon,...], j:[idx,nodeId,...]}] }
     j enthält nur Knoten, an denen der Weg geteilt wird (Kreuzungen und Enden). */
  const KEEP_TAGS = ['name', 'name:de', 'ref', 'network', 'osmc:symbol', 'colour', 'operator', 'from', 'to', 'distance', 'website', 'symbol'];

  function compactFromOverpass(osm) {
    const rels = [], wayRels = new Map(), ways = [];
    for (const el of osm.elements || []) {
      if (el.type !== 'relation') continue;
      const t = {}; const src = el.tags || {};
      for (const k of KEEP_TAGS) if (src[k] != null) t[k] = src[k];
      rels.push({ id: el.id, tags: t });
      for (const m of el.members || []) {
        if (m.type !== 'way') continue;
        let a = wayRels.get(m.ref); if (!a) wayRels.set(m.ref, a = []);
        if (!a.includes(el.id)) a.push(el.id);
      }
    }
    const use = new Map();
    const raw = [];
    for (const el of osm.elements || []) {
      if (el.type !== 'way' || !el.nodes || !el.geometry) continue;
      if (!wayRels.has(el.id)) continue;
      if (el.geometry.some(g => !g || g.lat == null)) continue;
      raw.push(el);
      const n = el.nodes;
      for (let i = 0; i < n.length; i++) use.set(n[i], (use.get(n[i]) || 0) + ((i === 0 || i === n.length - 1) ? 2 : 1));
    }
    for (const el of raw) {
      const n = el.nodes, c = new Array(n.length * 2), j = [];
      for (let i = 0; i < n.length; i++) {
        c[2 * i] = +el.geometry[i].lat.toFixed(6); c[2 * i + 1] = +el.geometry[i].lon.toFixed(6);
        if (i === 0 || i === n.length - 1 || use.get(n[i]) > 1) j.push(i, n[i]);
      }
      ways.push({ id: el.id, routes: wayRels.get(el.id), c, j, s: 0, f: -1 });
    }
    return { rels, ways };
  }

  // Führt mehrere Kompaktpakete zusammen (gleiche Wege aus Nachbarkacheln: Teilungspunkte vereinigen)
  function mergeCompact(parts) {
    const rels = new Map(), ways = new Map();
    for (const p of parts) {
      for (const r of p.rels) if (!rels.has(r.id)) rels.set(r.id, r.tags);
      for (const w of p.ways) {
        const old = ways.get(w.id);
        if (!old) { ways.set(w.id, { id: w.id, routes: (w.routes || []).slice(), c: w.c, j: w.j, s: w.s || 0, f: w.f == null ? -1 : w.f, k: w.k || 0 }); continue; }
        if (!old.s && w.s) old.s = w.s; if (old.f < 0 && w.f >= 0) old.f = w.f;
        for (const r of (w.routes || [])) if (!old.routes.includes(r)) old.routes.push(r);
        if (old.routes.length) old.k = 0;
        const m = new Map();
        for (let k = 0; k < old.j.length; k += 2) m.set(old.j[k], old.j[k + 1]);
        for (let k = 0; k < w.j.length; k += 2) m.set(w.j[k], w.j[k + 1]);
        old.j = [...m.entries()].sort((a, b) => a[0] - b[0]).flat();
      }
    }
    return { rels, ways: [...ways.values()] };
  }

  /* ---------- Graph ---------- */
  function buildGraph(input) {
    const data = input.elements ? mergeCompact([compactFromOverpass(input)]) : (input.rels instanceof Map ? input : mergeCompact([input]));
    const rels = new Map();
    for (const [id, tags] of data.rels) rels.set(id, { id, tags });
    const nodeIdx = new Map(); const nodeCoord = [];
    const getNode = (id, c) => { let i = nodeIdx.get(id); if (i === undefined) { i = nodeCoord.length; nodeIdx.set(id, i); nodeCoord.push(c); } return i; };
    const edges = []; const wayList = [];
    for (const w of data.ways) {
      const routes = (w.routes || []).filter(r => rels.has(r));
      const conn = !routes.length;   // unmarkierter Verbindungsweg
      if ((conn && !w.k) || w.j.length < 4) continue;
      let net = conn ? CONN_FACTOR : 1;
      for (const r of routes) net = Math.min(net, NET_FACTOR[rels.get(r).tags.network] || 1);
      const wi = wayList.length; wayList.push({ id: w.id, routes, c: w.c });
      const sc = w.s || 0, fs = w.f == null ? -1 : w.f;
      const c = w.c;
      for (let k = 2; k < w.j.length; k += 2) {
        const i0 = w.j[k - 2], i1 = w.j[k];
        let len = 0;
        for (let i = i0 + 1; i <= i1; i++) len += hav([c[2 * i - 2], c[2 * i - 1]], [c[2 * i], c[2 * i + 1]]);
        if (len <= 0.5) continue;
        const a = getNode(w.j[k - 1], [c[2 * i0], c[2 * i0 + 1]]);
        const b = getNode(w.j[k + 1], [c[2 * i1], c[2 * i1 + 1]]);
        if (a === b && len <= 20) continue;
        edges.push({ a, b, len, base: len * net, w: len * net, routes, wi, i0, i1, s: sc, f: fs, conn });
      }
    }
    const n = nodeCoord.length;
    const adj = Array.from({ length: n }, () => []);
    edges.forEach((e, i) => { adj[e.a].push(i); if (e.b !== e.a) adj[e.b].push(i); });
    const comp = new Int32Array(n).fill(-1); const compLen = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1 || !adj[s].length) continue;
      const cc = compLen.length; compLen.push(0);
      const stack = [s]; comp[s] = cc;
      while (stack.length) {
        const u = stack.pop();
        for (const ei of adj[u]) { const e = edges[ei]; const v = e.a === u ? e.b : e.a; if (comp[v] === -1) { comp[v] = cc; stack.push(v); } }
      }
    }
    for (const e of edges) compLen[comp[e.a]] += e.len;
    return { rels, edges, adj, nodeCoord, n, comp, compLen, wayList };
  }

  // Gewichtung: Naturwege und Wald bevorzugen, Asphalt meiden
  function setWeights(G, nature) {
    for (const e of G.edges) {
      let m = 1;
      if (nature) {
        m = ({ 1: 0.86, 3: 0.9, 4: 0.96, 2: 1.35 })[e.s] || 1.05;
        if (e.f >= 0) m *= 1 - 0.15 * e.f / 100;
      }
      e.w = e.base * m;
    }
    G.nature = !!nature;
  }

  // Wegbeschaffenheit: 1 Pfad, 3 Wald-/Feldweg, 4 Schotterweg, 2 Asphalt/Pflaster, 0 unbekannt
  const SURF = { 1: 'pfad', 3: 'waldweg', 4: 'schotter', 2: 'asphalt', 0: 'unbekannt' };
  const edgeClass = e => SURF[e.s] || 'unbekannt';
  function routeStats(G, steps) {
    const st = { pfad: 0, waldweg: 0, schotter: 0, asphalt: 0, unbekannt: 0, total: 0, forestAny: 0, hasForestData: false, conn: 0 };
    for (const x of steps) {
      const e = G.edges[x.e];
      st.total += e.len;
      if (e.f >= 0) { st.forestAny += e.len * e.f / 100; st.hasForestData = true; }
      st[edgeClass(e)] += e.len;
      if (e.conn) st.conn += e.len;
    }
    // Kompatibilität für die Bewertung
    st.paved = st.asphalt; st.unpaved = st.pfad + st.waldweg + st.schotter; st.unknown = st.unbekannt;
    return st;
  }
  // Abschnitte gleicher Art (Wald, unbefestigt, befestigt, unbekannt) für die Darstellung
  function classRuns(G, steps) {
    const runs = [];
    for (const x of steps) {
      const e = G.edges[x.e]; const cls = edgeClass(e), conn = !!e.conn;
      let c = edgeCoords(G, e); if (!x.fwd) c.reverse();
      const last = runs[runs.length - 1];
      if (last && last.cls === cls && last.conn === conn) { for (let i = 1; i < c.length; i++) last.coords.push(c[i]); }
      else runs.push({ cls, conn, coords: c });
    }
    return runs;
  }

  function edgeCoords(G, e) {
    const c = G.wayList[e.wi].c; const out = [];
    for (let i = e.i0; i <= e.i1; i++) out.push([c[2 * i], c[2 * i + 1]]);
    return out;
  }
  function wayCoords(w) { const out = []; for (let i = 0; i < w.c.length; i += 2) out.push([w.c[i], w.c[i + 1]]); return out; }

  /* ---------- Binärer Heap ---------- */
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1; if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v; const rk = k[0], rv = v[0];
      const lk = k.pop(), lv = v.pop(); const n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      this.lastKey = rk; return rv;
    }
  }

  function dijkstra(G, src, wfn, maxCost, target) {
    const dist = new Float64Array(G.n).fill(Infinity);
    const prev = new Int32Array(G.n).fill(-1);
    dist[src] = 0;
    const h = new Heap(); h.push(0, src);
    while (h.size) {
      const u = h.pop(); const c = h.lastKey;
      if (c > dist[u]) continue;
      if (u === target) break;
      if (c > maxCost) break;
      for (const ei of G.adj[u]) {
        const e = G.edges[ei]; const v = e.a === u ? e.b : e.a;
        const nc = c + wfn(ei);
        if (nc < dist[v]) { dist[v] = nc; prev[v] = ei; h.push(nc, v); }
      }
    }
    return { dist, prev, src };
  }

  function pathTo(G, res, dst) {
    if (!isFinite(res.dist[dst])) return null;
    const steps = []; let v = dst; let guard = 0;
    while (v !== res.src) {
      const ei = res.prev[v]; if (ei < 0 || guard++ > 1e6) return null;
      const e = G.edges[ei];
      const fwd = e.b === v && !(e.a === v && e.b === v);
      steps.push({ e: ei, fwd });
      v = fwd ? e.a : e.b;
    }
    return steps.reverse();
  }

  /* ---------- Startpunkt einrasten ---------- */
  function snap(G, pt, minCompLen) {
    const cand = [];
    for (let i = 0; i < G.n; i++) {
      if (!G.adj[i].length) continue;
      cand.push([hav(pt, G.nodeCoord[i]), i]);
    }
    cand.sort((x, y) => x[0] - y[0]);
    const maxComp = Math.max(0, ...G.compLen);
    const need = Math.min(minCompLen, maxComp * 0.9);
    for (const [d, i] of cand.slice(0, 400)) {
      if (G.compLen[G.comp[i]] >= need) return { node: i, dist: d };
    }
    return cand.length ? { node: cand[0][1], dist: cand[0][0] } : null;
  }

  /* ---------- Rundwege ---------- */
  function evalLoop(G, steps) {
    const count = new Map(); let total = 0;
    for (const s of steps) { count.set(s.e, (count.get(s.e) || 0) + 1); total += G.edges[s.e].len; }
    let overlap = 0;
    for (const [ei, c] of count) if (c > 1) overlap += G.edges[ei].len * (c - 1);
    return { total, overlap, set: count };
  }

  function similarity(G, A, B) {
    let inter = 0, uni = 0;
    for (const ei of A.set.keys()) { const l = G.edges[ei].len; uni += l; if (B.set.has(ei)) inter += l; }
    for (const ei of B.set.keys()) if (!A.set.has(ei)) uni += G.edges[ei].len;
    return uni ? inter / uni : 0;
  }

  // Entfernt Stichwege: dieselbe Kante direkt hin und zurück (nicht am Start/Ende)
  function pruneSpurs(steps) {
    const out = [];
    for (const st of steps) {
      const top = out[out.length - 1];
      if (top && top.e === st.e && top.fwd !== st.fwd && out.length > 1) { out.pop(); continue; }
      out.push(st);
    }
    return out;
  }

  // Erzeugt Dreiecks-Rundwege S -> P -> Q -> S mit Strafgewicht auf bereits benutzten Kanten
  function* loopCandidates(G, S, L, f, bearings, turn = 60) {
    const base = ei => G.edges[ei].w;
    const d0 = dijkstra(G, S, base, L * 0.65);
    const sc = G.nodeCoord[S];
    const reach = [];
    for (let i = 0; i < G.n; i++) if (isFinite(d0.dist[i]) && i !== S) reach.push(i);
    const brg = new Float64Array(G.n);
    for (const i of reach) brg[i] = bearing(sc, G.nodeCoord[i]);
    const a = L * f;

    for (let k = 0; k < bearings; k++) {
      const theta = k * 360 / bearings;
      for (const side of [1, -1]) {
        yield null; // Zeitscheibe für die Oberfläche
        // P: in Richtung theta, etwa a entfernt
        let P = -1, best = Infinity;
        for (const i of reach) {
          const d = d0.dist[i];
          if (d < a * 0.7 || d > a * 1.3) continue;
          const s = angDiff(brg[i], theta) / 180 * a + Math.abs(d - a) * 0.5;
          if (s < best) { best = s; P = i; }
        }
        if (P < 0) continue;
        const p1 = pathTo(G, d0, P); if (!p1) continue;
        const used = new Set(p1.map(s => s.e));
        const onP1 = new Set([S]); for (const s of p1) { const e = G.edges[s.e]; onP1.add(e.a); onP1.add(e.b); }
        // bereits genutzte Wege und Knoten meiden, damit sich der Rundweg nicht kreuzt
        const pen = ei => { const e = G.edges[ei]; return e.w * (used.has(ei) ? 12 : 1) * (onP1.has(e.a) || onP1.has(e.b) ? 4 : 1); };
        const d1 = dijkstra(G, P, pen, a * 1.6);
        const want = (theta + side * turn + 360) % 360;
        let Q = -1; best = Infinity;
        for (const i of reach) {
          if (onP1.has(i)) continue;
          const x = d1.dist[i]; if (!isFinite(x)) continue;
          const y = d0.dist[i];
          if (x < a * 0.5 || x > a * 1.5) continue;
          const s = Math.abs(x - a) + Math.abs(y - a) + angDiff(brg[i], want) / 180 * a * 0.6;
          if (s < best) { best = s; Q = i; }
        }
        if (Q < 0) continue;
        const p2 = pathTo(G, d1, Q); if (!p2) continue;
        for (const s of p2) { used.add(s.e); const e = G.edges[s.e]; onP1.add(e.a); onP1.add(e.b); }
        onP1.delete(S);
        const d2 = dijkstra(G, Q, pen, L * 1.5, S);
        const p3 = pathTo(G, d2, S); if (!p3) continue;
        const steps = pruneSpurs(p1.concat(p2, p3));
        yield { steps, theta, side };
      }
    }
  }

  async function findLoops(G, S, L, opts = {}) {
    const tick = opts.tick || (() => Promise.resolve());
    const bearings = opts.bearings || 16;
    const all = [];
    let f = 0.3;
    const fs = [];
    // Runden 4 und 5 nur, wenn nach dem Kreuzungsfilter zu wenige Varianten übrig sind: andere Dreiecksformen
    const TURNS = [60, 60, 60, 35, 95, 60, 75], SIZE = [1, 1, 1, 1, 1, 0.8, 1.25];
    for (let pass = 0; pass < 7; pass++) {
      if (pass >= 3) {
        // zählen, wie viele unterschiedliche, passende Varianten es schon gibt
        const ok = all.filter(x => Math.abs(x.total - L) / L < 0.3).sort((x, y) => x.score - y.score), d = [];
        for (const c of ok) { if (!d.some(p => similarity(G, p, c) > 0.45)) d.push(c); if (d.length >= 6) break; }
        if (d.length >= 6) break;
      }
      fs.push(f);
      let done = 0;
      for (const c of loopCandidates(G, S, L, f * SIZE[pass], pass >= 3 ? 24 : bearings, TURNS[pass])) {
        if (!c) { await tick(Math.min(pass, 2), done++ / (bearings * 2) / 3 + Math.min(pass, 2) / 3); continue; }
        const ev = evalLoop(G, c.steps);
        if (ev.total < 500) continue;
        if (!crossingFree(G, c.steps, true)) continue;
        const dev = Math.abs(ev.total - L) / L;
        const ovl = ev.overlap / ev.total;
        let nat = 0;
        if (G.nature) { const st = routeStats(G, c.steps); nat = 0.9 * st.paved / st.total - 0.35 * st.forestAny / st.total; }
        all.push(Object.assign({ steps: c.steps, score: dev * 3 + ovl * 2.2 + nat }, ev));
      }
      if (!all.length) { f *= 1.4; continue; }
      const top = all.slice().sort((x, y) => x.score - y.score).slice(0, 6).map(x => x.total).sort((x, y) => x - y);
      const med = top[top.length >> 1];
      const good = all.filter(x => Math.abs(x.total - L) / L < 0.15).length;
      if (good >= 24 || pass >= 2) { if (pass < 2) break; continue; }
      f = Math.max(0.12, Math.min(0.5, f * L / med));
      if (pass === 1) f = Math.max(0.12, Math.min(0.5, f * (fs[1] > fs[0] ? 0.82 : 1.18)));   // dritte Runde: andere Form
    }
    all.sort((x, y) => x.score - y.score);
    const picked = [];
    for (const c of all) {
      if (Math.abs(c.total - L) / L > 0.3 && picked.length) continue;
      if (c.overlap / c.total > 0.3 && picked.length) continue;
      if (picked.some(p => similarity(G, p, c) > 0.45)) continue;
      picked.push(c);
      if (picked.length >= (opts.max || 3)) break;
    }
    return picked;
  }

  /* ---------- Kreuzungsfreiheit ---------- */
  // true, wenn die Route keinen Knoten doppelt passiert und sich geometrisch nicht schneidet.
  // Ein Stichweg direkt am Start (hin und zurück) ist erlaubt.
  function crossingFree(G, steps, loop) {
    let st = steps;
    if (loop) {
      let a = 0, b = st.length - 1;
      while (a < b && st[a].e === st[b].e && st[a].fwd !== st[b].fwd) { a++; b--; }
      st = st.slice(a, b + 1);
      if (!st.length) return false;
    }
    const nodes = [];
    for (const x of st) { const e = G.edges[x.e]; nodes.push(x.fwd ? e.a : e.b); }
    const last = G.edges[st[st.length - 1].e]; nodes.push(st[st.length - 1].fwd ? last.b : last.a);
    const seen = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (loop && i === nodes.length - 1 && nodes[i] === nodes[0]) break;
      if (seen.has(nodes[i])) return false;
      seen.add(nodes[i]);
    }
    // Geometrie: ausgedünnte Linie auf Schnittpunkte prüfen (Brücken, Unterführungen ohne gemeinsamen Knoten)
    const all = stepsCoords(G, st);
    const step = Math.max(1, Math.floor(all.length / 1500));
    const pts = []; for (let i = 0; i < all.length; i += step) pts.push(all[i]); pts.push(all[all.length - 1]);
    const n = pts.length; if (n < 4) return true;
    const k = Math.cos(pts[0][0] * Math.PI / 180);
    const P = pts.map(p => [p[1] * k, p[0]]);
    // Raster für schnellen Vergleich
    const cell = 0.004, grid = new Map();
    const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    for (let i = 0; i < n - 1; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[i + 1];
      const cs = new Set([key(x1, y1), key(x2, y2), key((x1 + x2) / 2, (y1 + y2) / 2)]);
      for (const c of cs) { let l = grid.get(c); if (!l) grid.set(c, l = []); l.push(i); }
    }
    const cross = (a, b) => {
      const [p1, p2, p3, p4] = [P[a], P[a + 1], P[b], P[b + 1]];
      const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-14) return false;
      const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
    };
    for (const l of grid.values()) {
      for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) {
        const a = Math.min(l[x], l[y]), b = Math.max(l[x], l[y]);
        if (b - a < 2) continue;
        if (loop && a === 0 && b === n - 2) continue;
        if (cross(a, b)) return false;
      }
    }
    return true;
  }

  /* ---------- Start–Ziel ---------- */
  async function findRoutes(G, A, B, opts = {}) {
    const tick = opts.tick || (() => Promise.resolve());
    const max = opts.max || 3;
    const pen = new Float64Array(G.edges.length).fill(1);
    const out = []; let best = Infinity;
    for (let k = 0; k < max * 2 + 2 && out.length < max; k++) {
      await tick(k / (max * 2 + 2));
      const res = dijkstra(G, A, ei => G.edges[ei].w * pen[ei], Infinity, B);
      const p = pathTo(G, res, B); if (!p) break;
      const steps = pruneSpurs(p);
      const ev = evalLoop(G, steps);
      for (const s of steps) pen[s.e] *= 1.7;
      if (!out.length) best = ev.total;
      if (ev.total > best * (opts.maxRatio || 1.5)) continue;
      if (!crossingFree(G, steps, false)) continue;
      const cand = Object.assign({ steps }, ev);
      if (out.some(o => similarity(G, o, cand) > 0.55)) continue;
      out.push(cand);
    }
    return out;
  }

  /* ---------- Geometrie & Abschnitte ---------- */
  function stepsCoords(G, steps) {
    const out = [];
    for (const s of steps) {
      const c = edgeCoords(G, G.edges[s.e]);
      const seq = s.fwd ? c : c.reverse();
      for (let i = out.length ? 1 : 0; i < seq.length; i++) out.push(seq[i]);
    }
    return out;
  }

  function relRank(G, rid) {
    const t = G.rels.get(rid).tags;
    return NET_RANK[t.network] || 0;
  }

  // Zerlegt den Rundweg in Abschnitte entlang jeweils einer markierten Route
  function segments(G, steps) {
    const segs = [];
    let i = 0, cur = null;
    while (i < steps.length) {
      const here = G.edges[steps[i].e].routes;
      let bestR = null, bestRun = -1;
      for (const r of here) {
        let j = i, run = 0;
        while (j < steps.length && G.edges[steps[j].e].routes.includes(r)) { run += G.edges[steps[j].e].len; j++; }
        const bonus = (r === cur ? 1.25 : 1) * (1 + relRank(G, r) * 0.03);
        if (run * bonus > bestRun) { bestRun = run * bonus; bestR = r; }
      }
      let j = i, len = 0;
      while (j < steps.length && G.edges[steps[j].e].routes.includes(bestR)) { len += G.edges[steps[j].e].len; j++; }
      if (j === i) { len = G.edges[steps[i].e].len; j = i + 1; }
      const last = segs[segs.length - 1];
      if (last && last.rel === bestR) { last.len += len; last.to = j; }
      else segs.push({ rel: bestR, len, from: i, to: j });
      cur = bestR; i = j;
    }
    // Sehr kurze Abschnitte (< 150 m) in den Nachbarn aufgehen lassen
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.len < 150) { last.len += s.len; last.to = s.to; continue; }
      if (last && last.rel === s.rel) { last.len += s.len; last.to = s.to; continue; }
      merged.push(Object.assign({}, s));
    }
    return merged;
  }

  /* ---------- Gehzeit nach DIN 33466 ---------- */
  function walkTime(km, up, down) {
    const h = km / 4;
    const v = up / 300 + down / 500;
    return Math.max(h, v) + Math.min(h, v) / 2;
  }

  /* ---------- osmc:symbol ---------- */
  const OSMC_COL = { black: '#1d1d1b', blue: '#1f5fbf', brown: '#7a4b22', gray: '#8a8a8a', grey: '#8a8a8a', green: '#2e8b3a', orange: '#ef7d00', purple: '#7b3a96', red: '#d22b26', white: '#ffffff', yellow: '#f5d000' };

  function osmcSVG(tags, size = 22) {
    const sym = tags['osmc:symbol'];
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const S = size;
    if (!sym) {
      const col = tags.colour || '#3a6b4c';
      const txt = (tags.ref || '').slice(0, 4);
      return `<svg class="osmc" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" aria-hidden="true"><rect x="0.5" y="0.5" width="${S - 1}" height="${S - 1}" rx="3" fill="#fff" stroke="#9aa59d"/><rect x="3" y="${S / 2 - 3}" width="${S - 6}" height="6" fill="${esc(col)}"/>${txt ? `<text x="${S / 2}" y="${S / 2 + 3.5}" text-anchor="middle" font-size="${txt.length > 2 ? 7 : 9}" font-weight="700" fill="#111" font-family="Barlow Condensed, sans-serif" stroke="#fff" stroke-width="2" paint-order="stroke">${esc(txt)}</text>` : ''}</svg>`;
    }
    const p = sym.split(':');
    const col = n => OSMC_COL[(n || '').toLowerCase()] || null;
    let bg = p[1] || 'white', fg = p[2] || '', fg2 = null, text = null, tcol = null;
    if (p.length >= 5) { tcol = p[p.length - 1]; text = p[p.length - 2]; if (p.length >= 6) fg2 = p[3]; }
    let out = '';
    const [bgc, bgs] = bg.split('_');
    const bgFill = col(bgc) || '#ffffff';
    if (bgs === 'circle') out += `<rect width="${S}" height="${S}" rx="3" fill="#fff"/><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2 - 1}" fill="${bgFill}" stroke="#9aa59d"/>`;
    else if (bgs === 'frame') out += `<rect x="1.5" y="1.5" width="${S - 3}" height="${S - 3}" fill="#fff" stroke="${bgFill}" stroke-width="3"/>`;
    else out += `<rect x="0.5" y="0.5" width="${S - 1}" height="${S - 1}" rx="${bgs === 'round' ? 6 : 2}" fill="${bgFill}" stroke="#9aa59d"/>`;
    const shape = f => {
      if (!f) return '';
      const parts = f.split('_'); const c = col(parts[0]); const kind = parts.slice(1).join('_');
      if (!c) return '';
      const m = S / 2, q = S / 4;
      switch (kind) {
        case 'bar': return `<rect x="1" y="${m - S / 6}" width="${S - 2}" height="${S / 3}" fill="${c}"/>`;
        case 'stripe': return `<rect x="${m - S / 6}" y="1" width="${S / 3}" height="${S - 2}" fill="${c}"/>`;
        case 'dot': return `<circle cx="${m}" cy="${m}" r="${q * 1.1}" fill="${c}"/>`;
        case 'circle': return `<circle cx="${m}" cy="${m}" r="${q * 1.3}" fill="none" stroke="${c}" stroke-width="2.6"/>`;
        case 'cross': return `<rect x="${m - 2}" y="${q * 0.7}" width="4" height="${S - q * 1.4}" fill="${c}"/><rect x="${q * 0.7}" y="${m - 2}" width="${S - q * 1.4}" height="4" fill="${c}"/>`;
        case 'x': return `<path d="M${q * 0.8} ${q * 0.8}L${S - q * 0.8} ${S - q * 0.8}M${S - q * 0.8} ${q * 0.8}L${q * 0.8} ${S - q * 0.8}" stroke="${c}" stroke-width="3.2"/>`;
        case 'triangle': return `<path d="M${m} ${q * 0.7}L${S - q * 0.7} ${S - q * 0.9}L${q * 0.7} ${S - q * 0.9}Z" fill="${c}"/>`;
        case 'diamond': return `<path d="M${m} ${q * 0.5}L${S - q * 0.6} ${m}L${m} ${S - q * 0.5}L${q * 0.6} ${m}Z" fill="${c}"/>`;
        case 'lower': return `<rect x="1" y="${m}" width="${S - 2}" height="${m - 1}" fill="${c}"/>`;
        case 'left': return `<rect x="1" y="1" width="${m - 1}" height="${S - 2}" fill="${c}"/>`;
        case 'corner': return `<path d="M1 1H${S - 2}L1 ${S - 2}Z" fill="${c}"/>`;
        case 'triangle_turned': return `<path d="M${q * 0.7} ${q * 0.9}H${S - q * 0.7}L${m} ${S - q * 0.7}Z" fill="${c}"/>`;
        case 'hiker': case 'wheel': case 'pointer': case 'arch': return `<circle cx="${m}" cy="${m}" r="${q * 0.9}" fill="${c}"/>`;
        default: return `<rect x="1" y="${m - S / 8}" width="${S - 2}" height="${S / 4}" fill="${c}"/>`;
      }
    };
    out += shape(fg) + shape(fg2);
    if (text) {
      const tc = col(tcol) || '#111';
      const fs = text.length > 3 ? 6.5 : text.length > 2 ? 8 : 10;
      out += `<text x="${S / 2}" y="${S / 2 + fs * 0.36}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="${tc}" font-family="Barlow Condensed, sans-serif">${esc(text)}</text>`;
    }
    return `<svg class="osmc" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" aria-hidden="true">${out}</svg>`;
  }

  function routeLabel(tags) {
    const ref = tags.ref || '';
    const name = tags.name || tags['name:de'] || '';
    if (ref && name && !name.includes(ref)) return { title: name, ref };
    return { title: name || ref || 'Markierter Wanderweg', ref: name ? ref : '' };
  }

  const WK = { hav, bearing, buildGraph, crossingFree, setWeights, routeStats, classRuns, compactFromOverpass, mergeCompact, edgeCoords, wayCoords, findRoutes, dijkstra, pathTo, snap, findLoops, evalLoop, stepsCoords, segments, walkTime, osmcSVG, routeLabel, NET_LABEL, NET_RANK };
  if (typeof module !== 'undefined' && module.exports) module.exports = WK;
  root.WK = WK;
})(typeof globalThis !== 'undefined' ? globalThis : this);
