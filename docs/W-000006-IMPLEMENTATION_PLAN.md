# W-000006 Implementation Plan

**Story:** W-000006 Render real building footprints and land use
**Issue:** #41
**Branch:** `feat/W-000006-render-real-building-footprints`

## Product goal

Render authoritative geographic building, park, and land-use polygons through the existing CityModel so map, ink, solid, poster, and PNG export paths recognize the source location. Keep the adapter provider-neutral and synchronous, and preserve the established antitecture palette and polygon-prism grammar.

## Baseline

- `src/geojson.js` preserves normalized polygon geometry and copied source properties without semantic classification.
- `src/model.js::makeGeographicLand()` currently treats every geographic polygon as imported water.
- `src/fabric.js::geographicFabric()` imports road lines and then produces procedural blocks, parcels, buildings, and parks. Its local `footprintOnLand()` and reserved-rectangle checks already protect generated footprints.
- `src/ink.js` and `src/solid.js` already render polygon building footprints, courtyard holes, and polygon parks.
- `src/map.js` renders buildings as rotated rectangles and only draws parks behind the disabled-by-default `blocks` layer.
- `test/geography.mjs` owns the inline end-to-end geographic fixture; `npm test` covers graph, BSP, and perimeter-footprint regressions.

## Classification and model contract

Classify only normalized geographic polygon records, without changing `normalizeGeoJSON()`:

1. **Building:** `properties.kind === 'building'` or a truthy/non-`no` `properties.building` tag.
2. **Park/land use:** `properties.kind === 'park'` or a non-empty `properties.landuse`/`properties.leisure` tag that is not water.
3. **Water:** explicit water tags and otherwise-unclassified polygons. The unclassified fallback preserves W-000005 behavior.

Each source polygon in a `MultiPolygon` becomes one model entry and keeps `sourceIndex`/`sourceId`. A building outer ring becomes `footprint`; its first hole becomes `courtyard`. Buildings retain the existing rectangle compatibility fields from the footprint bbox. Height uses a finite positive source `height`, then finite positive `building:levels * 3`, then a stable source-identity/index fallback independent of the city RNG. Imported parks/land use use the existing park ground treatment and retain provenance plus a `landUse` marker.

An imported building is accepted only when its full footprint is on land and does not intersect any reserved rectangle. Rejected source footprints are omitted deterministically and surfaced in `model.geography.diagnostics`. Imported authoritative footprints/parks claim their polygons before generated massing is accepted, preventing procedural buildings from covering them.

## Milestones

### 1. Classify and adapt geographic polygons

- **Files:** `src/model.js`, `test/geography.mjs`
- **Changes:** Add a deterministic provider-neutral classifier and adapters for water, buildings, and park/land-use records. Preserve untagged-polygon-as-water compatibility, source provenance, synchronous generation, input immutability, MultiPolygon expansion, courtyard rings, rectangle compatibility fields, source heights, levels-derived heights, and stable fallback heights.
- **Acceptance:** Tagged fixtures produce the expected model arrays and serialize identically across repeated generation.

### 2. Reconcile imported and procedural fabric

- **Files:** `src/fabric.js`, `test/geography.mjs`
- **Changes:** Thread classified imported features into geographic fabric. Reuse authoritative water checks and exact reserved-rectangle intersection checks before accepting imported buildings. Treat accepted imported buildings and parks as claimed polygons when procedural massing/parks are finalized so generated buildings do not overlap source footprints.
- **Acceptance:** Water-overlapping and reserved-overlapping imported buildings are absent with deterministic diagnostics; accepted imported footprints remain present and do not overlap generated buildings.
- **Risk:** Claim filtering must be geographic-only and must not alter procedural graph/BSP RNG order or hashes.

### 3. Complete map and renderer integration

- **Files:** `src/map.js`, `test/geography.mjs`
- **Changes:** Draw polygon building footprints (and courtyard subpaths with even-odd fill) in map mode while keeping the rectangle fallback. Add a default-visible parks/land-use map layer instead of coupling parks to the buildable-block debug layer. Reuse existing ink and solid polygon/park paths without changing palette or camera behavior.
- **Acceptance:** Canvas-context tests prove polygon/courtyard and park paths are traced. The same fixture renders in map, ink, and solid modes and exports valid PNGs.

### 4. Verify regressions and document the geographic contract

- **Files:** `README.md`, `test/geography.mjs`, existing regression suites
- **Changes:** Document recognized polygon tags, height precedence/fallback, provenance, and overlap behavior. Retain focused fixture assertions for map/ink/solid-compatible model shapes and existing perimeter paths.
- **Verification:** `node test/geography.mjs`; `node test/roadgraph-import.mjs`; `npm test`; browser fixture observation and PNG export in map, ink, and solid modes.
- **Acceptance:** All issue criteria map to passing automated checks plus the visual/export checklist; procedural and BSP behavior remain unchanged.

## Test strategy

- **Focused model tests:** Extend the inline geographic road grid with explicit water, source-height building, levels-height building, fallback-height building, courtyard building, park, generic land-use, water-overlap, and reserved-overlap polygons. Assert provenance, bbox fields, deterministic heights/serialization, diagnostics, and non-overlap invariants.
- **Map tests:** Extend the canvas double to assert building outer/courtyard subpaths use `fill('evenodd')`, imported parks trace polygons, and rectangle buildings retain `fillRect` fallback.
- **Regression:** Run `npm test` for graph/BSP invariants, grade checks, deterministic hashes, and existing perimeter-block rendering data; run `node test/roadgraph-import.mjs` because it is outside `npm test`.
- **Manual QA:** Serve locally, load the geographic fixture, inspect map/ink/solid modes, and export one valid PNG from each mode without committing binaries.

## Acceptance criteria mapping

| Issue criterion | Milestone(s) | Verification |
| --- | --- | --- |
| Imported building polygons render in ink mode | 1, 3, 4 | Fixture model shape plus manual ink observation/PNG export |
| Imported buildings are solid extrusions with source or fallback heights | 1, 3, 4 | Exact height precedence assertions plus manual solid observation/PNG export |
| Parks and land-use polygons appear in map, ink, and solid | 1, 3, 4 | Canvas path assertions plus three-mode visual checklist |
| Imported footprints respect water and reserved areas | 2, 4 | Water/reserved rejection diagnostics and geometry non-overlap assertions |
| Existing procedural polygon-footprint rendering remains valid | 2, 4 | `npm test`, deterministic procedural/BSP checks, and perimeter-footprint invariants |

## Risks and notes

- Source properties are intentionally interpreted at the model boundary; `src/geojson.js` remains provider-neutral.
- Untagged polygons remain water to avoid breaking the W-000005 public fixture contract.
- Only the first building hole maps to the existing single-courtyard model field; additional building holes and hole-aware park meshes remain out of scope.
- Geographic-only claim filtering must not consume additional shared RNG draws or alter non-geographic output.

## Out of scope

- Provider/network loading, geocoding, location UI, caching, hybrid procedural/geographic mode, new palettes, arbitrary park holes, and changes to `generateCity(config)` synchronicity.

## Immediate next steps

1. Obtain operator approval for this plan and the ARC implementation contract.
2. Implement only in `.arc/worktrees/W-000006`.
3. Run focused and full automated verification, then the three-mode PNG checklist.
4. Commit with `feat(geography): render W-000006 real footprints and land use` and `Closes #41`, push, and open a PR (`--ship pr`).
