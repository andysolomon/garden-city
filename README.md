# Garden City — Generative Antitecture City Engine

Procedural city generator with the antitecture specimen-poster identity.
The generator produces a plain-data `CityModel`; renderers consume it.

```
config → seeded RNG → land → rail plan (reserved corridors)
       → fields (water / population / direction)
       → road graph growth (snap · split · extend · min-angle · bridges)
       → faces = blocks → per-edge offset → OBB parcels + frontage → buildings
       → city life  ⇒  CityModel  ⇒  { ink/poster, solid, debug map, PNG export }
```

Five street morphologies come out of the same growth code by swapping the
direction field and growth knobs: MANHATTAN · PARIS · TOKYO · MEDIEVAL ·
ATLANTA (PATTERN in the panel). ENGINE → SUBDIVISION (V1) keeps the old
rectangular generator available.

## Run

ES modules require an HTTP server (opening `index.html` via `file://` won't work):

```sh
./serve.sh          # then open http://localhost:8000
```

## Test

```sh
npm test            # 100 seeds × 9 invariants: planarity, node spacing, simple
                    # faces, area conservation, parcels-in-block, frontage,
                    # water/corridor clearance, corridor chains, determinism
```

## Geographic coordinates

`src/geography.js` provides a pure local projection for future geographic
fixtures; it does not alter procedural city generation. Create a projection
with an origin `{ lon, lat }` or `[lon, lat]`. Geographic coordinates are
longitude/latitude degrees, while projected coordinates are local `[x, z]`
coordinates in metres by default. The configured geographic origin projects to
local `[0, 0]`; positive `x` points east, and geographic north is negative `z`
(south is positive `z`), matching the city's top-down axis. Longitude deltas
wrap across the antimeridian.

The default inclusive crop is the 900 × 900 local viewport, `[-450, 450]` on
both axes. Projection instances expose inverse conversion, sequence projection,
point containment/cropping, and polyline clipping for in-viewport pieces.

`src/geojson.js` adds `normalizeGeoJSON(input, projection)`, a pure
provider-neutral adapter from GeoJSON fixtures to local coordinates. It accepts
a `Feature` or `FeatureCollection` and returns `{ records, diagnostics }`:

```js
import { makeProjection } from './src/geography.js';
import { normalizeGeoJSON } from './src/geojson.js';

const { records, diagnostics } = normalizeGeoJSON(featureCollection, makeProjection([lon, lat]));
```

Each valid feature becomes one record `{ index, sourceId, properties, geometry }`
in source order. `sourceId` is the GeoJSON `feature.id` (including `0`) or
`null` when absent, and `properties` is a copy of the feature's properties, or
`{}`. `LineString` and `MultiLineString` normalize to
`{ type: 'line', parts }`; `Polygon` and `MultiPolygon` normalize to
`{ type: 'polygon', polygons }`, where each polygon is its outer ring followed
by its hole rings. Part, polygon, ring, and coordinate order are all retained,
and every coordinate is a projected local `[x, z]` pair.

Malformed, empty, and unsupported features never abort the collection: each is
skipped with one ordered diagnostic
`{ index, sourceId, geometryType, code, message }`, using the stable codes
`invalid-feature`, `missing-geometry`, `unsupported-geometry`,
`empty-geometry`, and `invalid-coordinate`, while valid siblings still
normalize. Only invalid API-level arguments throw. The adapter is offline and
deterministic — it loads nothing, and it does not clip geometry, classify
features semantically, or alter `generateCity(config)`.

`src/fields.js` exposes `makeImportedWater(records, size = 900)` for normalized
polygon records. It returns `{ kind: 'imported', polygons, shores, isLand, sdf }`.
`polygons` is a retained copy of the polygon/ring nesting; each outer ring is
water minus its land holes, and overlapping polygons form a water union. `sdf`
is positive on land, negative in water, and zero on the union shoreline.
`shores` contains deterministic, point-bounded closed rings or clipped open
in-viewport pieces safe for the road graph. Concave rings keep extra vertices or
split rather than emit a land-cutting chord. This graph-only simplification does
not alter `polygons`, `isLand`, or `sdf`. The same boundary is available through
`makeWater({ kind: 'imported', records }, size)`. This adapter is a pure
boundary helper; geographic-mode generation (below) consumes normalized records
directly.

### Geographic mode

`generateCity({ source: 'geographic', geography: { records, diagnostics? }, ... })`
builds the city from imported roads instead of procedural road growth. It stays
synchronous and seeded. Line records are roads. Normalized polygon records are
classified in this order: a `kind: 'building'` or truthy `building` tag is a
building, where false-like values (`false`, `0`, `off`, `no`, and empty, as
primitives or strings) count as disabled tags; `kind: 'park'` or non-water
`landuse`/`leisure` is park/land use; explicit water tags (same false-like
rule) and all unclassified polygons are water. The final
fallback preserves the prior untagged-polygon-as-water contract. The graph
engine's fabric pipeline (faces → blocks → parcels → frontage → buildings)
runs on the imported graph, so every rendered road or
bridge carries `edge` provenance back to `model.graph.edges[i].sourceIndex`,
`sourceId`, `sourcePart`, and `roadId`. At-grade edges render as roads,
bridges/elevated edges render as bridges, and tunnels/below-grade edges stay in
`model.graph` and `model.corridors` as routing data without surface roads or
caps. Imported polygon water renders with holes in map, ink, and solid as
`model.water` entries `{ type: 'imported', polygon, holes, sourceIndex, sourceId, sourcePart }`.
Each building `MultiPolygon` component becomes one `model.buildings` entry with
`footprint`, the first hole as `courtyard`, rectangle-compatible
`x/z/w/d/cx/cz/angle`, and `sourceIndex`/`sourceId`/`sourcePart`. A finite
positive `height` wins, then a finite positive `building:levels * 3` product
(an overflow to `Infinity` falls through to the fallback); otherwise a
stable source-identity/index/part hash supplies the height without consuming
city RNG. Imported park and land-use components become polygon `model.parks`
entries with the same provenance and a `landUse` marker; the default-visible
PARKS map layer, ink ground fill, and solid ground mesh all consume them.

Imported buildings are accepted only when their complete outer footprint is on
land and misses every reserved rectangle. A building or park outer ring with
non-positive area or a non-simple (self-intersecting) ring is omitted up front
with a deterministic `imported-building-geometry` or `imported-park-geometry`
diagnostic instead of becoming a model entry. Other rejections are
deterministic `model.geography.diagnostics` entries with codes
`imported-building-water` or `imported-building-reserved`. Accepted imported
buildings and parks claim their polygons before procedural geographic massing
is accepted, so generated buildings cannot overlap them. This claim filtering
applies to geographic and hybrid sources. Source records and rings are copied
rather than mutated.

The full numeric importer counters, including diagnostics and derived
bridge/elevated counts, are available at `model.stats.import`; the top-level
`nodes`, `edges`, `faces`, and `corridors` counters used by the UI remain
numeric. `model.geography` exposes `{ diagnostics, stats, upstreamDiagnostics }`.
Imported water is authoritative: a live untagged at-grade road that enters it
beyond the graph's quantization tolerance throws an edge/source-specific
unusable-data error. Source-tagged bridge/elevated crossings remain valid;
tunnel/below-grade edges remain routable. `positionOnRoute()` reports
`bridge`, `elevated`, `belowGrade`, and `tunnel`; ink and solid cars ride decks
when elevated and are hidden from the surface while below grade. Empty,
polygon-only, or otherwise faceless road data throws a recoverable
`geographic source has no usable road faces (...)` error; the next call works
normally. Configs without `source: 'geographic'` or `source: 'hybrid'` follow
the procedural graph or BSP paths unchanged. Provider loading, geocoding UI,
caching, and arbitrary park-hole rendering remain deferred.

### Hybrid mode

`generateCity({ source: 'hybrid', geography: { records, diagnostics? }, ... })`
keeps imported roads, water, and accepted building/park claims authoritative,
then runs the existing face, parcel, massing, tree, traffic, and life systems
on the remaining valid land. It stays synchronous and seeded. Classification,
provenance, water-crossing, missing-face, and BSP-engine errors are the same
as geographic mode. Hybrid rail, fabric/massing, trees, and non-traffic life
draw from `seed + ':hybrid'`; existing `:city`, `:traffic`, and `:noise`
streams are unchanged for geographic and source-omitted configs. Procedural
massing is accepted only outside water, reserved rectangles, and imported
claims. Hybrid procedural parks follow the same exclusions. Trees may populate
accepted imported parks, but remain outside authoritative water, reserved
infrastructure, and imported building footprints. Shared map, ink, solid,
poster, and PNG paths consume the same CityModel with no source-specific
renderer branch.

Open `contact.html` to eyeball N seeds as top-down thumbnails at once.

## Files

- `index.html` — app shell, controls, poster chrome overlay
- `src/rng.js` — seeded RNG (namespaced streams per subsystem)
- `src/model.js` — CityModel generation (engine switch, land, rail, V1 BSP fabric, life)
- `src/common.js` — density tables, zoning, massing grammar shared by both engines
- `src/geography.js` — pure geographic-to-local projection and viewport cropping
- `src/geojson.js` — pure GeoJSON fixture normalization into local records + diagnostics
- `src/geom.js` — geometry kernel: one orientation predicate, quantization, polygon ops
- `src/fields.js` — water SDF, population, direction and exclusion fields
- `src/graph.js` — planar road graph: growth loop, local constraints, face extraction
- `src/blocks.js` — block offset, parcel subdivision, frontage, building fit
- `src/fabric.js` — the graph fabric pipeline (fields → graph → blocks → buildings)
- `src/corridors.js` — named street corridors aggregated from the graph
- `src/presets.js` — morphology presets
- `src/map.js` — top-down debug map renderer with layer toggles
- `contact.html` — contact sheet of N seeds
- `test/invariants.mjs` — invariant harness
- `src/render.js` — shared three.js viewer (ortho camera, orbit, export helper)
- `src/solid.js` — shaded massing renderer
- `src/ink.js` — hidden-line ink renderer + poster overlay text
- `src/poster.js` — print-resolution specimen-sheet PNG export
- `antitecture.html` — original single-file poster generator (legacy, kept as reference)
- `procedural-city-v1.html` — first model/renderer split prototype (legacy)

## Roadmap

- **[ROADMAP.md](ROADMAP.md) — remaining work.** Start here if you are picking
  this up: orientation, the invariants that must not break, and the prioritized
  task list (routing/traffic first).
- [V2: The Road Graph](docs/V2-ROAD-GRAPH.md) — planar road graph engine
  (implemented; the doc records the design and where it deviates)

## Design rules

- `generateCity()` never touches three.js. Renderers never decide layout.
- Infrastructure (water, rail, landmark) claims its footprint *before*
  buildings are placed — nothing is pasted over the fabric afterwards.
- Every random draw comes from a seeded, namespaced stream
  (`seed + ':city'`, `':hybrid'`, `':ink'`, `':meta'`, …) so the same seed always
  reproduces the same city in every renderer.

## License

MIT — see [LICENSE](LICENSE).
