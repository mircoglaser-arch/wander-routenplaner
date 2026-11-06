# Wander-Routenplaner

Web-App für Rundkurse und Start–Ziel-Touren bis 200 km auf offiziell markierten Wanderwegen
(Köln, Bergisches Land, Eifel, Siebengebirge, Sauerland, Mosel, Rhein).

Live: https://wegekreuz.netlify.app

## Aufbau
- `index.html`, `app.js` – Oberfläche, Karte (Leaflet), GPS, Navigation, Höhenprofil, GPX
- `core.js` – Wegenetz als Graph, Rundweg-Suche, Start–Ziel-Routing, Wegabschnitte, Gehzeit (DIN 33466)
- `data.js` – lädt das Wegenetz in Kacheln (0,1° × 0,15°) und speichert sie im Browser (IndexedDB)
- `scripts/build_tiles.py` – erzeugt die Kacheln aus OSM-Daten
- `.github/workflows/data.yml` – lädt monatlich NRW und Rheinland-Pfalz von Geofabrik, filtert die Wanderrouten
  und veröffentlicht die Kacheln auf dem Branch `data`

Kachelsätze: `all` (alle markierten Wanderwege) für Touren bis 30 km, `long` (Fern- und Regionalwege) für längere.
Außerhalb von NRW und Rheinland-Pfalz fragt die App OpenStreetMap direkt über Overpass ab.

Wegedaten © OpenStreetMap-Mitwirkende, ODbL 1.0. Höhen: Open-Meteo (Copernicus DEM). Markierungsebene: Waymarked Trails.
