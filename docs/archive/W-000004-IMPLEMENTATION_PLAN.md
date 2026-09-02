## Implementation Plan

**Story:** W-000004 Build a road graph from real road centerlines
**Issue:** #39
**Branch:** `feat/W-000004-build-road-graph-from-centerlines`

### Product goal and scope boundaries

Convert normalized line records from `src/geojson.js` into the existing `RoadGraph` representation with deterministic quantization, topology, provenance, road classification, width, and grade-separation metadata. Same-level crossings become shared nodes; bridge, tunnel, and explicit level crossings remain disconnected unless their source geometry joins at a compatible level. The resulting graph must be usable by current routing, face extraction, and debug-map code.

This slice builds the imported graph only. It does not add `source: 'geographic'`, call the importer from `generateCity(config)`, derive full `CityModel` blocks/parcels, fetch providers, or render imported water/buildings. W-000005 owns geographic fabric/model integration.

### Current baseline

- `src/geojson.js` normalizes LineString and MultiLineString features into ordered local `geometry.parts` and retains `sourceId` plus copied properties.
- `src/graph.js::RoadGraph` provides quantized graph operations, adjacency, edge splitting, spatial hashes, and planar face extraction, but its edge contract retains only procedural metadata.
- `src/routing.js` routes any live non-virtual `RoadGraph` edge using its class and geometric length.
- `src/map.js` already draws graph nodes and live edges by class/bridge state.
- The current face walk assumes every participating edge is planar; imported bridge/tunnel crossings therefore need explicit non-face participation rather than false intersection nodes.

### Public contract

Add `importRoadGraph(records, options = {})` in a new `src/roadgraph-import.js` module:

```js
{
  graph,        // RoadGraph
  diagnostics,  // ordered skipped/unusable/disconnected source diagnostics
  stats,
}
```

Input is the normalized record array from `normalizeGeoJSON()`. Supported options include viewport size/bounds, quantization/snap tolerance, and deterministic class-width defaults. Imported live edges retain:

```js
{
  cls, width, roadId,
  sourceId, sourceIndex, sourcePart,
  level, bridge, tunnel,
  faceEligible,
}
```

Metadata normalization is deterministic: explicit `class`/`roadClass` or standard `highway` values select arterial/collector/local; numeric source width is preferred, then lane-derived width, then a class fallback. Explicit numeric `level`/`layer` wins; otherwise bridge defaults above grade and tunnel below grade. Unsupported values use documented fallbacks rather than nondeterministic inference.

### Milestones

- [x] **1. Extend RoadGraph metadata without changing procedural output**
  - **Files:** `src/graph.js`
  - **Details:** Allow optional imported node/edge metadata while preserving the exact default procedural node and edge shape when metadata is absent. Ensure `splitEdge()` copies source ID, source part, level, bridge/tunnel, and face eligibility. Add a single face-participation predicate so explicitly grade-separated imported edges are excluded from the planar face walk while current procedural bridges retain existing behavior.
  - **Acceptance criteria:** Existing graph generation, splitting, routing, and `npm test` output remain valid; imported metadata survives all importer-created subsegments.

- [x] **2. Normalize source metadata and line parts**
  - **Files:** `src/roadgraph-import.js`
  - **Details:** Accept normalized records, skip non-line records with ordered diagnostics, clip source parts to the inclusive viewport, quantize finite points, remove consecutive duplicate/zero-length segments, and assign stable source-part `roadId` values. Normalize class, width, bridge, tunnel, and level metadata with documented deterministic fallbacks.
  - **Acceptance criteria:** Fixture assertions inspect node quantization, exact source identifiers, class/width decisions, and stable diagnostics for unusable records.

- [x] **3. Build level-aware topology**
  - **Files:** `src/roadgraph-import.js`, `src/graph.js`
  - **Details:** Collect source segments before graph mutation; detect and sort segment endpoints plus same-level geometric intersections; split both participating segments at each same-level crossing; deduplicate nodes by quantized `(x, z, level)`; do not split crossings whose normalized levels differ. Deduplicate identical same-level subsegments deterministically and preserve source provenance on the retained edge.
  - **Acceptance criteria:** Same-level cross/T fixtures create one shared node with expected degree/connectivity; overpass and tunnel fixtures retain separate level-aware nodes/edges and no false adjacency.

- [x] **4. Report unusable and disconnected source geometry**
  - **Files:** `src/roadgraph-import.js`
  - **Details:** Emit stable ordered diagnostics for non-line records, empty-after-clip parts, zero-length-after-quantization segments, invalid metadata fallbacks, duplicate segments, and disconnected drivable components. Keep usable components in the returned graph rather than silently dropping source roads; return deterministic counts in `stats`.
  - **Acceptance criteria:** Mixed fixtures retain valid siblings and make disconnected/unusable data visible to W-000005.

- [x] **5. Verify routing, faces, and debug-map compatibility**
  - **Files:** `test/roadgraph-import.mjs`, `docs/W-000004-progress.txt`
  - **Details:** Add crossing, T-junction, overpass, tunnel, metadata, clipping, duplicate, disconnected, grid-face, and deterministic fixtures. Assert `shortestPath()` connectivity on same-level roads and separation across false overpass crossings; assert a ground-level grid produces simple valid faces while grade-separated edges do not create false faces; invoke `drawMap()` with a minimal canvas-context double to prove imported graph layers render without exceptions.
  - **Acceptance criteria:** `node test/roadgraph-import.mjs` and `npm test` pass without changing procedural output.

- [ ] **6. Ship and hand off for review**
  - **Files:** Only `src/graph.js`, `src/roadgraph-import.js`, `test/roadgraph-import.mjs`, `docs/W-000004-IMPLEMENTATION_PLAN.md`, and `docs/W-000004-progress.txt`
  - **Details:** Create one Conventional Commit such as `feat(geography): import W-000004 road graphs`; open one PR with `Closes #39`; default `--ship pr` leaves it open.
  - **Acceptance criteria:** Scoped diff, passing verification, one commit, and one open PR URL.

### Test strategy

- **Quantization/provenance:** Import lines whose coordinates collapse to the graph quantum; inspect node coordinates and every edge's `sourceId`, source index/part, and stable `roadId`.
- **Same-level topology:** Cross and T fixtures assert one shared same-level node, expected degree, no duplicate edge, and a valid route through the intersection.
- **Grade separation:** Bridge-over-road, tunnel-under-road, and explicit positive/negative level fixtures assert no shared node or route at geometric crossings; imported bridge/tunnel metadata survives; non-face edges do not corrupt ground faces.
- **Classes/widths:** Cover explicit class, standard `highway` classes, explicit numeric/string width, lane-derived width, and deterministic unclassified fallbacks.
- **Faces/routing/map:** A small grid yields expected simple faces and `shortestPath()` results; a canvas test double runs the graph edge/node debug layers without exceptions.
- **Diagnostics/determinism:** Mixed valid/unusable/disconnected records yield ordered stable diagnostic codes and byte-identical repeated serialization.
- **Regression commands:** `git diff --check`; `node test/roadgraph-import.mjs`; `npm test`; `git diff --name-only` against the story allowlist.

### Acceptance criteria mapping

| Issue criterion | Milestone(s) | How verified |
| --- | --- | --- |
| Centerlines create quantized graph nodes and edges with source identifiers | 1, 2, 3, 5 | Quantization and edge-provenance fixture assertions |
| Same-level intersections become shared graph nodes | 3, 5 | Cross/T degree and route-connectivity fixtures |
| Bridge, tunnel, and level metadata prevent false intersections | 1, 2, 3, 5 | Overpass/tunnel fixtures assert separate level-aware topology and valid ground faces |
| Road classes and widths use source metadata with deterministic fallbacks | 2, 5 | Classified, lane/width, and unclassified metadata table tests |
| Imported graphs work with routing and debug-map layers | 5 | `shortestPath()` fixture plus `drawMap()` canvas-double smoke test |
| `npm test` passes without changing procedural output | 1, 5 | Full existing suite after focused importer tests |

### File ownership and parallelism

W-000004 owns `src/graph.js`, `src/roadgraph-import.js`, `test/roadgraph-import.mjs`, and `docs/W-000004-*`. It must not edit `src/fields.js`, `test/geography.mjs`, or `README.md`, which belong to W-000003. The two implementations can run concurrently in separate worktrees.

### Risks and deferred work

- The existing model is geometrically 2D. Separate `(x, z, level)` nodes plus `faceEligible: false` prevent false junctions/faces while retaining bridge/tunnel edges for routing and map display; W-000005 will decide how imported elevated roads become model road/bridge entries.
- Source datasets may encode ramps or level transitions inconsistently. This slice reports disconnected components and does not invent connections absent compatible source geometry.
- All-pairs segment intersection is acceptable for bounded fixtures but may require spatial indexing when W-000008 introduces provider-scale datasets.
- Provider loading, caching, semantic tag expansion, and asynchronous data access are outside this issue.

### Immediate next steps

1. Obtain operator approval of this plan and the paired W-000003 plan.
2. Create `.arc/worktrees/W-000004` from `origin/main` on the planned branch.
3. Dispatch the bounded story contract, inspect its diff, and run focused/full verification.
