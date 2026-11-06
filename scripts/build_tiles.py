#!/usr/bin/env python3
"""Wander-Routenplaner – bereitet markierte Wanderwege aus einer OSM-Datei in Kacheln auf.

Eingabe: .osm.pbf (oder .osm), idealerweise schon auf route=hiking/foot gefiltert.
Ausgabe: <out>/index.json, <out>/all/<i>_<j>.json.gz, <out>/long/<i>_<j>.json.gz

Kachelformat (wie im Client data.js):
  {"v":3,"rels":[{"id":..,"tags":{..}}],"ways":[{"id":..,"routes":[..],"c":[lat,lon,..],"j":[idx,nodeId,..],"s":0|1|2,"f":0..100}]}
  s = Belag (1 unbefestigt, 2 befestigt/asphaltiert, 0 unbekannt), f = Anteil der Strecke im Wald in Prozent
  j = Teilungspunkte des Weges (Kreuzungen mit anderen markierten Wegen und Wegenden), global berechnet.
"""
import argparse, gzip, json, math, os, sys, time
from collections import defaultdict
import osmium
try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None

TLAT, TLON = 0.1, 0.15
KEEP = ['name', 'name:de', 'ref', 'network', 'osmc:symbol', 'colour', 'operator', 'from', 'to', 'distance', 'website', 'symbol']
LONG_NETS = {'rwn', 'nwn', 'iwn'}
UNPAVED = {'unpaved', 'compacted', 'fine_gravel', 'gravel', 'dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'woodchips',
           'pebblestone', 'rock', 'forest_floor', 'grass_paver', 'shells', 'snow', 'stepping_stones'}
PAVED = {'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone',
         'unhewn_cobblestone', 'metal', 'wood', 'bricks', 'chipseal'}
PAVED_HW = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
            'service', 'pedestrian', 'cycleway', 'primary_link', 'secondary_link', 'tertiary_link'}
UNPAVED_HW = {'path', 'bridleway'}


def surface_class(tags):
    s = (tags.get('surface') or '').split(';')[0].strip()
    if s in UNPAVED: return 1
    if s in PAVED: return 2
    tt = tags.get('tracktype')
    if tt == 'grade1': return 2
    if tt in ('grade2', 'grade3', 'grade4', 'grade5'): return 1
    hw = tags.get('highway')
    if hw == 'track' or hw in UNPAVED_HW: return 1
    if hw in PAVED_HW: return 2
    return 0


class Forest(osmium.SimpleHandler):
    """Rastert Wald- und Gehölzflächen (landuse=forest, natural=wood) auf ein ca. 85-m-Gitter."""
    def __init__(self, bbox, res_lat=0.0008, res_lon=0.0012):
        super().__init__()
        self.s, self.w, self.n, self.e = bbox
        self.rl, self.ro = res_lat, res_lon
        self.W = int((self.e - self.w) / res_lon) + 1
        self.H = int((self.n - self.s) / res_lat) + 1
        self.img = Image.new('1', (self.W, self.H), 0)
        self.draw = ImageDraw.Draw(self.img)
        self.count = 0

    def px(self, loc):
        return ((loc.lon - self.w) / self.ro, (self.n - loc.lat) / self.rl)

    def area(self, a):
        t = a.tags
        if t.get('landuse') != 'forest' and t.get('natural') != 'wood':
            return
        try:
            for outer in a.outer_rings():
                pts = [self.px(n.location) for n in outer]
                if len(pts) >= 3:
                    self.draw.polygon(pts, fill=1)
                for inner in a.inner_rings(outer):
                    ip = [self.px(n.location) for n in inner]
                    if len(ip) >= 3:
                        self.draw.polygon(ip, fill=0)
            self.count += 1
        except Exception:
            pass

    def finish(self):
        self.pix = self.img.load()

    def inside(self, lat, lon):
        x = int((lon - self.w) / self.ro); y = int((self.n - lat) / self.rl)
        if 0 <= x < self.W and 0 <= y < self.H:
            return self.pix[x, y] != 0
        return False


def forest_share(fr, cs):
    """Anteil der Weglänge im Wald, Stichproben alle ca. 30 m."""
    if fr is None:
        return -1
    tot = inn = 0.0
    for k in range(2, len(cs), 2):
        la0, lo0, la1, lo1 = cs[k - 2], cs[k - 1], cs[k], cs[k + 1]
        d = math.hypot((la1 - la0) * 111000, (lo1 - lo0) * 111000 * math.cos(math.radians(la0)))
        n = max(1, int(d / 30))
        for q in range(n):
            t = (q + 0.5) / n
            if fr.inside(la0 + (la1 - la0) * t, lo0 + (lo1 - lo0) * t):
                inn += d / n
        tot += d
    return int(round(100 * inn / tot)) if tot > 0 else 0


class Rels(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.rels = {}            # id -> tags
        self.way_rels = defaultdict(list)

    def relation(self, r):
        t = r.tags
        if t.get('type') not in ('route', 'superroute') or t.get('route') not in ('hiking', 'foot'):
            return
        if t.get('type') == 'superroute':
            return
        tags = {k: t.get(k) for k in KEEP if t.get(k) is not None}
        if 'network' not in tags:
            tags['network'] = 'lwn'
        self.rels[r.id] = tags
        for m in r.members:
            if m.type == 'w':
                lst = self.way_rels[m.ref]
                if r.id not in lst:
                    lst.append(r.id)


class Ways(osmium.SimpleHandler):
    def __init__(self, wanted):
        super().__init__()
        self.wanted = wanted
        self.ways = {}            # id -> (node ids, coords)
        self.surf = {}

    def way(self, w):
        if w.id not in self.wanted:
            return
        ids, cs = [], []
        for n in w.nodes:
            if not n.location.valid():
                return
            ids.append(n.ref)
            cs.append(round(n.location.lat, 5))
            cs.append(round(n.location.lon, 5))
        if len(ids) >= 2:
            self.ways[w.id] = (ids, cs)
            self.surf[w.id] = surface_class(w.tags)


def tile_of(lat, lon):
    return math.floor(lat / TLAT), math.floor(lon / TLON)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('out')
    ap.add_argument('--bbox', help='S,W,N,E – nur Kacheln in diesem Rechteck schreiben')
    ap.add_argument('--forest', help='OSM-Datei mit Wald-/Gehölzflächen')
    a = ap.parse_args()
    t0 = time.time()

    rh = Rels(); rh.apply_file(a.input)
    print(f'{len(rh.rels)} Wanderrouten, {len(rh.way_rels)} Wege referenziert', flush=True)
    wh = Ways(set(rh.way_rels)); wh.apply_file(a.input, locations=True, idx='flex_mem')
    print(f'{len(wh.ways)} Wege mit Geometrie', flush=True)

    fr = None
    if a.forest and Image is not None and wh.ways:
        lats = [c for _, cs in wh.ways.values() for c in cs[0::2]]
        lons = [c for _, cs in wh.ways.values() for c in cs[1::2]]
        fr = Forest((min(lats) - 0.05, min(lons) - 0.05, max(lats) + 0.05, max(lons) + 0.05))
        fr.apply_file(a.forest, locations=True, idx='flex_mem')
        fr.finish()
        print(f'{fr.count} Waldflächen gerastert ({fr.W} × {fr.H})', flush=True)

    # Kreuzungen: Knoten, die in mehreren Wegen vorkommen, plus Wegenden
    use = defaultdict(int)
    for ids, _ in wh.ways.values():
        for k, n in enumerate(ids):
            use[n] += 2 if k in (0, len(ids) - 1) else 1

    bbox = [float(x) for x in a.bbox.split(',')] if a.bbox else None
    tiles = {'all': defaultdict(list), 'long': defaultdict(list)}
    for wid, (ids, cs) in wh.ways.items():
        routes = [r for r in rh.way_rels[wid] if r in rh.rels]
        if not routes:
            continue
        j = []
        for k, n in enumerate(ids):
            if k == 0 or k == len(ids) - 1 or use[n] > 1:
                j += [k, n]
        keys = set()
        for k in range(0, len(cs), 2):
            keys.add(tile_of(cs[k], cs[k + 1]))
            if k >= 2:  # lange Segmente: alle überstrichenen Kacheln
                i0, j0 = tile_of(cs[k - 2], cs[k - 1]); i1, j1 = tile_of(cs[k], cs[k + 1])
                if (i0, j0) != (i1, j1):
                    for ii in range(min(i0, i1), max(i0, i1) + 1):
                        for jj in range(min(j0, j1), max(j0, j1) + 1):
                            keys.add((ii, jj))
        long_routes = [r for r in routes if rh.rels[r].get('network') in LONG_NETS]
        sc, fs = wh.surf.get(wid, 0), forest_share(fr, cs)
        rec = {'id': wid, 'routes': routes, 'c': cs, 'j': j, 's': sc, 'f': fs}
        rec_long = {'id': wid, 'routes': long_routes, 'c': cs, 'j': j, 's': sc, 'f': fs} if long_routes else None
        for key in keys:
            if bbox:
                s, w_, n_, e = bbox
                if (key[0] + 1) * TLAT < s or key[0] * TLAT > n_ or (key[1] + 1) * TLON < w_ or key[1] * TLON > e:
                    continue
            tiles['all'][key].append(rec)
            if rec_long:
                tiles['long'][key].append(rec_long)

    os.makedirs(a.out, exist_ok=True)
    index = {'v': 3, 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'tile': [TLAT, TLON], 'sets': {}}
    total = 0
    for name, tl in tiles.items():
        d = os.path.join(a.out, name); os.makedirs(d, exist_ok=True)
        keys = []
        for (i, jx), ways in tl.items():
            rel_ids = sorted({r for w in ways for r in w['routes']})
            doc = {'v': 3, 'rels': [{'id': r, 'tags': rh.rels[r]} for r in rel_ids], 'ways': ways}
            raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            path = os.path.join(d, f'{i}_{jx}.json.gz')
            with open(path, 'wb') as f:
                f.write(gzip.compress(raw, 9, mtime=0))
            total += os.path.getsize(path)
            keys.append(f'{i}_{jx}')
        index['sets'][name] = sorted(keys)
        print(f'{name}: {len(keys)} Kacheln', flush=True)
    if bbox:
        index['bbox'] = bbox
    with open(os.path.join(a.out, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f'fertig in {time.time() - t0:.0f} s, {total / 1e6:.1f} MB komprimiert', flush=True)


if __name__ == '__main__':
    sys.exit(main())
