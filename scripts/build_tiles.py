#!/usr/bin/env python3
"""Wander-Routenplaner – bereitet markierte Wanderwege aus einer OSM-Datei in Kacheln auf.

Eingabe: .osm.pbf (oder .osm), idealerweise schon auf route=hiking/foot gefiltert.
Ausgabe: <out>/index.json, <out>/all/<i>_<j>.json.gz, <out>/long/<i>_<j>.json.gz

Kachelformat (wie im Client data.js):
  {"v":3,"rels":[{"id":..,"tags":{..}}],"ways":[{"id":..,"routes":[..],"c":[lat,lon,..],"j":[idx,nodeId,..]}]}
  j = Teilungspunkte des Weges (Kreuzungen mit anderen markierten Wegen und Wegenden), global berechnet.
"""
import argparse, gzip, json, math, os, sys, time
from collections import defaultdict
import osmium

TLAT, TLON = 0.1, 0.15
KEEP = ['name', 'name:de', 'ref', 'network', 'osmc:symbol', 'colour', 'operator', 'from', 'to', 'distance', 'website', 'symbol']
LONG_NETS = {'rwn', 'nwn', 'iwn'}


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


def tile_of(lat, lon):
    return math.floor(lat / TLAT), math.floor(lon / TLON)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('out')
    ap.add_argument('--bbox', help='S,W,N,E – nur Kacheln in diesem Rechteck schreiben')
    a = ap.parse_args()
    t0 = time.time()

    rh = Rels(); rh.apply_file(a.input)
    print(f'{len(rh.rels)} Wanderrouten, {len(rh.way_rels)} Wege referenziert', flush=True)
    wh = Ways(set(rh.way_rels)); wh.apply_file(a.input, locations=True, idx='flex_mem')
    print(f'{len(wh.ways)} Wege mit Geometrie', flush=True)

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
        rec = {'id': wid, 'routes': routes, 'c': cs, 'j': j}
        rec_long = {'id': wid, 'routes': long_routes, 'c': cs, 'j': j} if long_routes else None
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
