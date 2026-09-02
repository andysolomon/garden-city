## Implementation Plan

**Story:** W-000001 Add local geographic coordinate projection
**Branch:** `feat/W-000001-add-local-geographic-coordinate-projection`

### Product goal and scope boundaries

Provide a deterministic, provider-independent conversion from geographic longitude/latitude coordinates into the engine's local metre-based `[x, z]` space, plus bounded cropping for the existing approximately 900-unit city viewport. Keep this slice as a pure geometry adapter: it must not fetch data, alter the procedural generator, or add later GeoJSON normalization, imported water, road, renderer, or provider behavior.

The documented convention will be: the configured geographic origin projects to local `(x=0, z=0)`, one local unit is one metre by default, positive `x` points east, and positive `z` points south so geographic north is `-z`, matching the existing top-down map axis. The default crop is the inclusive square `[-CITY_SIZE / 2, CITY_SIZE / 2]` on both local axes.

### Current baseline

- `src/common.js` defines `CITY_SIZE = 900`.
- Existing model geometry uses local `x/z` coordinates and `src/geom.js` uses `[x, z]` polygon points.
- `src/model.js` has procedural `generateCity(config)` and no geographic-source branch; no source configuration must continue to follow the same code path and output.
- No geography projection module or focused geography test exists.
- `npm test` currently runs `test/invariants.mjs` and `test/grade.mjs`.

### Missing capabilities

- A validated local tangent/equirectangular projection anchored at an explicit geographic origin, with deterministic antimeridian-safe longitude deltas and a documented metre/unit scale.
- Helpers for projecting coordinate sequences and rejecting or clipping projected points/lines outside the fixed viewport.
- Focused regression coverage for known metre-scale conversions, latitude scaling, origin stability, antimeridian handling, crop boundaries, determinism, and invalid input.

### Milestones

- [x] **1. Projection foundation**
  - **Goal:** Add the pure `src/geography.js` adapter without coupling it to generation or rendering.
  - **Deliverables:** Earth-radius constant; default viewport constants derived from `CITY_SIZE`; explicit origin validation; deterministic local tangent/equirectangular projection with `x` east and `z` south; optional positive metres-per-unit and viewport-size options; inverse conversion for diagnostics/future import work; sequence helpers using the existing coordinate conventions.
  - **Dependencies:** `src/common.js` only; no RNG or network dependency.
  - **Risks:** Latitude-dependent longitude scale and antimeridian deltas must be stable; no quantization belongs in this module because graph node commits own the existing `QUANTUM = 0.25` rule.
  - **Acceptance criteria:** The module exposes deterministic longitude/latitude projection and bounded cropping, uses the documented origin/unit convention, and supports the default 900-unit viewport.

- [x] **2. Bounded geometry helpers and focused harness**
  - **Goal:** Make viewport handling useful for future geographic fixtures while proving edge behavior now.
  - **Deliverables:** Inclusive point containment/cropping and deterministic line/polyline clipping that returns only in-viewport segments; `test/geography.mjs` with inline geographic fixtures covering equator, non-equatorial longitude scaling, north/south sign, antimeridian, exact crop edges, outside points, crossing/re-entering lines, malformed inputs, and repeated serialization.
  - **Dependencies:** Milestone 1.
  - **Risks:** A line that leaves and re-enters the square must be represented as separate contiguous pieces rather than a false segment through the outside; endpoint tolerances must not move points across the boundary.
  - **Acceptance criteria:** `node test/geography.mjs` verifies known conversions and crop bounds, including a projected fixture bounding box within the configured viewport.

- [x] **3. Regression/documentation integration**
  - **Goal:** Make the new focused test part of the normal gate and make the convention discoverable without changing existing city generation.
  - **Deliverables:** Add `test/geography.mjs` to the `npm test` script; document `src/geography.js` and its metre/origin/axis convention in `README.md`; leave `src/model.js`, renderers, and procedural config behavior untouched.
  - **Dependencies:** Milestones 1–2.
  - **Risks:** Existing tests exercise seeded procedural output broadly, but the untouched model import path is the primary compatibility guarantee; run the full suite after focused tests.
  - **Acceptance criteria:** `npm test` passes and a fixed procedural configuration remains byte-identical before/after the geography module is added.

### Test strategy

- **Unit/focused:** `node test/geography.mjs` imports the public geography API and asserts exact origin, known equatorial and latitude-scaled distances within documented floating-point tolerances, north=`-z`, antimeridian wrapping, inverse round trips, viewport limits, clipping topology, deterministic serialization, and validation errors.
- **Regression:** `npm test` runs the existing invariant and terrain-grade suites plus the geography harness. No network access or live provider is used.
- **Compatibility:** Compare repeated `generateCity()` output for a representative procedural graph configuration and verify the existing suite continues to pass; no model or renderer integration is required in this slice.
- **Manual QA:** Not applicable to this model-only utility; later geographic fabric/provider slices own browser rendering checks.

### Acceptance criteria mapping

| Scenario / Criterion | Task(s) | How Verified |
| --- | --- | --- |
| `src/geography.js` exposes deterministic longitude/latitude projection and bounded cropping | 1, 2 | Public API assertions in `node test/geography.mjs` |
| Projection supports the approximately 900-unit city viewport | 1, 2 | Default bounds derive from `CITY_SIZE`; projected fixture bounding box and edge points are asserted inside/outside |
| Projected coordinates use the documented unit and origin convention | 1, 2, 3 | Origin, metre-scale conversion, latitude scaling, axis-sign, inverse-round-trip, and README convention assertions |
| Procedural generation is unchanged when no geographic source is configured | 3 | `npm test`, unchanged `src/model.js` path, and repeated fixed-config model signature comparison |

### Out-of-scope / deferred

- GeoJSON feature normalization and metadata retention (W-000002).
- Imported water masks and shoreline constraints (W-000003).
- Imported road graph construction, geographic fabric, real footprints, hybrid mode, provider/network loading, UI controls, and renderer changes (W-000004 through W-000008).
- Automatic scale fitting, datum transformations beyond the documented local equirectangular approximation, terrain, and graph-node quantization.

### Immediate next steps

1. Implementation and focused/full verification are complete in the issue worktree.
2. Stage only the issue-scoped implementation and plan artifacts, then commit with Conventional Commits.
3. Open the issue PR with `Closes #36`; leave the worktree for review under `--ship pr`.
