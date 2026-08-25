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
npm test            # 100 seeds × 8 invariants: planarity, node spacing, simple
                    # faces, area conservation, parcels-in-block, frontage,
                    # water/corridor clearance, determinism
```

Open `contact.html` to eyeball N seeds as top-down thumbnails at once.

## Files

- `index.html` — app shell, controls, poster chrome overlay
- `src/rng.js` — seeded RNG (namespaced streams per subsystem)
- `src/model.js` — CityModel generation (engine switch, land, rail, V1 BSP fabric, life)
- `src/common.js` — density tables, zoning, massing grammar shared by both engines
- `src/geom.js` — geometry kernel: one orientation predicate, quantization, polygon ops
- `src/fields.js` — water SDF, population, direction and exclusion fields
- `src/graph.js` — planar road graph: growth loop, local constraints, face extraction
- `src/blocks.js` — block offset, parcel subdivision, frontage, building fit
- `src/fabric.js` — the graph fabric pipeline (fields → graph → blocks → buildings)
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

- [V2: The Road Graph](docs/V2-ROAD-GRAPH.md) — planar road graph engine
  (implemented; the doc records the design and where it deviates)
- V2.1: polygon building footprints (perimeter blocks), terrain heightfield,
  tensor-field upgrade of `direction()`

## Design rules

- `generateCity()` never touches three.js. Renderers never decide layout.
- Infrastructure (water, rail, landmark) claims its footprint *before*
  buildings are placed — nothing is pasted over the fabric afterwards.
- Every random draw comes from a seeded, namespaced stream
  (`seed + ':city'`, `':ink'`, `':meta'`, …) so the same seed always
  reproduces the same city in every renderer.

## License

MIT — see [LICENSE](LICENSE).
