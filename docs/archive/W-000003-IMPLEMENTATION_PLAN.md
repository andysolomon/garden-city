## Implementation Plan

**Story:** W-000003 Import arbitrary water and shoreline geometry
**Issue:** #38
**Branch:** `feat/W-000003-import-arbitrary-water-shoreline-geometry`

### Product goal and scope boundaries

Convert normalized polygon records from `src/geojson.js` into the existing fields boundary contract so arbitrary lakes, rivers, and coastlines can be sampled as land/water and signed distance. Preserve the normalized polygon/ring structure for later W-000005 rendering, and expose shoreline pieces that the existing procedural graph and buildable-footprint checks can consume.

This slice is a provider-neutral, synchronous geometry adapter. It does not add `source: 'geographic'`, alter `generateCity(config)`, fetch provider data, render imported water, import roads, or add the later geographic fabric path. Those integrations remain W-000005 and later.

### Current baseline

- `src/geojson.js` normalizes Polygon and MultiPolygon features into `{ type: 'polygon', polygons }`, retaining polygon, ring, and coordinate order.
- `src/fields.js::makeWater(land, size)` provides `{ kind, shores, isLand, sdf }` for procedural flat, river, coast, and island descriptors.
- `src/graph.js::growRoads()` inserts `fields.water.shores` as virtual graph edges and uses `fields.water.sdf` to reject or bridge water crossings.
- `src/fabric.js::graphFabric()` uses the same water SDF for center selection, face acceptance, buildable pieces, parcels, and building footprints.
- `test/geography.mjs` owns geographic fixture assertions; `npm test` covers procedural graph/BSP regressions.

### Public contract

Add an exported `makeImportedWater(records, size = 900)` boundary factory in `src/fields.js`. It accepts normalized records from `normalizeGeoJSON()` and returns:

```js
{
  kind: 'imported',
  polygons,   // copied normalized polygon nesting: polygon -> rings -> [x,z]
  shores,     // in-viewport boundary pieces: { pts, closed }
  isLand(x, z),
  sdf(x, z),  // positive on land, negative in water, zero on shoreline
}
```

Each polygon uses its first ring as the water outer boundary and later rings as land holes. Multiple and overlapping polygons form a water union. Non-polygon records are ignored without mutating the normalized input. `makeWater({ kind: 'imported', records }, size)` delegates to this factory; all existing procedural branches retain their current output and behavior.

### Milestones

- [x] **1. Build the imported polygon boundary adapter**
  - **Files:** `src/fields.js`
  - **Details:** Validate the records array and finite local coordinates; copy polygon/ring geometry while removing only the repeated closing coordinate from sampling rings; retain source order; classify water as the union of each outer ring minus its holes; compute signed distance to the nearest real polygon boundary segment.
  - **Edge cases:** Polygon holes, MultiPolygon records, overlapping water polygons, empty polygon input, shoreline points, and points outside the viewport.
  - **Acceptance criteria:** Imported water exposes deterministic `isLand()` and signed-distance sampling, and the returned `polygons` preserve the normalized ring nesting for later rendering.

- [x] **2. Produce graph-safe shoreline pieces without altering masks**
  - **Files:** `src/fields.js`
  - **Details:** Use the existing inclusive viewport clipping helpers to derive `shores` from every outer and hole ring. Fully in-viewport rings remain closed; rings crossing the viewport become ordered open pieces ending on the viewport boundary; duplicate/zero-length points and boundary-collinear duplicates are removed. Deterministically decimate graph-only pieces to at most 24 ordered points (retaining open endpoints), so a high-vertex disconnected ring cannot outrank the procedural fabric during face-component retention. Keep authoritative copied `polygons`, `isLand`, and `sdf` based on the complete source polygons rather than clipped/simplified graph pieces.
  - **Acceptance criteria:** Existing graph insertion can consume arbitrary closed lakes and clipped coastline pieces without creating out-of-bounds shore nodes or duplicate boundary edges, and a 500-vertex lake cannot discard procedural roads.

- [x] **3. Generalize the existing fields boundary entry point**
  - **Files:** `src/fields.js`
  - **Details:** Add the opt-in `land.kind === 'imported'` branch to `makeWater()` and leave flat, river, coast, and island branches byte-for-byte compatible. Keep the existing `{ shores, isLand, sdf }` shape so `growRoads()` and `graphFabric()` require no behavior changes.
  - **Acceptance criteria:** Imported masks flow through the same road-water and buildable-footprint evaluation boundary already used by procedural modes.

- [x] **4. Add focused geographic and invariant coverage**
  - **Files:** `test/geography.mjs`, `README.md`, `docs/W-000003-progress.txt`
  - **Details:** Add normalized lake, polygon-with-hole, overlapping-polygon, MultiPolygon, and viewport-crossing fixtures. Assert exact retained polygon rings, `isLand`/SDF signs and distances, shoreline clipping, non-mutation, and deterministic serialization. Add a bounded graph/fabric fixture using the imported boundary and assert that live non-bridge road segments and sampled block/parcel/building footprints remain on land. Document the adapter without implying W-000005 rendering or model wiring.
  - **Acceptance criteria:** `node test/geography.mjs` and `npm test` pass, including existing procedural land modes.

- [x] **5. Close independently verified closed-lake graph/fabric gaps**
  - **Files:** `src/fields.js`, `src/fabric.js`, `test/geography.mjs`
  - **Details:** Bound only graph-facing imported shores; reject imported-water faces that enclose a disconnected lake or place a simplified shore chord in water; apply authoritative ring containment/intersection checks to buildables, parcels, and buildings in addition to SDF edge sampling. Compare interpolated graph-shore endpoints with a scale-aware floating-point tolerance while stitching and detecting closure, without changing authoritative polygon or mask coordinates.
  - **Acceptance criteria:** Explicit deterministic 30-vertex isolated-lake and 500-vertex lake fixtures retain roads and complete fabric while every accepted block, buildable, parcel, and building remains on land. Each fully in-viewport circle emits exactly one bounded `closed: true` graph shore with no duplicate terminal point and deterministic serialization; viewport-crossing fixtures remain ordered open pieces. The fabric fixtures fail against the pre-fix W-000003 state (30-point enclosing block; 500-point road component discarded).

- [ ] **6. Ship and hand off for review**
  - **Files:** Only the W-000003 allowlist above and `docs/W-000003-IMPLEMENTATION_PLAN.md`
  - **Details:** Create one Conventional Commit such as `feat(geography): import W-000003 water masks`; open one PR with `Closes #38`; default `--ship pr` leaves it open.
  - **Acceptance criteria:** Scoped diff, passing verification, one commit, and one open PR URL.

### Test strategy

- **Boundary unit tests:** In `test/geography.mjs`, assert land, water, and exact shoreline-zero points for a rectangular lake; assert a hole is land; assert overlapping polygons remain water; assert nearest-boundary signed distances.
- **Geometry retention:** Compare `water.polygons` with the normalized fixture rings and verify the normalized records are not mutated.
- **Shore clipping:** Cover a closed lake, explicit 30- and 500-point fully in-viewport circles, a ring crossing two viewport edges, a ring outside the viewport, duplicate closing coordinates, deterministic serialization, and deterministic open-piece ordering.
- **Road/buildable invariant:** Run deterministic bounded-water plus 30- and 500-vertex closed-lake graph/fabric fixtures. Require roads and complete fabric to remain present; densely sample block/buildable/parcel/building boundaries and reject authoritative lake-ring containment.
- **Procedural regression:** Reassert representative flat/river/coast/island field samples and run `npm test`.
- **Commands:** `git diff --check`; `node test/geography.mjs`; `npm test`; `git diff --name-only` against the story allowlist.

### Acceptance criteria mapping

| Issue criterion | Milestone(s) | How verified |
| --- | --- | --- |
| Imported water polygons provide `isLand()` and signed-distance sampling through the fields boundary | 1, 3, 4 | Lake/hole/overlap unit fixtures assert land, water, shoreline, and distance values |
| Normalized water features preserve polygon geometry for later rendering | 1, 4 | Deep equality against normalized Polygon/MultiPolygon rings plus non-mutation assertion |
| Imported masks constrain geographic road and buildable geometry | 2, 3, 4, 5 | Bounded-water and closed-lake fixtures densely sample roads, blocks, buildables, parcels, and buildings against authoritative imported water |
| Existing flat, river, coast, and island modes remain valid | 3, 4 | Existing invariant suite and `npm test`, plus representative field assertions |

### File ownership and parallelism

W-000003 owns `src/fields.js`, `test/geography.mjs`, `README.md`, and `docs/W-000003-*`. W-000004 must not edit those files. No implementation-file overlap is required, so the stories may run concurrently in separate worktrees.

### Risks and deferred work

- Polygon clipping is used only to produce graph-safe shoreline pieces; the authoritative mask and preserved rendering geometry remain the normalized polygons.
- Very large polygon sets make a linear nearest-segment SDF expensive. This slice keeps deterministic fixture-scale behavior; spatial indexing can be added only if profiling proves necessary.
- Imported water rendering and `CityModel.water` integration are explicitly W-000005.
- Provider-specific semantic classification of which polygon features are water is outside this adapter.

### Immediate next steps

1. Parent reviews the revised uncommitted W-000003 diff and closed-lake evidence.
2. Parent handles any commit/PR/issue workflow after approval.
3. Preserve W-000004 ownership boundaries and defer rendering/geographic-mode integration to W-000005+.
