#!/usr/bin/env python3
"""Wander-Routenplaner – bereitet markierte Wanderwege aus einer OSM-Datei in Kacheln auf.

Eingabe: .osm.pbf (oder .osm), idealerweise schon auf route=hiking/foot gefiltert.
Ausgabe: <out>/index.json, <out>/all|long|conn/<i>_<j>.json.gz
  conn = unmarkierte Verbindungswege: {"id","q":[lat·1e5, lon·1e5, Δlat, Δlon, …],"j","s","f"}

Kachelformat (wie im Client data.js):
  {"v":3,"rels":[{"id":..,"tags":{..}}],"ways":[{"id":..,"routes":[..],"c":[lat,lon,..],"j":[idx,nodeId,..],"s":0|1|2,"f":0..100}]}
  s = Wegbeschaffenheit (1 Pfad, 3 Wald-/Feldweg, 4 Schotterweg, 2 Asphalt/Pflaster, 0 unbekannt), f = Anteil der Strecke im Wald in Prozent
  j = Teilungspunkte des Weges (Kreuzungen mit anderen markierten Wegen und Wegenden), global berechnet.
"""
import argparse, gzip, json, math, os, sys, time
from array import array
from collections import defaultdict
import numpy as np
import osmium
try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None

TLAT, TLON = 0.1, 0.15
KEEP = ['name', 'name:de', 'ref', 'network', 'osmc:symbol', 'colour', 'operator', 'from', 'to', 'distance', 'website', 'symbol']
LONG_NETS = {'rwn', 'nwn', 'iwn'}
# Wegbeschaffenheit, Klassen wie im Client:
# 1 Pfad, 3 Wald-/Feldweg, 4 Schotterweg, 2 Asphalt/Pflaster, 0 unbekannt
GRAVEL = {'gravel', 'fine_gravel', 'compacted', 'pebblestone', 'shells', 'grass_paver'}
NATURAL = {'unpaved', 'dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'woodchips', 'rock', 'forest_floor', 'snow',
           'stepping_stones', 'roots'}
PAVED = {'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'cobblestone',
         'unhewn_cobblestone', 'metal', 'wood', 'bricks', 'chipseal'}
PAVED_HW = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
            'service', 'pedestrian', 'cycleway', 'primary_link', 'secondary_link', 'tertiary_link'}
PATH_HW = {'path', 'footway', 'bridleway', 'steps'}


def surface_class(tags):
    hw = tags.get('highway')
    s = (tags.get('surface') or '').split(';')[0].strip()
    if s in PAVED: return 2
    if s in GRAVEL: return 4
    if s in NATURAL: return 1 if hw in PATH_HW else 3
    tt = tags.get('tracktype')
    if tt == 'grade1': return 2
    if tt == 'grade2': return 4
    if tt in ('grade3', 'grade4', 'grade5'): return 3
    if hw == 'track': return 3
    if hw in ('path', 'bridleway'): return 1
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
    """Anteil der Weglänge im Wald, Stichproben alle ca. 50 m."""
    if fr is None:
        return -1
    tot = inn = 0.0
    for k in range(2, len(cs), 2):
        la0, lo0, la1, lo1 = cs[k - 2], cs[k - 1], cs[k], cs[k + 1]
        d = math.hypot((la1 - la0) * 111000, (lo1 - lo0) * 111000 * math.cos(math.radians(la0)))
        n = max(1, int(d / 50))
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


CONN_HW = {'track', 'path', 'footway', 'bridleway', 'pedestrian', 'living_street', 'residential', 'unclassified',
           'service', 'cycleway', 'steps'}
BAD_SERVICE = {'driveway', 'parking_aisle', 'drive-through', 'emergency_access'}


def is_connector(tags):
    """Unmarkierter, zu Fuß nutzbarer Weg (keine Haupt- und Bundesstraßen, keine privaten Wege)."""
    hw = tags.get('highway')
    if hw not in CONN_HW:
        return False
    foot = tags.get('foot')
    if foot == 'no':
        return False
    if tags.get('access') in ('private', 'no') and foot not in ('yes', 'designated', 'permissive'):
        return False
    if hw == 'service' and tags.get('service') in BAD_SERVICE:
        return False
    if tags.get('area') == 'yes':
        return False
    return True


class Ids(osmium.SimpleHandler):
    """Durchgang 1: Knoten-IDs aller genutzten Wege sammeln (für Kreuzungen), plus Ausdehnung."""
    def __init__(self, marked):
        super().__init__()
        self.marked = marked
        self.ids = array('q')
        self.n_marked = self.n_conn = 0

    def way(self, w):
        if w.id in self.marked:
            self.n_marked += 1
        elif is_connector(w.tags):
            self.n_conn += 1
        else:
            return
        for n in w.nodes:
            self.ids.append(n.ref)


class Writer(osmium.SimpleHandler):
    """Durchgang 2: Wege mit Geometrie lesen und kachelweise als JSON-Fragmente auf die Platte schreiben."""
    def __init__(self, rh, junction, fr, out):
        super().__init__()
        self.rh, self.junction, self.fr, self.out = rh, junction, fr, out
        self.buf = defaultdict(list); self.size = defaultdict(int)
        self.tile_rels = {'all': defaultdict(set), 'long': defaultdict(set)}
        self.keys = {'all': set(), 'long': set(), 'conn': set()}

    def emit(self, set_, key, frag):
        k = (set_, key)
        self.buf[k].append(frag); self.size[k] += len(frag)
        self.keys[set_].add(key)
        if self.size[k] > 400000:
            self.flush(k)

    def flush(self, k):
        set_, (i, j) = k
        with open(os.path.join(self.out, 'tmp', f'{set_}_{i}_{j}.part'), 'a') as f:
            f.write(',\n'.join(self.buf[k]) + ',\n')
        self.buf[k] = []; self.size[k] = 0

    def flush_all(self):
        for k in list(self.buf):
            if self.buf[k]:
                self.flush(k)

    def way(self, w):
        marked = w.id in self.rh.way_rels
        if not marked and not is_connector(w.tags):
            return
        ids, cs = [], []
        for n in w.nodes:
            if not n.location.valid():
                return
            ids.append(n.ref); cs.append(round(n.location.lat, 5)); cs.append(round(n.location.lon, 5))
        if len(ids) < 2:
            return
        arr = np.fromiter(ids, dtype=np.int64, count=len(ids))
        pos = np.searchsorted(self.junction, arr)
        pos[pos >= len(self.junction)] = 0
        isj = self.junction[pos] == arr
        isj[0] = True; isj[-1] = True
        sc = surface_class(w.tags)
        if marked:
            routes = [r for r in self.rh.way_rels[w.id] if r in self.rh.rels]
            if not routes:
                return
            j = []
            for k in np.nonzero(isj)[0].tolist():
                j += [k, ids[k]]
            keep_c = cs
        else:
            # Verbindungsweg: Geometrie ausdünnen (Punkte unter ca. 20 m Abstand fallen weg, Kreuzungen bleiben)
            keep_c, j, last = [], [], None
            cosl = math.cos(math.radians(cs[0]))
            for k in range(len(ids)):
                la, lo = cs[2 * k], cs[2 * k + 1]
                if not isj[k] and last is not None and abs(la - last[0]) * 111000 + abs(lo - last[1]) * 111000 * cosl < 20:
                    continue
                if isj[k]:
                    j += [len(keep_c) // 2, ids[k]]
                keep_c += [la, lo]; last = (la, lo)
            routes = []
        fs = forest_share(self.fr, keep_c)
        keys = set()
        for k in range(0, len(keep_c), 2):
            keys.add(tile_of(keep_c[k], keep_c[k + 1]))
            if k >= 2:
                i0, j0 = tile_of(keep_c[k - 2], keep_c[k - 1]); i1, j1 = tile_of(keep_c[k], keep_c[k + 1])
                if (i0, j0) != (i1, j1):
                    for ii in range(min(i0, i1), max(i0, i1) + 1):
                        for jj in range(min(j0, j1), max(j0, j1) + 1):
                            keys.add((ii, jj))
        if marked:
            frag = json.dumps({'id': w.id, 'routes': routes, 'c': keep_c, 'j': j, 's': sc, 'f': fs}, separators=(',', ':'))
            long_routes = [r for r in routes if self.rh.rels[r].get('network') in LONG_NETS]
            frag_l = json.dumps({'id': w.id, 'routes': long_routes, 'c': keep_c, 'j': j, 's': sc, 'f': fs}, separators=(',', ':')) if long_routes else None
            for key in keys:
                self.emit('all', key, frag); self.tile_rels['all'][key].update(routes)
                if frag_l:
                    self.emit('long', key, frag_l); self.tile_rels['long'][key].update(long_routes)
        else:
            # kompakt: Koordinaten als ganzzahlige Differenzen in 1e-5 Grad
            q, pl, po = [], 0, 0
            for k in range(0, len(keep_c), 2):
                a_, b_ = int(round(keep_c[k] * 1e5)), int(round(keep_c[k + 1] * 1e5))
                q += [a_ - pl, b_ - po]; pl, po = a_, b_
            frag = json.dumps({'id': w.id, 'q': q, 'j': j, 's': sc, 'f': fs}, separators=(',', ':'))
            for key in keys:
                self.emit('conn', key, frag)


def tile_of(lat, lon):
    return math.floor(lat / TLAT), math.floor(lon / TLON)


def read_poly(path):
    """Geofabrik-.poly: Liste äußerer Ringe [(lon, lat), …]; Löcher (!) werden ignoriert."""
    rings, cur, hole = [], None, False
    with open(path) as f:
        lines = [l.strip() for l in f if l.strip()]
    for l in lines[1:]:
        if l == 'END':
            if cur is not None:
                if not hole: rings.append(cur)
                cur = None
            continue
        if cur is None:
            hole = l.startswith('!'); cur = []
            continue
        x, y = l.split()[:2]
        cur.append((float(x), float(y)))
    return rings


def covered_tiles(rings, sub=8):
    """Kacheln, die (auch teilweise) im Polygon liegen – per Rasterung mit sub × sub Pixeln je Kachel."""
    pts = [p for r in rings for p in r]
    j0 = math.floor(min(p[0] for p in pts) / TLON); j1 = math.floor(max(p[0] for p in pts) / TLON)
    i0 = math.floor(min(p[1] for p in pts) / TLAT); i1 = math.floor(max(p[1] for p in pts) / TLAT)
    W, H = (j1 - j0 + 1) * sub, (i1 - i0 + 1) * sub
    img = Image.new('1', (W, H), 0); dr = ImageDraw.Draw(img)
    for r in rings:
        dr.polygon([((x / TLON - j0) * sub, (i1 + 1 - y / TLAT) * sub) for x, y in r], fill=1)
    out = []
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            x = (j - j0) * sub; y = (i1 - i) * sub
            if img.crop((x, y, x + sub, y + sub)).getbbox():
                out.append(f'{i}_{j}')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='OSM-Datei mit Wanderrouten und Wegen (route=hiking/foot, highway=…)')
    ap.add_argument('out')
    ap.add_argument('--forest', help='OSM-Datei mit Wald-/Gehölzflächen')
    ap.add_argument('--poly', help='Geofabrik-.poly des abgedeckten Gebiets')
    a = ap.parse_args()
    t0 = time.time()
    os.makedirs(os.path.join(a.out, 'tmp'), exist_ok=True)

    rh = Rels(); rh.apply_file(a.input)
    print(f'{len(rh.rels)} Wanderrouten, {len(rh.way_rels)} Wege referenziert', flush=True)

    ih = Ids(set(rh.way_rels)); ih.apply_file(a.input)
    print(f'{ih.n_marked} markierte Wege, {ih.n_conn} Verbindungswege, {len(ih.ids)} Knotenbezüge', flush=True)
    allids = np.frombuffer(ih.ids, dtype=np.int64)
    u, cnt = np.unique(allids, return_counts=True)
    junction = u[cnt > 1].copy()
    del ih, allids, u, cnt
    print(f'{len(junction)} Kreuzungspunkte ({time.time() - t0:.0f} s)', flush=True)

    fr = None
    if a.forest and Image is not None:
        bb = (47.0, 5.5, 55.2, 15.5)
        if a.poly:
            pts = [p for r in read_poly(a.poly) for p in r]
            bb = (min(p[1] for p in pts) - 0.05, min(p[0] for p in pts) - 0.05, max(p[1] for p in pts) + 0.05, max(p[0] for p in pts) + 0.05)
        fr = Forest(bb)
        fr.apply_file(a.forest, locations=True, idx='flex_mem')
        fr.finish()
        print(f'{fr.count} Waldflächen gerastert ({fr.W} × {fr.H}, {time.time() - t0:.0f} s)', flush=True)

    wr = Writer(rh, junction, fr, a.out)
    wr.apply_file(a.input, locations=True, idx='flex_mem')
    wr.flush_all()
    print(f'Wege geschrieben ({time.time() - t0:.0f} s)', flush=True)

    gen = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    index = {'v': 3, 'generated': gen, 'tile': [TLAT, TLON], 'sets': {}}
    total = 0
    for name in ('all', 'long', 'conn'):
        d = os.path.join(a.out, name); os.makedirs(d, exist_ok=True)
        keys = sorted(wr.keys[name])
        for (i, jx) in keys:
            part = os.path.join(a.out, 'tmp', f'{name}_{i}_{jx}.part')
            with open(part) as f:
                body = f.read().rstrip().rstrip(',')
            os.remove(part)
            rels = sorted(wr.tile_rels[name][(i, jx)]) if name != 'conn' else []
            head = json.dumps({'v': 3, 'gen': gen, 'rels': [{'id': r, 'tags': rh.rels[r]} for r in rels]}, separators=(',', ':'), ensure_ascii=False)
            raw = (head[:-1] + ',"ways":[' + body + ']}').encode('utf-8')
            path = os.path.join(d, f'{i}_{jx}.json.gz')
            with open(path, 'wb') as f:
                f.write(gzip.compress(raw, 9, mtime=0))
            total += os.path.getsize(path)
        index['sets'][name] = [f'{i}_{jx}' for (i, jx) in keys]
        print(f'{name}: {len(keys)} Kacheln', flush=True)
    os.rmdir(os.path.join(a.out, 'tmp'))
    if a.poly and Image is not None:
        index['cover'] = covered_tiles(read_poly(a.poly))
        print(f'abgedeckt: {len(index["cover"])} Kacheln', flush=True)
    with open(os.path.join(a.out, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print(f'fertig in {time.time() - t0:.0f} s, {total / 1e6:.1f} MB komprimiert', flush=True)


if __name__ == '__main__':
    sys.exit(main())
