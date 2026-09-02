# W-000007 Implementation Plan

**Story:** W-000007 Add hybrid geographic and procedural mode
**Issue:** #42
**Branch:** `feat/W-000007-add-hybrid-geographic-procedural`

## Product goal and scope boundaries

Add an opt-in `source: 'hybrid'` mode that preserves authoritative imported road and water geometry while running the existing procedural face, parcel, massing, tree, traffic, and life systems over the remaining valid buildable area. Keep `generateCity(config)` synchronous and provider-neutral. Preserve existing `source: 'geographic'`, procedural graph, and BSP behavior byte-for-byte for the same configs and seeds.

Hybrid mode will reuse the geographic importer and authoritative imported building/park claims established by W-000005 and W-000006. Accepted imported footprints and land use remain present and continue to reserve their polygons; procedural massing fills only unclaimed, on-land, non-reserved parcels. All hybrid layout/life draws use a dedicated `seed + ':hybrid'` RNG stream, while existing `:city`, `:traffic`, `:noise`, and other established streams remain unchanged for existing modes.

## Current baseline

- `src/model.js::generateCity()` recognizes only `source: 'geographic'`; every other source follows the procedural graph/BSP path using `seed + ':city'`.
- `src/model.js::makeGeographicLand()` already classifies normalized polygons as water, buildings, or park/land use without consuming city RNG.
- `src/fabric.js::geographicFabric()` imports source road centerlines, preserves edge provenance, derives faces/blocks/parcels, rejects water-crossing buildable geometry, accepts authoritative imported claims first, and filters generated massing against those claims.
- Traffic analysis and route-aware cars already consume imported graph/corridor data, and map, ink, solid, poster, and PNG paths consume the shared CityModel without source-specific rendering branches.
- `test/geography.mjs` owns the deterministic inline geographic fixture and geometry/render-adapter assertions; `npm test` covers procedural graph and BSP invariants.
- Prerequisite stories W-000001 through W-000006 are present on `origin/main`.

## Missing capabilities

- A validated `source: 'hybrid'` entry point and source label that selects imported roads/water plus procedural fabric instead of falling through to procedural road growth.
- A hybrid-only seeded RNG namespace so new hybrid generation cannot perturb existing procedural or geographic streams.
- A focused hybrid fixture proving imported infrastructure preservation, generated massing/life on valid areas, deterministic serialization, and shared renderer/export compatibility.
- Public documentation of the hybrid config and its relationship to geographic mode.

## Milestones

### 1. Add the hybrid source seam and RNG namespace

- **Goal:** Route hybrid configs through the existing geographic constraints and fabric without changing any existing source mode.
- **Files:** `src/model.js`, `test/geography.mjs`
- **Deliverables:** Recognize `source: 'hybrid'`; label `model.source` as `hybrid`; require normalized `geography.records` and the graph engine through the existing geographic validation; use `new RNG(seed + ':hybrid')` for hybrid rail, fabric/massing, trees, and non-traffic life draws; retain the existing `seed + ':city'` stream for geographic and source-omitted configs.
- **Dependencies:** Existing `makeGeographicLand()` and `geographicFabric()` paths from W-000005/W-000006.
- **Risks:** Broadening the geographic predicate must not relabel or reroute source-omitted graph/BSP configs; geographic outputs must not change.
- **Acceptance criteria:** A hybrid fixture reports `model.source === 'hybrid'`, uses imported graph/water data, and rejects invalid/missing geography or BSP with the established clear errors.

### 2. Prove hybrid infrastructure, buildability, life, and determinism

- **Goal:** Convert the issue criteria into fixture-level regression checks.
- **Files:** `test/geography.mjs`
- **Deliverables:** Generate a life-enabled hybrid model from the existing imported road/water/building/park fixture; compare imported road axes/provenance and shoreline rings with the source/geographic fixture; assert generated buildings and their massing footprints remain on land, outside reserved rectangles, and outside accepted imported claims; assert procedural buildings, trees, traffic analysis, and routed cars are present and valid on the imported graph; serialize two runs with the same seed/config byte-for-byte; compare fixed procedural graph, BSP, and geographic models before/after the hybrid run.
- **Dependencies:** Milestone 1 and existing geometry helpers/invariants.
- **Risks:** Trees on authoritative parks are valid life placement but not building footprints; tests must validate each model type against its actual placement contract rather than assume one shared polygon rule. Routed cars must be checked against live imported graph edges.
- **Acceptance criteria:** Focused hybrid assertions pass and repeated generation is identical while existing mode signatures remain unchanged.

### 3. Document and complete renderer/export acceptance

- **Goal:** Make the new mode discoverable and verify that the shared CityModel remains consumable by every requested output path.
- **Files:** `README.md`, `docs/W-000007-IMPLEMENTATION_PLAN.md`, `docs/W-000007-progress.txt`
- **Deliverables:** Document `source: 'hybrid'`, the dedicated RNG namespace, imported constraints/claims, and procedural fill behavior. Run the existing map canvas adapter assertions and manually render the hybrid fixture in map, ink, and solid modes; export temporary valid PNGs from each mode without committing binaries.
- **Dependencies:** Milestones 1–2; existing renderer/export code should require no source-specific changes.
- **Risks:** The application UI does not yet load provider data (W-000008), so manual acceptance must inject or load the normalized local fixture without introducing provider/UI scope.
- **Acceptance criteria:** Map, ink, solid, poster, and PNG paths render/export the hybrid CityModel; no renderer behavior or aesthetic defaults regress.

### 4. Regression verification and PR handoff

- **Goal:** Verify the complete issue and prepare a reviewable PR without merging it.
- **Files:** All issue-scoped files above.
- **Deliverables:** Run `node test/geography.mjs`, `node test/roadgraph-import.mjs`, and `npm test`; inspect the exact diff; commit with Conventional Commits and `Closes #42`; push and open a PR in orchestrated `--ship pr` mode.
- **Dependencies:** Milestones 1–3.
- **Risks:** Verification failure is terminal for the current implementation contract and requires a revised, re-approved implementation pass.
- **Acceptance criteria:** All focused/full checks pass and the open PR URL plus retained worktree path are reported.

## Test strategy

- **Focused model/integration:** Extend `test/geography.mjs` with one hybrid fixture using imported roads, shoreline/water, imported claims, procedural massing, and `life: 'high'`. Assert source label, imported provenance/geometry, model contract, buildable-area safety, traffic/car validity, tree placement, and byte-identical repeated serialization.
- **Compatibility:** Capture representative procedural graph, BSP, and geographic model serialization/signatures and prove hybrid generation does not change them. Run `npm test` for the existing 100-seed invariant matrix and grade suite.
- **Importer regression:** Run `node test/roadgraph-import.mjs` because it is not included in `npm test`.
- **Render/export:** Reuse map canvas assertions, then serve locally and manually inspect/export the hybrid fixture in map, ink, and solid modes. Validate temporary PNG signatures/dimensions and remove them after inspection.

## Acceptance criteria mapping

| Issue criterion | Milestone(s) | Verification |
| --- | --- | --- |
| `source: 'hybrid'` preserves imported roads and water boundaries | 1, 2 | Exact imported edge provenance/axis and shoreline-ring fixture comparison |
| Procedural buildings, trees, traffic, and massing occur only on valid buildable areas | 1, 2 | Hybrid geometry/claim/reserved/water invariants plus routed-car and park-tree assertions |
| Hybrid output uses the configured seed deterministically | 1, 2 | Byte-for-byte `JSON.stringify()` comparison of repeated fixture generation; dedicated `:hybrid` stream |
| Hybrid mode supports ink, solid, map, and PNG export | 3 | Existing adapter tests plus manual three-mode browser/PNG checklist |
| Procedural mode remains unchanged | 1, 2, 4 | Fixed mode signatures and full `npm test` regression suite |

## Out of scope / deferred

- Provider/network loading, geocoding/location controls, credentials, caching, and attribution (W-000008).
- Asynchronous changes to `generateCity(config)`.
- Changes to imported road/water/building/park classification, arbitrary park holes, renderer aesthetics, palettes, or export formats.
- BSP support for geographic or hybrid sources.

## Immediate next steps

1. Obtain operator approval for this plan, the exact ARC implementation contract, and the proposed `medium-medium` workload class.
2. Implement only in `.arc/worktrees/W-000007` and only in the listed issue-scoped files.
3. Run focused/full automated verification and the manual three-mode PNG checklist.
4. Commit with `feat(geography): add W-000007 hybrid city mode` and `Closes #42`, push, and open a PR (`--ship pr`).
