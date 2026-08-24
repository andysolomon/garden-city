# Garden City — Generative Antitecture City Engine

Procedural city generator with the antitecture specimen-poster identity.
The generator produces a plain-data `CityModel`; renderers consume it.

```
config → seeded RNG → land → rail plan (reserved corridors) → streets/blocks
       → road/water clipping (bridges) → landmark site → parcels → buildings
       → city life  ⇒  CityModel  ⇒  { ink/poster renderer, solid renderer, PNG export }
```

## Run

ES modules require an HTTP server (opening `index.html` via `file://` won't work):

```sh
./serve.sh          # then open http://localhost:8000
```

## Files

- `index.html` — app shell, controls, poster chrome overlay
- `src/rng.js` — seeded RNG (namespaced streams per subsystem)
- `src/model.js` — CityModel generation, no rendering code
- `src/render.js` — shared three.js viewer (ortho camera, orbit, export helper)
- `src/solid.js` — shaded massing renderer
- `src/ink.js` — hidden-line ink renderer + poster overlay text
- `src/poster.js` — print-resolution specimen-sheet PNG export
- `antitecture.html` — original single-file poster generator (legacy, kept as reference)
- `procedural-city-v1.html` — first model/renderer split prototype (legacy)

## Roadmap

- [V2: The Road Graph](docs/V2-ROAD-GRAPH.md) — replacing rectangular
  subdivision with a planar road graph (proposed, not started)

## Design rules

- `generateCity()` never touches three.js. Renderers never decide layout.
- Infrastructure (water, rail, landmark) claims its footprint *before*
  buildings are placed — nothing is pasted over the fabric afterwards.
- Every random draw comes from a seeded, namespaced stream
  (`seed + ':city'`, `':ink'`, `':meta'`, …) so the same seed always
  reproduces the same city in every renderer.
