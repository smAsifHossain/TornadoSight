# Verified data sources

Everything below was probed live on 2026-09-30 before any app code was written.
Every runtime dependency is free, needs no API key, and sends
`Access-Control-Allow-Origin: *`, so the app can be a purely static site with no
server and no operating cost.

## National Weather Service alerts

`https://api.weather.gov/alerts/active?status=actual`

Requires a descriptive `User-Agent`. Returns GeoJSON with a real `Polygon`
geometry per alert. Note that `limit` is **not** a recognised query parameter;
passing it returns 400.

Useful fields on `properties`:

| Field | Use |
| --- | --- |
| `event` | Tornado Warning, Severe Thunderstorm Warning, and the heat/cold/fog/wind/ice warnings the brief asks for |
| `severity`, `certainty`, `urgency` | official CAP triage fields |
| `onset`, `expires`, `ends`, `sent` | validity window |
| `parameters.eventMotionDescription` | storm motion, see below |
| `parameters.tornadoDetection` | OBSERVED or RADAR INDICATED |
| `parameters.windThreat`, `parameters.maxWindGust` | intensity |
| `parameters.hailThreat`, `parameters.maxHailSize` | intensity |
| `parameters.VTEC` | event identity and lifecycle across updates |

### Storm motion

`eventMotionDescription` looks like:

    2026-09-26T04:11:00-00:00...storm...250DEG...19KT...34.65,-102.78

That is time, bearing, speed in knots, and the storm centroid. **The bearing is
the direction the storm is coming _from_**, matching wind convention. Verified
against the narrative text of the same alerts:

| `eventMotionDescription` | Narrative in the same alert |
| --- | --- |
| `259DEG...19KT` | moving east at 25 mph |
| `241DEG...21KT` | moving northeast at 25 mph |
| `264DEG...25KT` | moving east at 30 mph |

So `heading = (bearing + 180) mod 360` and `mph = knots * 1.15078`. The narrative
rounds to the nearest 5 mph; we keep the precise value.

This field is what lets us project the storm forward and compute time to impact
for each facility. Archived alerts are queryable with `start`/`end` on
`/alerts`, which is what Replay mode uses.

## Open-Meteo

`https://api.open-meteo.com/v1/forecast`

Serves the surface variables named in the concept plus the convective parameters
that actually discriminate severe weather: `cape`, `lifted_index`,
`convective_inhibition`.

Use `pressure_msl`, not `surface_pressure`. Surface pressure is station pressure
and varies with elevation, so comparing it across regions is meaningless. A
probe at Wichita returned 961 hPa purely because of altitude.

## Radar

`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`

Iowa Environmental Mesonet NEXRAD base reflectivity as standard XYZ tiles, so it
drops straight into MapLibre as a raster source.

## Basemap

`https://tiles.openfreemap.org/styles/liberty` (vector, no key, no quota), with
Carto raster tiles as a fallback.

## Critical infrastructure

Overpass is **not** used at runtime. Probes returned 406 and 504 within minutes
of each other, and a live demo cannot depend on that. Instead Overpass is called
at build time by `scripts/bake-facilities.mjs`, with retries, and the result is
committed as static shards the app fetches from its own origin. That is faster,
free, rate-limit-proof and works offline.

HIFLD Open is the authoritative emergency-management source and was the first
choice, but its ArcGIS endpoints have moved repeatedly and several returned 400
or empty result sets during probing, so it is not safe as a live dependency
either. The bake script can pull from either source.
