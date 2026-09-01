## Implementation Plan

**Story:** W-000002 Normalize GeoJSON geographic fixtures
**Issue:** #37
**Branch:** `feat/W-000002-normalize-geojson-geographic-fixtures`

### Product goal and scope boundaries

Add a pure provider-neutral boundary adapter that converts GeoJSON fixture features into deterministic local `[x, z]` records using the existing geographic projection. This slice supports line and polygon feature families, retains feature metadata and standard GeoJSON source IDs, and reports unusable features without preventing valid siblings from being processed.

Keep the adapter offline and model-adjacent. It will not fetch provider data, classify provider-specific tags, crop geometry, create water masks or road graphs, alter `generateCity(config)`, or integrate imported records with renderers.

### Current baseline

- `src/geography.js` provides deterministic geographic-to-local projection and viewport helpers from W-000001.
- `src/geom.js` and `src/model.js` use plain `[x, z]` geometry, but no GeoJSON boundary adapter exists.
- `test/geography.mjs` already verifies projection, clipping, input validation, and repeated serialization and is included in `npm test`.
- `README.md` documents the projection contract but not GeoJSON normalization.

### Missing capabilities

- A pure public API for normalizing GeoJSON `FeatureCollection` and `Feature` input.
- One uniform local-coordinate representation for single- and multi-part line/polygon geometries.
- Retention of `feature.id` and copied feature properties on normalized records.
- Ordered diagnostics for invalid, malformed, empty, or unsupported features while valid siblings continue processing.
- Inline fixtures proving all supported geometry families, determinism, and zero network dependency.

### Public contract

Add `normalizeGeoJSON(input, projection)` in `src/geojson.js`.

The return value is:

```js
{
  records: [
    {
      index,                 // source feature order
      sourceId,              // feature.id, including 0; null when absent
      properties,            // copied GeoJSON properties, or {}
      geometry: {
        type: 'line',
        parts: [line, ...],  // LineString and MultiLineString
      }
      // or
      geometry: {
        type: 'polygon',
        polygons: [          // Polygon and MultiPolygon
          [outerRing, ...holeRings],
        ],
      }
    }
  ],
  diagnostics: [
    { index, sourceId, geometryType, code, message }
  ]
}
```

All coordinates are projected local `[x, z]` arrays. Source feature order, part order, polygon order, ring order, and coordinate order are retained. Geometry is not clipped or semantically classified in this slice. Per-feature validation/projection failures become diagnostics with stable codes such as `invalid-feature`, `missing-geometry`, `unsupported-geometry`, `empty-geometry`, and `invalid-coordinate`; only invalid API-level arguments may throw.

### Milestones

- [x] **1. Provider-neutral normalization module**
  - **Goal:** Add the smallest pure adapter between GeoJSON fixtures and existing local model geometry.
  - **Deliverables:** New `src/geojson.js`; `normalizeGeoJSON(input, projection)`; FeatureCollection/Feature extraction; uniform line `parts` and polygon `polygons`; one output record per valid source feature.
  - **Dependencies:** Existing projection methods in `src/geography.js`; no packages or network APIs.
  - **Risks:** GeoJSON nesting is easy to flatten incorrectly; preserve all source ordering and keep polygon rings grouped by polygon.
  - **Acceptance criteria:** LineString, MultiLineString, Polygon, and MultiPolygon all produce correctly projected records.

- [x] **2. Metadata retention and resilient diagnostics**
  - **Goal:** Preserve source context while allowing mixed valid/malformed fixtures to normalize safely.
  - **Deliverables:** Preserve `feature.id` as `sourceId`; shallow-copy `properties`; validate feature/geometry/coordinate structure; catch per-feature projection failures; emit deterministic ordered diagnostics and continue.
  - **Dependencies:** Milestone 1.
  - **Risks:** Falsy IDs such as `0` must not be lost; one malformed multi-part geometry must skip only its feature, not the collection.
  - **Acceptance criteria:** Metadata assertions match fixture inputs, and malformed/unsupported features are skipped while valid siblings remain.

- [x] **3. Focused fixtures, documentation, and regression gate**
  - **Goal:** Prove the adapter contract is deterministic, offline, and compatible with existing behavior.
  - **Deliverables:** Extend `test/geography.mjs` with inline fixtures for all four geometry types, IDs/properties, mixed invalid input, stable diagnostics, repeated serialization, and projected coordinate assertions; document the API in `README.md` and list `src/geojson.js`.
  - **Dependencies:** Milestones 1–2.
  - **Risks:** Tests must use literal data only and must not imply later provider or model integration.
  - **Acceptance criteria:** `node test/geography.mjs` and `npm test` pass; repeated normalization serializes identically; no network or filesystem loading is introduced.

- [ ] **4. Ship and hand off for review**
  - **Goal:** Commit only issue-scoped files and open a PR that closes #37 when merged.
  - **Deliverables:** Conventional commit `feat(geography): normalize GeoJSON fixture records`; PR body with summary, verification, and `Closes #37`; worktree retained under PR-first shipping.
  - **Dependencies:** Milestones 1–3 and successful verification.
  - **Risks:** None beyond normal CI/review feedback.
  - **Acceptance criteria:** Feature branch has the scoped commit and an open PR URL.

### Test strategy

- **Focused:** `node test/geography.mjs` asserts the exact normalized shape for LineString, MultiLineString, Polygon-with-hole, and MultiPolygon fixtures; local coordinates match the existing projection API.
- **Metadata:** Assert string and numeric `feature.id` values, missing IDs, copied nested property content, and original properties on every supported record.
- **Diagnostics:** Include unsupported `Point`, missing/null geometry, malformed coordinates, and out-of-range coordinates in a collection with valid features; assert stable diagnostic codes/order and successful valid records.
- **Determinism/offline:** Normalize and `JSON.stringify` the same inline fixture twice; ensure `src/geojson.js` uses no `fetch`, filesystem, time, RNG, or provider imports.
- **Regression:** Run `npm test`; keep `src/model.js`, renderers, and existing projection behavior untouched.
- **Manual QA:** Not applicable to this data-only slice.

### Acceptance criteria mapping

| Issue criterion | Milestone(s) | How verified |
| --- | --- | --- |
| LineString, MultiLineString, Polygon, and MultiPolygon are supported | 1, 3 | Inline fixture assertions in `node test/geography.mjs` inspect all normalized coordinate nestings |
| Feature properties and source identifiers are retained | 2, 3 | Deep equality against fixture properties and exact `sourceId` assertions, including numeric zero |
| Invalid or unsupported features are skipped with diagnostics rather than crashing | 2, 3 | Mixed malformed fixture asserts ordered diagnostics and valid sibling output |
| Conversion is deterministic and performs no network access | 1, 3 | Repeated JSON serialization equality, source inspection, focused test, and `npm test` |

### Out-of-scope / deferred

- Provider-specific road, water, building, park, or land-use classification.
- Polygon winding/closure canonicalization, polygon clipping, viewport filtering, and antimeridian topology repair.
- Water masks/shoreline constraints (W-000003) and road graph import (W-000004).
- Geographic fabric, render integration, hybrid generation, asynchronous provider loading, tokens, and attribution (W-000005 through W-000008).
- Changes to `generateCity(config)`, procedural/BSP output, or renderer contracts.

### Implementation status (2026-09-01)

Milestones 1–3 are implemented and verified in the worktree; milestone 4 (ship) is not started.

- `src/geojson.js` (new) exports `normalizeGeoJSON(input, projection)` plus the frozen
  `SUPPORTED_GEOMETRY_TYPES` and `DIAGNOSTIC_CODES` constants. It has no imports, no
  dependencies, and no network, filesystem, time, or RNG access.
- `input` accepts a `FeatureCollection` or a bare `Feature` (normalized as a one-feature
  collection). `projection` must expose `project(coordinate)`; both are validated and throw
  `TypeError` at the API level only.
- Records match the documented contract exactly: `{ index, sourceId, properties, geometry }`,
  with `{ type: 'line', parts }` and `{ type: 'polygon', polygons }` geometry. Rings stay
  grouped inside their polygon, and all source ordering is retained.
- GeoJSON positions may carry an optional third elevation element; it is read past and dropped,
  since the local model is planar. Records always hold two-element `[x, z]` points.
- All five diagnostic codes are emitted: `invalid-feature`, `missing-geometry`,
  `unsupported-geometry`, `empty-geometry`, and `invalid-coordinate`. One skipped feature yields
  exactly one diagnostic, in source order, and per-feature projection failures are caught.
- `test/geography.mjs` (extended) covers all four geometry types with exact projected nesting,
  string/numeric-zero/absent/non-conforming ids, copied and non-aliased properties, a mixed
  ten-feature fixture asserting the full ordered diagnostic list plus valid-sibling recovery,
  bare-Feature and empty-collection input, repeated JSON serialization equality, and API-level
  throws.
- `README.md` documents the adapter contract and lists `src/geojson.js`.
- Verification: `node test/geography.mjs` and `npm test` both pass; `src/geography.js`,
  `src/model.js`, renderers, and existing tests are unchanged.

### Immediate next steps

1. Review the scoped diff (`src/geojson.js`, `test/geography.mjs`, `README.md`, these docs).
2. Commit `feat(geography): normalize GeoJSON fixture records` and open a PR closing #37.
