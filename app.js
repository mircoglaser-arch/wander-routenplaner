/* Wander-Routenplaner – Oberfläche */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  const km = m => nf1.format(m / 1000);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('wk.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('wk.' + k, JSON.stringify(v)); } catch (e) { /* ohne Speicher weiter */ } }
  };

  const REGIONS = [
    { id: 'koeln', name: 'Köln', place: 'Königsforst', ll: [50.9205, 7.1060] },
    { id: 'bergisch', name: 'Bergisches Land', place: 'Altenberg', ll: [51.0555, 7.0330] },
    { id: 'sieben', name: 'Siebengebirge', place: 'Margarethenhöhe', ll: [50.6830, 7.2445] },
    { id: 'eifel', name: 'Eifel', place: 'Monschau', ll: [50.5550, 6.2400] },
    { id: 'sauer', name: 'Sauerland', place: 'Winterberg', ll: [51.1940, 8.5310] },
    { id: 'mosel', name: 'Mosel', place: 'Cochem', ll: [50.1460, 7.1660] },
    { id: 'rhein', name: 'Rhein', place: 'Boppard', ll: [50.2310, 7.5900] },
    { id: 'harz', name: 'Harz', place: 'Torfhaus', ll: [51.8040, 10.5330] },
    { id: 'saechs', name: 'Sächsische Schweiz', place: 'Bad Schandau', ll: [50.9180, 14.1550] },
    { id: 'schwarz', name: 'Schwarzwald', place: 'Titisee', ll: [47.9010, 8.1580] },
    { id: 'allgaeu', name: 'Allgäu', place: 'Oberstdorf', ll: [47.4090, 10.2780] },
    { id: 'pfalz', name: 'Pfälzerwald', place: 'Johanniskreuz', ll: [49.3480, 7.8240] },
    { id: 'thuer', name: 'Thüringer Wald', place: 'Oberhof', ll: [50.7060, 10.7270] },
    { id: 'ostsee', name: 'Ostsee', place: 'Sassnitz (Rügen)', ll: [54.5160, 13.6420] }
  ];
  const OVERPASS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  const LONG_KM = 60;

  const S = {
    start: null, startLabel: '', region: store.get('region', 'sieben'), L: store.get('len', 12),
    mode: store.get('mode', 'loop'), nature: store.get('nature', true), sort: 'best', end: null, endLabel: '', cancel: false, busy: false,
    G: null, loaded: null, snap: null, loops: [], sel: -1, picking: false,
    gpsLL: null, gpsAcc: null, watch: null, nav: null, wake: null
  };

  /* ---------- Karte ---------- */
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([50.8, 7.2], 9);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap, SRTM · OpenTopoMap (CC-BY-SA)' });
  const wmt = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', { maxZoom: 18, opacity: 0.85, attribution: 'Waymarked Trails' });
  osm.addTo(map); wmt.addTo(map);
  const renderer = L.canvas({ tolerance: 10 });
  const netLayer = L.layerGroup();
  const loopLayer = L.layerGroup().addTo(map);
  const extraLayer = L.layerGroup().addTo(map);
  L.control.layers({ 'Straßenkarte': osm, 'Topografisch': topo }, { 'Markierungen (Waymarked Trails)': wmt, 'Geladene Wanderwege': netLayer }, { position: 'topright', collapsed: true }).addTo(map);
  map.attributionControl.setPrefix(false);

  const startIcon = L.divIcon({ className: '', html: '<div class="mk-start">S</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
  const endIcon = L.divIcon({ className: '', html: '<div class="mk-end">Z</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
  let endMarker = null;
  const gpsIcon = L.divIcon({ className: '', html: '<div class="mk-gps"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  let startMarker = null, gpsMarker = null, gpsCircle = null;

  /* ---------- Bedienelemente ---------- */
  const regionsEl = $('regions');
  regionsEl.innerHTML = REGIONS.map(r => `<button class="chip" type="button" data-id="${r.id}" aria-pressed="false" title="${esc(r.place)}">${esc(r.name)}</button>`).join('');
  regionsEl.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const r = REGIONS.find(x => x.id === b.dataset.id);
    S.region = r.id; store.set('region', r.id);
    setStart(r.ll, `${r.name} · ${r.place}`, 'region');
    map.setView(r.ll, 13);
  });

  const regionsEndEl = $('regionsEnd');
  regionsEndEl.innerHTML = REGIONS.map(r => `<button class="chip" type="button" data-id="${r.id}" aria-pressed="false" title="${esc(r.place)}">${esc(r.name)}</button>`).join('');
  regionsEndEl.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const r = REGIONS.find(x => x.id === b.dataset.id);
    setEnd(r.ll, `${r.name} · ${r.place}`, r.id);
    fitStartEnd();
  });
  function fitStartEnd() { if (S.start && S.end) map.fitBounds(L.latLngBounds([S.start, S.end]), { padding: [60, 60] }); }

  function setMode(m) {
    S.mode = m; store.set('mode', m);
    $('modeLoop').setAttribute('aria-pressed', m === 'loop');
    $('modeAB').setAttribute('aria-pressed', m === 'ab');
    $('endBlock').hidden = m !== 'ab';
    $('lenBlock').hidden = m !== 'loop';
    $('btnRun').textContent = m === 'loop' ? 'Rundwege finden' : 'Route finden';
    if (endMarker) { if (m === 'ab') endMarker.addTo(map); else endMarker.remove(); }
    clearResults();
    status(m === 'loop' ? 'Startpunkt wählen, Länge einstellen, dann Rundwege berechnen.' : 'Start und Ziel wählen, dann Route berechnen. Die App sucht den Weg über markierte Wanderwege und bietet bis zu drei Varianten an.');
  }
  function clearResults() {
    S.loops = []; S.sel = -1; loopLayer.clearLayers(); wmt.setOpacity(0.85); if (hl) { map.removeLayer(hl); hl = null; }
    $('results').hidden = true; $('results').innerHTML = ''; $('detail').hidden = true; $('detail').innerHTML = '';
    if (S.nav) stopNav();
  }
  const natEl = $('nature'); natEl.checked = S.nature;
  natEl.onchange = () => { S.nature = natEl.checked; store.set('nature', S.nature); if (S.G) WK.setWeights(S.G, S.nature); if (S.loops.length) status('Einstellung geändert. „' + $('btnRun').textContent + '“ antippen, um neu zu berechnen.'); };
  $('modeLoop').onclick = () => setMode('loop');
  $('modeAB').onclick = () => setMode('ab');
  $('btnSwap').onclick = () => {
    if (!S.end) return;
    const a = S.start, al = S.startLabel; setStart(S.end, S.endLabel, 'map'); setEnd(a, al, null);
  };

  const lenEl = $('len');
  lenEl.value = S.L;
  const showLen = () => {
    S.L = +lenEl.value; store.set('len', S.L);
    $('lenOut').textContent = S.L + ' km';
    $('lenNote').hidden = S.L <= LONG_KM;
  };
  lenEl.addEventListener('input', showLen); showLen();

  $('grip').addEventListener('click', () => {
    const ex = $('sheet').classList.toggle('expanded');
    $('grip').setAttribute('aria-expanded', ex);
    setTimeout(() => map.invalidateSize(), 300);
  });

  $('btnPick').addEventListener('click', () => setPicking(S.picking === 'start' ? false : 'start'));
  $('btnPickEnd').addEventListener('click', () => setPicking(S.picking === 'end' ? false : 'end'));
  function setPicking(what) {
    S.picking = what;
    $('btnPick').setAttribute('aria-pressed', what === 'start');
    $('btnPickEnd').setAttribute('aria-pressed', what === 'end');
    document.body.classList.toggle('picking', !!what);
    let h = document.querySelector('.hint');
    if (what && !h) { h = document.createElement('div'); h.className = 'hint'; $('app').appendChild(h); }
    if (h) h.textContent = what === 'end' ? 'Ziel auf der Karte antippen' : 'Startpunkt auf der Karte antippen';
    if (!what && h) h.remove();
    if (what) $('sheet').classList.remove('expanded');
  }
  map.on('click', e => {
    if (!S.picking) return;
    const what = S.picking; setPicking(false);
    const ll = [e.latlng.lat, e.latlng.lng];
    if (what === 'end') setEnd(ll, 'Gewählter Punkt', null); else setStart(ll, 'Gewählter Punkt', 'map');
  });

  $('btnGps').addEventListener('click', () => {
    if (!navigator.geolocation) return status('Dieses Gerät stellt keinen Standort bereit.', 'err');
    status('Standort wird ermittelt …');
    navigator.geolocation.getCurrentPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      showGps(ll, p.coords.accuracy);
      setStart(ll, `Mein Standort (± ${nf0.format(p.coords.accuracy)} m)`, 'gps');
      map.setView(ll, 14);
      status(S.mode === 'loop' ? 'Standort übernommen. Jetzt Länge wählen und Rundwege finden.' : 'Standort ist der Start. Jetzt ein Ziel wählen.');
      startWatch();
    }, err => {
      status(err.code === 1 ? 'Standortfreigabe wurde abgelehnt. Bitte in den Browser-Einstellungen erlauben oder Startpunkt auf der Karte wählen.' : 'Standort konnte nicht ermittelt werden. Bitte im Freien erneut versuchen oder Startpunkt auf der Karte wählen.', 'err');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });

  function setStart(ll, label, src) {
    S.start = ll; S.startLabel = label;
    if (S.picking) setPicking(false);
    if (src !== 'search') $('qStart').value = '';
    if (S.end) { const d = ` · Luftlinie ${km(WK.hav(ll, S.end))} km`; $('endInfo').innerHTML = `Ziel: <b>${esc(S.endLabel)}</b>${d}`; }
    if (!startMarker) startMarker = L.marker(ll, { icon: startIcon, draggable: true, zIndexOffset: 1000, title: 'Startpunkt (verschiebbar)' }).addTo(map)
      .on('dragend', ev => { const p = ev.target.getLatLng(); setStart([p.lat, p.lng], 'Verschobener Punkt', 'map'); });
    else startMarker.setLatLng(ll);
    for (const b of regionsEl.children) b.setAttribute('aria-pressed', src === 'region' && b.dataset.id === S.region);
    $('startInfo').innerHTML = `Start: <b>${esc(label)}</b> · ${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`;
  }

  /* ---------- Ortssuche (Photon / OpenStreetMap) ---------- */
  function attachSearch(input, list, pick) {
    let timer = null, ctl = null, items = [], sel = -1;
    const close = () => { list.hidden = true; sel = -1; input.setAttribute('aria-expanded', 'false'); };
    const render = (msg) => {
      if (msg) { list.innerHTML = `<li class="none">${esc(msg)}</li>`; list.hidden = false; return; }
      list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}"><b>${esc(it.name)}</b><span>${esc(it.sub)}</span></li>`).join('');
      list.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length));
    };
    async function search(q, thenPick) {
      if (ctl) ctl.abort(); ctl = new AbortController();
      const c = map.getCenter();
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=de&limit=7&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&bbox=5.5,47.0,15.5,55.2`, { signal: ctl.signal });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        items = (j.features || []).map(f => {
          const p = f.properties || {};
          const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || q;
          const sub = [p.name && p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '', p.postcode, p.city && p.city !== name ? p.city : (p.district || ''), p.state].filter(Boolean).join(', ');
          return { name, sub, ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] };
        });
        sel = items.length ? 0 : -1;
        if (thenPick && items.length) return choose(0);
        render(items.length ? null : 'Nichts gefunden. Anders schreiben oder Punkt auf der Karte wählen.');
      } catch (e) { if (e.name !== 'AbortError') render('Suche gerade nicht erreichbar. Punkt auf der Karte wählen.'); }
    }
    function choose(i) {
      const it = items[i]; if (!it) return;
      input.value = it.name; close();
      pick(it.ll, it.sub ? `${it.name}, ${it.sub.split(', ').slice(-2, -1)[0] || it.sub}` : it.name);
    }
    input.addEventListener('input', () => {
      clearTimeout(timer); const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      timer = setTimeout(() => search(q, false), 300);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return; e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render();
      } else if (e.key === 'Enter') {
        e.preventDefault(); const q = input.value.trim();
        if (!list.hidden && sel >= 0) choose(sel); else if (q.length >= 2) { clearTimeout(timer); search(q, true); }
      } else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }
  attachSearch($('qStart'), $('sgStart'), (ll, label) => {
    setStart(ll, label, 'search');
    if (S.mode === 'ab' && S.end) fitStartEnd(); else map.setView(ll, 14);
  });
  attachSearch($('qEnd'), $('sgEnd'), (ll, label) => {
    setEnd(ll, label, null, true);
    if (S.start) fitStartEnd(); else map.setView(ll, 14);
  });

  function setEnd(ll, label, regionId, fromSearch) {
    if (S.picking) setPicking(false);
    if (!fromSearch) $('qEnd').value = '';
    S.end = ll; S.endLabel = label;
    if (!endMarker) endMarker = L.marker(ll, { icon: endIcon, draggable: true, zIndexOffset: 1000, title: 'Ziel (verschiebbar)' })
      .on('dragend', ev => { const p = ev.target.getLatLng(); setEnd([p.lat, p.lng], 'Verschobener Punkt', null); });
    endMarker.setLatLng(ll); if (S.mode === 'ab') endMarker.addTo(map);
    for (const b of regionsEndEl.children) b.setAttribute('aria-pressed', b.dataset.id === regionId);
    const d = S.start ? ` · Luftlinie ${km(WK.hav(S.start, ll))} km` : '';
    $('endInfo').innerHTML = `Ziel: <b>${esc(label)}</b>${d}`;
  }

  function showGps(ll, acc) {
    S.gpsLL = ll; S.gpsAcc = acc;
    if (!gpsMarker) { gpsMarker = L.marker(ll, { icon: gpsIcon, interactive: false, zIndexOffset: 900 }).addTo(map); gpsCircle = L.circle(ll, { radius: acc, color: '#2f7bf6', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map); }
    else { gpsMarker.setLatLng(ll); gpsCircle.setLatLng(ll).setRadius(acc); }
  }
  function startWatch() {
    if (S.watch != null || !navigator.geolocation) return;
    S.watch = navigator.geolocation.watchPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      showGps(ll, p.coords.accuracy);
      if (S.nav) navUpdate(ll, p.coords.accuracy);
    }, () => { }, { enableHighAccuracy: true, maximumAge: 5000 });
  }

  function status(t, kind, p) {
    $('statusText').textContent = t;
    $('status').classList.toggle('err', kind === 'err');
    $('prog').style.width = (p == null ? 0 : Math.round(p * 100)) + '%';
  }

  /* ---------- Overpass ---------- */
  // Alle Server parallel anfragen, die erste brauchbare Antwort gewinnt
  async function overpass(q) {
    const ctls = OVERPASS.map(() => new AbortController());
    const tries = OVERPASS.map((url, i) => (async () => {
      const t = setTimeout(() => ctls[i].abort(), 120000);
      try {
        const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctls[i].signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark)) throw new Error(j.remark);
        return { j, i };
      } finally { clearTimeout(t); }
    })());
    try {
      const { j, i } = await Promise.any(tries);
      ctls.forEach((c, k) => { if (k !== i) c.abort(); });
      return j;
    } catch (e) { throw new Error('Overpass nicht erreichbar'); }
  }

  // extra: Kacheln mit allen Wegen rund um Start/Ziel, damit lange Touren auch abseits der Fernwege beginnen können
  async function loadTiles(keys, set, extra = []) {
    const sig = k => set + ':' + k, need = keys.map(sig).concat(extra.map(k => 'all:' + k));
    if (S.loaded && S.loaded.tiles && need.every(k => S.loaded.tiles.has(k))) return S.G;
    const what = set === 'long' ? 'Fern- und Regionalwege' : 'markierte Wanderwege';
    S.cancel = false;
    const t0 = performance.now(); let last = { done: 0, total: keys.length, cached: 0, failed: 0 };
    const show = () => { const p = last; const sec = Math.round((performance.now() - t0) / 1000);
      status(`Lade ${what}: Kachel ${p.done} von ${p.total}${p.cached ? ` (${p.cached} vom Gerät)` : ''}${p.failed ? `, ${p.failed} fehlgeschlagen` : ''} · ${sec} s${p.slow ? ` – ${p.slow} Kacheln liegen außerhalb Deutschlands und kommen langsamer direkt von OpenStreetMap` : ''}`, null, 0.02 + 0.26 * p.done / p.total); };
    const iv = setInterval(show, 1000);
    let res;
    let ex = { parts: [], failed: 0 };
    try {
      if (extra.length) ex = await Tiles.load(extra, 'all', () => {}, () => S.cancel);
      res = await Tiles.load(keys, set, p => { last = p; show(); }, () => S.cancel);
    } finally { clearInterval(iv); }
    refreshOffline();
    if (S.cancel) throw new Error('cancel');
    if (!res.parts.length || res.failed > keys.length * 0.3) throw new Error('load');
    status('Baue Wegenetz …', null, 0.29); await sleep(20);
    const G = WK.buildGraph(WK.mergeCompact(ex.parts.concat(res.parts)));
    S.G = G; S.loaded = { tiles: new Set(need), set, failed: res.failed };
    drawNetwork(G);
    return G;
  }

  async function loadNetwork(center, radius, longOnly) {
    if (S.loaded && !S.loaded.tiles && S.loaded.longOnly === longOnly && WK.hav(center, S.loaded.center) + radius <= S.loaded.radius + 300) return S.G;
    const r = Math.round(radius);
    const [la, lo] = center.map(x => x.toFixed(5));
    const net = longOnly ? '["network"~"^(rwn|nwn|iwn)$"]' : '';
    const q = `[out:json][timeout:${longOnly ? 180 : 90}][maxsize:1073741824];relation["route"~"^(hiking|foot)$"]${net}(around:${r},${la},${lo})->.r;.r out body;way(r.r)(around:${r},${la},${lo});out skel geom qt;`;
    status(`Lade markierte Wanderwege im Umkreis von ${nf0.format(r / 1000)} km …`, null, 0.05);
    const t0 = performance.now();
    const tick = setInterval(() => status(`Lade markierte Wanderwege im Umkreis von ${nf0.format(r / 1000)} km … ${Math.round((performance.now() - t0) / 1000)} s (die OpenStreetMap-Server brauchen je nach Auslastung bis zu einer Minute)`, null, 0.05 + Math.min(0.2, (performance.now() - t0) / 300000)), 1000);
    let data;
    try { data = await overpass(q); } finally { clearInterval(tick); }
    status('Baue Wegenetz …', null, 0.25); await sleep(10);
    const G = WK.buildGraph(data);
    S.G = G; S.loaded = { center, radius: r, longOnly };
    drawNetwork(G);
    console.info('Overpass', Math.round(performance.now() - t0), 'ms', G);
    return G;
  }

  function netColor(G, routes) {
    let best = 0;
    for (const r of routes) best = Math.max(best, WK.NET_RANK[G.rels.get(r).tags.network] || 0);
    return best >= 3 ? css('--blaze') : best === 2 ? '#c27c0e' : css('--forest');
  }

  function drawNetwork(G) {
    netLayer.clearLayers();
    if (G.wayList.length > 6000) { if (map.hasLayer(netLayer)) map.removeLayer(netLayer); return; }
    for (const w of G.wayList) {
      L.polyline(WK.wayCoords(w), { renderer, color: netColor(G, w.routes), weight: 4, opacity: 0.18 })
        .on('click', ev => { if (!S.picking) routePopup(w.routes, ev.latlng); })
        .addTo(netLayer);
    }
    if (!map.hasLayer(netLayer)) netLayer.addTo(map);
    loopLayer.eachLayer(l => l.bringToFront && l.bringToFront());
  }

  /* ---------- Weginfo ---------- */
  function routePopup(routes, latlng) {
    const G = S.G;
    const list = routes.map(id => G.rels.get(id)).filter(Boolean)
      .sort((a, b) => (WK.NET_RANK[b.tags.network] || 0) - (WK.NET_RANK[a.tags.network] || 0));
    const html = `<div class="pop"><h4>${list.length === 1 ? 'Markierter Weg' : list.length + ' markierte Wege'}</h4>` + list.map(r => {
      const t = r.tags; const lb = WK.routeLabel(t);
      const meta = [lb.ref, WK.NET_LABEL[t.network], t.distance ? t.distance + ' km' : '', t.operator].filter(Boolean).map(esc).join(' · ');
      const ft = t.from && t.to ? `<div class="m">${esc(t.from)} → ${esc(t.to)}</div>` : '';
      const links = [
        t.website ? `<a href="${esc(t.website)}" target="_blank" rel="noopener">Website</a>` : '',
        `<a href="https://hiking.waymarkedtrails.org/#route?id=${r.id}" target="_blank" rel="noopener">Waymarked Trails</a>`,
        `<a href="https://www.openstreetmap.org/relation/${r.id}" target="_blank" rel="noopener">OSM</a>`
      ].join('');
      return `<div class="r">${WK.osmcSVG(t)}<div><b>${esc(lb.title)}</b><div class="m">${meta}</div>${ft}<div class="l">${links}</div><button type="button" data-rel="${r.id}">Ganzen Weg zeigen</button></div></div>`;
    }).join('') + '</div>';
    L.popup({ maxWidth: 300 }).setLatLng(latlng).setContent(html).openOn(map);
  }

  map.on('popupopen', e => {
    e.popup.getElement().querySelectorAll('button[data-rel]').forEach(b => b.addEventListener('click', () => showWholeRoute(+b.dataset.rel, b)));
  });

  async function showWholeRoute(id, btn) {
    btn.disabled = true; btn.textContent = 'Lade …';
    try {
      const d = await overpass(`[out:json][timeout:60];relation(${id});out tags;way(r);out geom qt;`);
      extraLayer.clearLayers();
      const rel = d.elements.find(x => x.type === 'relation');
      let len = 0; const lines = [];
      for (const w of d.elements) if (w.type === 'way' && w.geometry) {
        const c = w.geometry.map(g => [g.lat, g.lon]); lines.push(c);
        for (let i = 1; i < c.length; i++) len += WK.hav(c[i - 1], c[i]);
      }
      const pl = L.polyline(lines, { color: css('--blaze'), weight: 5, opacity: 0.9, dashArray: '8 6' }).addTo(extraLayer);
      map.closePopup(); map.fitBounds(pl.getBounds(), { padding: [30, 30] });
      const lb = rel ? WK.routeLabel(rel.tags) : { title: 'Weg' };
      status(`${lb.title}: ${km(len)} km markierte Strecke (alle Abschnitte, ggf. inkl. Varianten). Tippen auf „Rundwege finden“ blendet sie wieder aus.`);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Erneut versuchen';
    }
  }

  /* ---------- Touren berechnen ---------- */
  $('btnRun').addEventListener('click', run);
  async function run() {
    if (S.busy) { S.cancel = true; return; }
    if (!S.start) return status('Bitte zuerst einen Startpunkt wählen: Standort, Region oder Punkt auf der Karte.', 'err');
    if (S.mode === 'ab' && !S.end) return status('Bitte ein Ziel wählen: Region antippen oder Punkt auf der Karte.', 'err');
    const btn = $('btnRun'); S.busy = true; btn.textContent = 'Abbrechen';
    extraLayer.clearLayers(); map.closePopup(); clearResults();
    try {
      if (S.mode === 'loop') await runLoop(); else await runAB();
    } catch (e) {
      console.error(e);
      const msg = e.message === 'far' ? `Kein passender markierter Wanderweg in der Nähe von ${e.which || 'Start'} – der nächste liegt ${km(e.dist)} km entfernt. Punkt näher an ein Wegenetz setzen.`
        : e.message === 'none' ? 'Im Gebiet wurden keine markierten Wanderwege gefunden.'
          : e.message === 'noloop' ? 'Aus den Wegen hier ließ sich kein geschlossener Rundweg bilden. Andere Länge oder anderen Startpunkt versuchen.'
            : e.message === 'noroute' ? 'Zwischen Start und Ziel gibt es keine durchgehende Verbindung über markierte Wege. Ziel oder Start verschieben.'
              : S.cancel ? 'Abgebrochen. Bereits geladene Kacheln bleiben auf dem Gerät gespeichert.'
                : 'Die Wegedaten konnten nicht geladen werden (OpenStreetMap-Server ausgelastet oder offline). Bitte in einer Minute erneut versuchen – bereits geladene Kacheln bleiben gespeichert.';
      status(msg, 'err');
    } finally { S.busy = false; S.cancel = false; btn.textContent = S.mode === 'loop' ? 'Rundwege finden' : 'Route finden'; }
  }

  function snapOrThrow(G, ll, need, which, long) {
    const sn = WK.snap(G, ll, need);
    if (!sn) throw new Error('none');
    if (sn.dist > 3000) throw Object.assign(new Error('far'), { dist: sn.dist, which, long });
    return sn;
  }

  async function runLoop() {
    const L_m = S.L * 1000;
    const long = S.L > LONG_KM;
    const G = long
      ? await loadTiles(Tiles.tilesCircle(S.start, Math.min(80000, L_m * 0.36 + 3000)), 'long', Tiles.tilesCircle(S.start, 5000))
      : await shortNet(Tiles.tilesCircle(S.start, Math.min(27000, Math.max(3500, L_m * 0.42 + 1500))), () => loadNetwork(S.start, Math.min(16000, Math.max(3500, L_m * 0.42 + 1500)), false));
    if (!G.edges.length) throw new Error('none');
    WK.setWeights(G, S.nature);
    const snap = snapOrThrow(G, S.start, L_m * 0.8, 'Start', long);
    status(`${G.rels.size} markierte Wege geladen. Suche Rundwege …`, null, 0.3);
    const loops = await WK.findLoops(G, snap.node, Math.max(1500, L_m - 2 * snap.dist), {
      max: 10,
      tick: (pass, p) => { if (S.cancel) throw new Error('cancel'); status(`Kombiniere Wege … Runde ${pass + 1} von 3`, null, 0.3 + p * 0.65); return sleep(0); }
    });
    if (!loops.length) throw new Error('noloop');
    S.loops = loops.map((lp, i) => prepRoute(G, lp, snap, snap, S.start, S.start, i));
    await showResults();
    const offs = S.loops.filter(x => Math.abs(x.total - L_m) / L_m > 0.2).length;
    status(offs === S.loops.length
      ? `Hier lässt sich ${S.L} km nur ungefähr erreichen – das Wegenetz gibt nicht mehr her. Länge anpassen oder Startpunkt verschieben.`
      : `${S.loops.length} Rundweg${S.loops.length > 1 ? 'e' : ''} aus ${G.rels.size} markierten Wegen${long ? ' (Fern- und Regionalwege)' : ' der Umgebung'}.`, null, 1);
  }

  async function runAB() {
    const d = WK.hav(S.start, S.end);
    const long = d > LONG_KM * 1000;
    const mid = [(S.start[0] + S.end[0]) / 2, (S.start[1] + S.end[1]) / 2];
    const G = long
      ? await loadTiles(Tiles.tilesCorridor(S.start, S.end, 12000 + d * 0.12), 'long', Tiles.tilesCircle(S.start, 5000).concat(Tiles.tilesCircle(S.end, 5000)))
      : await shortNet(Tiles.tilesCorridor(S.start, S.end, 4000 + d * 0.15), () => loadNetwork(mid, Math.min(16000, d / 2 + 4000), false));
    if (!G.edges.length) throw new Error('none');
    WK.setWeights(G, S.nature);
    const sa = snapOrThrow(G, S.start, d * 0.5, 'Start', long);
    const sb = snapOrThrow(G, S.end, d * 0.5, 'Ziel', long);
    if (G.comp[sa.node] !== G.comp[sb.node]) throw new Error('noroute');
    status(`${G.rels.size} markierte Wege geladen. Suche Route …`, null, 0.4);
    const routes = await WK.findRoutes(G, sa.node, sb.node, { max: 10, tick: p => { if (S.cancel) throw new Error('cancel'); status('Suche Varianten …', null, 0.4 + p * 0.5); return sleep(0); } });
    if (!routes.length) throw new Error('noroute');
    S.loops = routes.map((r, i) => prepRoute(G, r, sa, sb, S.start, S.end, i));
    await showResults();
    status(`${S.loops.length} Variante${S.loops.length > 1 ? 'n' : ''} von ${S.startLabel} nach ${S.endLabel} · Luftlinie ${km(d)} km${long ? ' · nur Fern- und Regionalwege' : ''}.`, null, 1);
  }

  // Kurze Touren: vorbereitete Kacheln mit allen Wegen, sonst direkte Overpass-Abfrage
  async function shortNet(keys, fallback) {
    const ix = await Tiles.index();
    return ix ? loadTiles(keys, 'all') : fallback();
  }

  async function showResults() {
    S.sel = -1;
    renderCards();
    await select(0, true);
    for (let k = 1; k < S.loops.length; k++) { const lp = S.loops[k]; if (!lp.ele) { await loadElevation(lp); refreshCard(k); if (S.sel === k) renderDetail(lp); } }
  }

  function prepRoute(G, lp, sa, sb, A, B, idx) {
    let coords = WK.stepsCoords(G, lp.steps);
    const zwA = sa.dist > 25, zwB = sb.dist > 25;
    if (!coords.length) coords = [G.nodeCoord[sa.node]];
    if (zwA) coords = [A].concat(coords);
    if (zwB) coords = coords.concat([B]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + WK.hav(coords[i - 1], coords[i]));
    const segs = WK.segments(G, lp.steps).map(s => ({ ...s, coords: WK.stepsCoords(G, lp.steps.slice(s.from, s.to)) }));
    const rows = [];
    let at = 0;
    if (zwA) { rows.push({ zuweg: 'start', len: sa.dist, coords: [A, G.nodeCoord[sa.node]], at }); at += sa.dist; }
    for (const s of segs) { rows.push({ rel: s.rel, len: s.len, coords: s.coords, at }); at += s.len; }
    if (zwB) rows.push({ zuweg: S.mode === 'loop' ? 'back' : 'end', len: sb.dist, coords: [G.nodeCoord[sb.node], B], at });
    const relSet = [...new Set(segs.map(s => s.rel))];
    const st = WK.routeStats(G, lp.steps);
    const zwLen = (zwA ? sa.dist : 0) + (zwB ? sb.dist : 0);
    st.unknown += zwLen; st.total += zwLen;
    const runs = WK.classRuns(G, lp.steps);
    if (zwA) runs.unshift({ cls: 'none', coords: [A, G.nodeCoord[sa.node]] });
    if (zwB) runs.push({ cls: 'none', coords: [G.nodeCoord[sb.node], B] });
    return { idx, steps: lp.steps, coords, cum, total: cum[cum.length - 1], overlap: lp.overlap, rows, relSet, st, runs, ele: null, up: null, down: null };
  }

  const VAR = 'ABCDEFGHIJ'.split('');
  const SURF = [
    ['pfad', 'Pfad', '--c-pfad'], ['waldweg', 'Wald-/Feldweg', '--c-waldweg'], ['schotter', 'Schotterweg', '--c-schotter'],
    ['asphalt', 'Asphalt/Pflaster', '--c-asphalt'], ['unbekannt', 'Unbekannt', '--c-unbekannt']
  ];
  const CLS = Object.fromEntries(SURF.map(x => [x[0], x[2]])); CLS.none = '--c-unbekannt';
  const pct = (x, t) => t > 0 ? Math.round(100 * x / t) : 0;
  // Anteile so runden, dass sie zusammen genau 100 % ergeben (größter Rest)
  function shares100(st) {
    const t = st.total || 1;
    const raw = SURF.map(([k]) => 100 * st[k] / t);
    const out = raw.map(Math.floor); let rest = 100 - out.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { out[i]++; rest--; } });
    return SURF.map(([k, label, color], i) => ({ k, label, color, p: out[i] }));
  }

  // Mini-Karte: OSM-Kacheln als SVG-Bilder plus Route nach Wegeart eingefärbt
  function miniMap(lp) {
    const W = 300, H = 170, pad = 14;
    const lats = lp.coords.map(c => c[0]), lons = lp.coords.map(c => c[1]);
    const n = Math.max(...lats), s_ = Math.min(...lats), e = Math.max(...lons), w = Math.min(...lons);
    const wx = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
    const wy = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z; };
    let z = 15;
    while (z > 4 && (wx(e, z) - wx(w, z) > W - 2 * pad || wy(s_, z) - wy(n, z) > H - 2 * pad)) z--;
    const cx = (wx(e, z) + wx(w, z)) / 2, cy = (wy(s_, z) + wy(n, z)) / 2;
    const ox = cx - W / 2, oy = cy - H / 2;
    let imgs = '';
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++)
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++)
        imgs += `<image href="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" x="${(tx * 256 - ox).toFixed(1)}" y="${(ty * 256 - oy).toFixed(1)}" width="256" height="256"/>`;
    const pt = c => (wx(c[1], z) - ox).toFixed(1) + ',' + (wy(c[0], z) - oy).toFixed(1);
    const path = c => c.map(pt).join(' ');
    const halo = `<polyline points="${path(lp.coords)}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lines = lp.runs.map(r => `<polyline points="${path(r.coords)}" fill="none" stroke="var(${CLS[r.cls]})" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"${r.cls === 'none' ? ' stroke-dasharray="4 4"' : ''}/>`).join('');
    const [sx, sy] = pt(lp.coords[0]).split(','), [ex, ey] = pt(lp.coords[lp.coords.length - 1]).split(',');
    const marks = `<circle cx="${sx}" cy="${sy}" r="5.5" fill="var(--forest)" stroke="#fff" stroke-width="2"/>` + (S.mode === 'ab' ? `<circle cx="${ex}" cy="${ey}" r="5.5" fill="var(--blaze)" stroke="#fff" stroke-width="2"/>` : '');
    return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="${W}" height="${H}" fill="var(--surface-2)"/><g class="tiles">${imgs}</g>${halo}${lines}${marks}</svg>`;
  }
  function mixBar(sh) {
    return `<div class="mix" aria-hidden="true">${sh.filter(x => x.p).map(x => `<i style="width:${x.p}%;background:var(${x.color})"></i>`).join('')}</div>`;
  }
  function cardHTML(lp, i) {
    const time = WK.walkTime(lp.total / 1000, lp.up || 0, lp.down || 0);
    const st = lp.st, sh = shares100(st);
    return `${miniMap(lp)}
      <div class="cbody">
        <div class="ctop"><span class="v">${VAR[lp.idx]}</span><span class="km">${km(lp.total)}<small> km</small></span></div>
        <div class="meta">${fmtTime(time)} h${lp.up != null ? ` · ${nf0.format(lp.up)} Hm` : ''}${st.hasForestData ? ` · <span class="wald">${pct(st.forestAny, st.total)} % im Wald</span>` : ''}</div>
        ${mixBar(sh)}
        <ul class="surf">${sh.map(x => `<li${x.p ? '' : ' class="zero"'}><i style="background:var(${x.color})"></i>${x.label}<b>${x.p} %</b></li>`).join('')}</ul>
      </div>`;
  }
  function sortedIdx() {
    const ix = S.loops.map((_, i) => i);
    const nat = lp => (lp.st.forestAny + lp.st.pfad * 1.2 + lp.st.waldweg + lp.st.schotter * 0.6 - lp.st.asphalt) / lp.st.total;
    if (S.sort === 'nature') ix.sort((a, b) => nat(S.loops[b]) - nat(S.loops[a]));
    else if (S.sort === 'short') ix.sort((a, b) => S.loops[a].total - S.loops[b].total);
    else if (S.sort === 'flat') ix.sort((a, b) => (S.loops[a].up ?? 1e9) - (S.loops[b].up ?? 1e9));
    return ix;
  }
  function renderCards() {
    const el = $('results'); el.hidden = false;
    const n = S.loops.length;
    el.innerHTML = `<div class="rhead"><b>${n} Variante${n > 1 ? 'n' : ''}</b>
        <label class="sortl" for="sortSel">Sortieren
        <select id="sortSel"><option value="best">Empfohlen</option><option value="nature">Meiste Natur</option><option value="short">Kürzeste</option><option value="flat">Wenigste Höhenmeter</option></select></label></div>
      <div class="legend">${SURF.map(x => `<span><i style="background:var(${x[2]})"></i>${x[1]}</span>`).join('')}</div>
      <div class="cards" id="cards">${sortedIdx().map(i => `<button class="card" type="button" data-i="${i}" aria-pressed="${i === S.sel}">${cardHTML(S.loops[i], i)}</button>`).join('')}</div>`;
    const sel = $('sortSel'); sel.value = S.sort;
    sel.onchange = () => { S.sort = sel.value; renderCards(); };
    $('cards').onclick = e => { const b = e.target.closest('.card'); if (b) { select(+b.dataset.i, true); if (window.innerWidth < 900) { $('sheet').classList.remove('expanded'); $('grip').setAttribute('aria-expanded', 'false'); } } };
  }
  const fmtTime = h => { const m = Math.round(h * 60 / 5) * 5; return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };

  function drawLoops() {
    loopLayer.clearLayers();
    wmt.setOpacity(0.45);
    if (hl) { map.removeLayer(hl); hl = null; }
    S.loops.forEach((lp, i) => {
      if (i === S.sel) return;
      L.polyline(lp.coords, { color: css('--route'), weight: 3, opacity: 0.45, dashArray: '6 7' }).on('click', () => select(i, false)).addTo(loopLayer);
    });
    const lp = S.loops[S.sel];
    L.polyline(lp.coords, { color: '#ffffff', weight: 10, opacity: 0.95, interactive: false }).addTo(loopLayer);
    for (const r of lp.runs) L.polyline(r.coords, { color: css(CLS[r.cls]), weight: 6, opacity: 1, interactive: false, dashArray: r.cls === 'none' ? '6 6' : null }).addTo(loopLayer);
    // Richtungspfeile alle ~1,5 km
    const step = Math.max(800, lp.total / 10);
    for (let d = step / 2; d < lp.total; d += step) {
      const p = pointAt(lp, d), q = pointAt(lp, d + 15);
      const ang = WK.bearing(p, q);
      L.marker(p, { interactive: false, icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: `<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(${ang}deg)"><path d="M7 1L12 12L7 9L2 12Z" fill="${css('--route')}" stroke="#fff" stroke-width="1.2"/></svg>` }) }).addTo(loopLayer);
    }
  }

  function pointAt(lp, d) {
    const c = lp.cum; let lo = 0, hi = c.length - 1;
    d = Math.max(0, Math.min(d, c[hi]));
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const t = c[hi] > c[lo] ? (d - c[lo]) / (c[hi] - c[lo]) : 0;
    const a = lp.coords[lo], b = lp.coords[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  async function select(i, fit) {
    if (S.nav) stopNav();
    S.sel = i;
    for (const b of $('results').querySelectorAll('.card')) b.setAttribute('aria-pressed', +b.dataset.i === i);
    drawLoops();
    const lp = S.loops[i];
    if (fit) map.fitBounds(L.latLngBounds(lp.coords), { padding: [24, 24] });
    renderDetail(lp);
    if (!lp.ele) { await loadElevation(lp); if (S.sel === i) renderDetail(lp); refreshCard(i); }
  }
  function refreshCard(i) { const b = $('results').querySelector(`.card[data-i="${i}"]`); if (b) b.innerHTML = cardHTML(S.loops[i], i); }

  function renderDetail(lp) {
    const G = S.G; const el = $('detail'); el.hidden = false;
    const time = WK.walkTime(lp.total / 1000, lp.up || 0, lp.down || 0);
    const rows = lp.rows.map((r, k) => {
      if (r.zuweg) return `<li class="seg zuweg" tabindex="0" data-k="${k}"><span class="at">km ${km(r.at)}</span><span class="zw" aria-hidden="true"></span><span class="nm"><b>${r.zuweg === 'start' ? 'Zuweg zum Wegenetz' : r.zuweg === 'back' ? 'Rückweg zum Start' : 'Weg zum Ziel'}</b><span>ohne Markierung, Luftlinie</span></span><span class="len">${km(r.len)} km</span></li>`;
      const t = G.rels.get(r.rel).tags; const lb = WK.routeLabel(t);
      const sub = [lb.ref, WK.NET_LABEL[t.network]].filter(Boolean).map(esc).join(' · ');
      return `<li class="seg" tabindex="0" data-k="${k}"><span class="at">km ${km(r.at)}</span>${WK.osmcSVG(t, 22)}<span class="nm"><b>${esc(lb.title)}</b><span>${sub}</span></span><span class="len">${km(r.len)} km</span></li>`;
    }).join('');
    el.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${km(lp.total)}</b><span>km</span></div>
        <div class="stat"><b>${lp.up != null ? nf0.format(lp.up) : '…'}</b><span>Hm auf</span></div>
        <div class="stat"><b>${lp.down != null ? nf0.format(lp.down) : '…'}</b><span>Hm ab</span></div>
        <div class="stat"><b>${fmtTime(time)}</b><span>Std.</span></div>
      </div>
      <div class="shares">
        <h3 class="h3">Wegbeschaffenheit</h3>
        ${mixBar(shares100(lp.st))}
        <ul class="surf big">${shares100(lp.st).map(x => `<li${x.p ? '' : ' class="zero"'}><i style="background:var(${x.color})"></i>${x.label}<b>${x.p} % · ${km(lp.st[x.k] + (x.k === 'unbekannt' ? lp.total - lp.st.total : 0))} km</b></li>`).join('')}</ul>
        ${lp.st.hasForestData ? `<p class="note"><span class="wald">${pct(lp.st.forestAny, lp.st.total)} % der Strecke führen durch Wald</span> (unabhängig von der Wegart).</p>` : ''}
      </div>
      <div>${profileSVG(lp)}</div>
      <h3 class="h3">Wegabschnitte · Variante ${VAR[lp.idx]}</h3>
      <ul class="segs" id="segs">${rows}</ul>
      ${lp.total > 30000 ? `<p class="note">Mehrtagestour: bei etwa 20 km pro Tag ${Math.ceil(lp.total / 20000)} Etappen. Übernachtungsorte entlang der Strecke bitte selbst prüfen.</p>` : ''}
      ${lp.overlap > 50 && S.mode === 'loop' ? `<p class="note">${km(lp.overlap)} km werden doppelt gegangen (Hin- und Rückweg auf demselben Stück).</p>` : ''}
      <div class="actions">
        <button class="btn" type="button" id="btnNav"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l7 19-7-4-7 4z"/></svg>Navigation starten</button>
        <button class="btn" type="button" id="btnGpx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>GPX speichern</button>
      </div>`;
    const ul = $('segs');
    const pick = li => { if (!li) return; const r = lp.rows[+li.dataset.k]; highlight(r.coords); };
    ul.onclick = e => pick(e.target.closest('.seg'));
    ul.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e.target.closest('.seg')); } };
    $('btnGpx').onclick = () => gpx(lp);
    $('btnNav').onclick = () => startNav(lp);
  }

  let hl = null;
  function highlight(coords) {
    if (hl) map.removeLayer(hl);
    hl = L.polyline(coords, { color: css('--sign'), weight: 10, opacity: 0.85, interactive: false }).addTo(map);
    map.fitBounds(hl.getBounds(), { padding: [40, 40], maxZoom: 16 });
    if (window.innerWidth < 900) $('sheet').classList.remove('expanded');
  }

  /* ---------- Höhen ---------- */
  async function loadElevation(lp) {
    const N = Math.min(800, Math.max(100, Math.round(lp.total / 250 / 100) * 100)); const pts = [];
    for (let k = 0; k < N; k++) pts.push(pointAt(lp, lp.total * k / (N - 1)));
    try {
      const e = [];
      for (let c = 0; c < N; c += 100) {
        const part = pts.slice(c, c + 100);
        const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + part.map(p => p[0].toFixed(5)).join(',') + '&longitude=' + part.map(p => p[1].toFixed(5)).join(',');
        const r = await fetch(url); if (!r.ok) throw new Error(r.status);
        const j = await r.json(); if (!j.elevation || j.elevation.length !== part.length) throw new Error('ele');
        e.push(...j.elevation);
      }
      const sm = e.map((v, k) => (e[Math.max(0, k - 1)] + v + e[Math.min(N - 1, k + 1)]) / 3);
      let up = 0, down = 0;
      for (let k = 1; k < N; k++) { const d = sm[k] - sm[k - 1]; if (d > 0) up += d; else down -= d; }
      lp.ele = e.map((v, k) => ({ d: lp.total * k / (N - 1), h: v, ll: pts[k] }));
      lp.up = Math.round(up / 5) * 5; lp.down = Math.round(down / 5) * 5;
    } catch (err) { lp.ele = []; }
  }

  function profileSVG(lp) {
    if (!lp.ele) return '<p class="note">Höhenprofil wird geladen …</p>';
    if (!lp.ele.length) return '<p class="note">Höhendaten gerade nicht verfügbar.</p>';
    const W = 340, H = 96, pl = 30, pr = 6, pt = 8, pb = 16;
    const hs = lp.ele.map(p => p.h); let mn = Math.min(...hs), mx = Math.max(...hs);
    const span = Math.max(40, mx - mn); const pad = span * 0.1; mn -= pad; mx = mn + span + 2 * pad;
    const x = d => pl + d / lp.total * (W - pl - pr);
    const y = h => pt + (1 - (h - mn) / (mx - mn)) * (H - pt - pb);
    const line = lp.ele.map((p, k) => (k ? 'L' : 'M') + x(p.d).toFixed(1) + ' ' + y(p.h).toFixed(1)).join('');
    const area = line + `L${x(lp.total).toFixed(1)} ${H - pb}L${pl} ${H - pb}Z`;
    const lo = Math.min(...hs), hi = Math.max(...hs);
    const ticks = [lo, hi].map(h => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(h).toFixed(1)}" y2="${y(h).toFixed(1)}"/><text x="${pl - 4}" y="${(y(h) + 3).toFixed(1)}" text-anchor="end">${nf0.format(h)}</text>`).join('');
    const kmTicks = []; const stepKm = lp.total > 120000 ? 50 : lp.total > 50000 ? 20 : lp.total > 20000 ? 5 : lp.total > 8000 ? 2 : 1;
    for (let d = 0; d <= lp.total / 1000 + 1e-6; d += stepKm) kmTicks.push(`<text x="${x(d * 1000).toFixed(1)}" y="${H - 3}" text-anchor="middle">${d}</text>`);
    return `<svg class="profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="Höhenprofil von ${nf0.format(lo)} bis ${nf0.format(hi)} m"><text x="${pl - 4}" y="${pt - 1}" text-anchor="end">m</text>${ticks}<path class="area" d="${area}"/><path class="ln" d="${line}"/>${kmTicks.join('')}</svg>`;
  }

  /* ---------- GPX ---------- */
  function gpx(lp) {
    const name = S.mode === 'loop' ? `Wander-Routenplaner ${km(lp.total)} km – Rundkurs ab ${S.startLabel}` : `Wander-Routenplaner ${km(lp.total)} km – ${S.startLabel} nach ${S.endLabel}`;
    const pts = lp.coords.map(c => `<trkpt lat="${c[0].toFixed(6)}" lon="${c[1].toFixed(6)}"/>`).join('\n');
    const desc = lp.rows.map(r => r.zuweg ? `ohne Markierung ${km(r.len)} km` : `${WK.routeLabel(S.G.rels.get(r.rel).tags).title} ${km(r.len)} km`).join(' | ');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wander-Routenplaner" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name><desc>${esc(desc)}</desc><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>\n<trk><name>${esc(name)}</name><desc>${esc(desc)}</desc><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
    const blob = new Blob([xml], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `wanderroute-${nf1.format(lp.total / 1000).replace(',', '-')}km.gpx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- Navigation ---------- */
  function startNav(lp) {
    if (!navigator.geolocation) return status('Dieses Gerät stellt keinen Standort bereit.', 'err');
    S.nav = { lp, last: 0, follow: true };
    $('navbar').hidden = false; $('sheet').classList.remove('expanded');
    $('navBig').textContent = `0,0 / ${km(lp.total)} km`; $('navSub').textContent = 'GPS wird gesucht …';
    startWatch();
    if (S.gpsLL) navUpdate(S.gpsLL, S.gpsAcc);
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { S.wake = w; }).catch(() => { });
  }
  function stopNav() {
    S.nav = null; $('navbar').hidden = true;
    if (S.wake) { S.wake.release().catch(() => { }); S.wake = null; }
  }
  $('navStop').onclick = stopNav;
  $('navCenter').onclick = () => { if (!S.nav) return; S.nav.follow = true; if (S.gpsLL) map.setView(S.gpsLL, Math.max(map.getZoom(), 16)); };
  map.on('dragstart', () => { if (S.nav) S.nav.follow = false; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.nav && navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { S.wake = w; }).catch(() => { });
  });

  function navUpdate(ll, acc) {
    const n = S.nav; const lp = n.lp;
    const lat0 = ll[0] * Math.PI / 180; const kx = 111320 * Math.cos(lat0), ky = 110540;
    const px = 0, py = 0;
    let bestAny = { d: Infinity, at: 0 }, bestNear = null;
    for (let i = 1; i < lp.coords.length; i++) {
      const a = lp.coords[i - 1], b = lp.coords[i];
      const ax = (a[1] - ll[1]) * kx, ay = (a[0] - ll[0]) * ky, bx = (b[1] - ll[1]) * kx, by = (b[0] - ll[0]) * ky;
      const dx = bx - ax, dy = by - ay; const L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy; const d = Math.hypot(cx, cy);
      const at = lp.cum[i - 1] + t * (lp.cum[i] - lp.cum[i - 1]);
      if (d < bestAny.d) bestAny = { d, at };
      if (d < 40 + (acc || 0) * 0.5 && at >= n.last - 300) { if (!bestNear || Math.abs(at - n.last) < Math.abs(bestNear.at - n.last)) bestNear = { d, at }; }
    }
    const m = bestNear || bestAny;
    const off = m.d > Math.max(50, (acc || 0));
    if (!off) n.last = m.at;
    const row = lp.rows.filter(r => r.at <= m.at + 1).pop();
    const rowName = row ? (row.zuweg ? 'Zuweg ohne Markierung' : WK.routeLabel(S.G.rels.get(row.rel).tags).title) : '';
    $('navBig').textContent = `${km(n.last)} / ${km(lp.total)} km`;
    $('navSub').innerHTML = off
      ? `<span class="off">Abseits der Route · ${nf0.format(m.d)} m</span>`
      : `noch ${km(lp.total - n.last)} km · ${esc(rowName)}`;
    if (n.follow) map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
  }

  /* ---------- Wegenetz auf dem Gerät ---------- */
  async function refreshOffline() {
    const keys = (await Tiles.storedKeys()).filter(k => /^(all|long):/.test(k)); const reg = new Set(Tiles.tilesRegion());
    const n = set => keys.filter(k => k.startsWith(set + ':') && reg.has(k.slice(set.length + 1))).length;
    const ix = await Tiles.index();
    const all = keys.filter(k => k.startsWith('all:')).length, lng = keys.filter(k => k.startsWith('long:')).length;
    $('offInfo').textContent = `${ix ? `Wegenetz für ganz Deutschland, aufbereitet am ${new Date(ix.gen).toLocaleDateString('de-DE')} aus OpenStreetMap und monatlich aktualisiert. Geladene Gebiete bleiben auf diesem Gerät gespeichert. ` : 'Aufbereitetes Wegenetz gerade nicht erreichbar – die App fragt OpenStreetMap direkt ab. '}Gespeichert: ${all + lng} Kacheln, davon ${n('all') + n('long')} der Heimatregion Köln bis Sauerland, Eifel, Mosel und Rhein (${reg.size * 2} insgesamt). Gespeichert funktioniert die Tourenplanung auch ohne Netz; Karte und Höhenprofil brauchen weiter Internet.`;
  }
  $('btnPreload').onclick = async () => {
    const b = $('btnPreload');
    if (S.busy) { S.cancel = true; return; }
    S.busy = true; S.cancel = false; b.textContent = 'Abbrechen';
    try {
      const t0 = performance.now();
      const keys = Tiles.tilesRegion(); let failed = 0;
      for (const [k, set] of [[0, 'long'], [1, 'all']]) {
        if (S.cancel) break;
        const r = await Tiles.load(keys, set, p => status(`Speichere Region (${k + 1}/2, ${set === 'long' ? 'Fern- und Regionalwege' : 'alle Wege'}): Kachel ${p.done} von ${p.total}${p.cached ? ` (${p.cached} schon vorhanden)` : ''}${p.failed ? `, ${p.failed} fehlgeschlagen` : ''} · ${Math.round((performance.now() - t0) / 1000)} s`, null, (k + p.done / p.total) / 2), () => S.cancel);
        failed += r.failed;
      }
      const res = { failed };
      status(S.cancel ? 'Abgebrochen. Bereits geladene Kacheln bleiben gespeichert.' : res.failed ? `${res.failed} Kacheln konnten nicht geladen werden. Später erneut auf „Heimatregion speichern“ tippen, dann werden nur die fehlenden geladen.` : 'Heimatregion gespeichert. Touren dort werden jetzt ohne Wartezeit berechnet.', res.failed ? 'err' : null, 1);
    } finally { S.busy = false; S.cancel = false; b.textContent = 'Heimatregion speichern'; refreshOffline(); }
  };
  $('btnClear').onclick = async () => {
    if ($('btnClear').dataset.confirm !== '1') { $('btnClear').dataset.confirm = '1'; $('btnClear').textContent = 'Wirklich leeren?'; setTimeout(() => { $('btnClear').dataset.confirm = ''; $('btnClear').textContent = 'Speicher leeren'; }, 4000); return; }
    await Tiles.clear(); if (S.loaded && S.loaded.tiles) S.loaded = null;
    $('btnClear').dataset.confirm = ''; $('btnClear').textContent = 'Speicher leeren';
    refreshOffline(); status('Gespeichertes Wegenetz gelöscht.');
  };
  refreshOffline();

  /* ---------- Start ---------- */
  const r0 = REGIONS.find(r => r.id === S.region) || REGIONS[2];
  setStart(r0.ll, `${r0.name} · ${r0.place}`, 'region');
  map.setView(r0.ll, 13);
  setMode(S.mode);
  // Bereits erteilte Standortfreigabe still nutzen
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') startWatch(); }).catch(() => { });
  }
})();
