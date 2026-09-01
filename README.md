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

Open `contact.html` to eyeball N seeds as top-down thumbnails at once.

## Files

- `index.html` — app shell, controls, poster chrome overlay
- `src/rng.js` — seeded RNG (namespaced streams per subsystem)
- `src/model.js` — CityModel generation (engine switch, land, rail, V1 BSP fabric, life)
- `src/common.js` — density tables, zoning, massing grammar shared by both engines
- `src/geography.js` — pure geographic-to-local projection and viewport cropping
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
  (`seed + ':city'`, `':ink'`, `':meta'`, …) so the same seed always
  reproduces the same city in every renderer.

## License

MIT — see [LICENSE](LICENSE).
