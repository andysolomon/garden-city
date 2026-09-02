## Implementation Plan

**Story:** W-000005 Add geographic fabric mode  
**Issue:** #40  
**Branch:** `feat/W-000005-add-geographic-fabric-mode`

### Product goal and scope boundaries

Add an opt-in synchronous geographic source path that derives the existing `CityModel` fabric from normalized imported roads and water instead of procedurally growing streets. The approved public input is:

```js
generateCity({
  source: 'geographic',
  geography: {
    records,       // normalized local records from normalizeGeoJSON()
    diagnostics,   // optional upstream normalization diagnostics
  },
  // existing seed, density, sector, detail, massing, rail, life, air, etc.
})
```

For this slice, normalized line records are imported roads and normalized polygon records are imported water. Geographic mode uses the graph engine, remains synchronous and provider-neutral, and produces the same model arrays and graph analysis consumed by map, ink, solid, poster, traffic, and life systems. It does not fetch data, add location UI, import building/park footprints, or add hybrid generation.

Configs without `source: 'geographic'` must continue through the existing graph or BSP path unchanged. An explicit geographic request with an incompatible BSP engine must fail clearly rather than silently using procedural subdivision.

### Current baseline

- `src/model.js::generateCity()` creates procedural land, plans rail, then selects BSP or `graphFabric()`; it has no source branch.
- `src/roadgraph-import.js::importRoadGraph(records, options)` already returns a deterministic level-aware `{ graph, diagnostics, stats }` with source provenance.
- `src/fields.js::makeImportedWater()` and `makeWater({ kind: 'imported', records })` already expose authoritative polygons, graph-safe shores, `isLand()`, and `sdf()`.
- `src/fabric.js::graphFabric()` already reuses extracted faces for blocks, buildable pieces, parcels, frontage, corridors, massing, and routing, but always calls `growRoads()`.
- `model.water` and the map/ink/solid water branches currently assume procedural rectangle or sea-disc entries; imported polygon rings are retained only in `model.fields.water.polygons`.
- `test/geography.mjs` covers projection, normalized records, imported water, and procedural fabric constrained by imported water. `test/roadgraph-import.mjs` covers imported road topology independently.

### Missing capabilities

- A validated `source: 'geographic'` model entry point using `geography.records`.
- A geographic graph-fabric path that substitutes `importRoadGraph()` for `growRoads()` while reusing downstream face/block/parcel/frontage logic.
- Surface-road mapping for imported at-grade/elevated/tunnel edges without inventing procedural streets, including rejection of inconsistent at-grade roads through authoritative imported water.
- Plain-data imported water entries with outer rings and holes that all three render modes can consume.
- A clear synchronous generation error for empty or unusable road data, including diagnostics useful to a caller that retries with corrected data.
- End-to-end geographic fixture coverage and a repeatable renderer/PNG checklist.

### Milestones

- [x] **1. Establish the geographic model contract and errors**
  - **Files:** `src/model.js`, `test/geography.mjs`
  - **Goal:** Select geographic generation only when explicitly requested and validate its synchronous input.
  - **Deliverables:** Validate `geography.records` as an array; preserve optional upstream diagnostics; require the graph engine for geographic mode; construct `{ kind: 'imported', records }` without consuming the procedural land RNG; route geographic requests to a dedicated fabric entry point. Define one clear generation error for zero usable road faces whose message includes record/edge/face counts and diagnostic codes. A failed call must leave no shared state, so a subsequent call with corrected records or an ordinary procedural config succeeds.
  - **Dependencies:** Existing W-000002 through W-000004 adapter contracts.
  - **Risks:** The non-geographic branch and `:city` RNG draw order must remain untouched.
  - **Acceptance criteria:** Empty/polygon-only/unusable geographic fixtures throw a stable readable error; valid geographic and post-error recovery calls return normally; omitted `source` remains byte-compatible.

- [x] **2. Derive complete fabric from the imported road graph**
  - **Files:** `src/fabric.js`, `test/geography.mjs`
  - **Goal:** Replace road growth, not the proven downstream fabric pipeline.
  - **Deliverables:** Add a geographic fabric path or a narrowly factored graph-source seam. It must call `importRoadGraph(records, { viewportSize: CITY_SIZE })`, then reuse `extractFaces()`, road ribbons/caps, `buildCorridors()`, blocks, buildable areas, parcels, frontage, massing, traffic, and life. Surface entries must retain `edge` links into the imported graph: at-grade edges become `model.roads`, bridges/elevated edges become `model.bridges`, and below-grade/tunnel edges remain routable graph data but are not drawn as surface roads or junction caps. Densely validate live at-grade imported edges against authoritative `fields.water.isLand/sdf`, allowing only the established quantization tolerance and rejecting inconsistent source data with edge/source context. Store every numeric importer counter plus a derived bridge/elevated count under `model.stats.import`, retain numeric top-level UI counters, and preserve diagnostics/stats under `model.geography`.
  - **Dependencies:** Milestone 1; `importRoadGraph()` and `makeImportedWater()`.
  - **Risks:** Imported graphs have no procedural boundary ring, so only bounded road faces become blocks; sparse or disconnected data may legitimately fail the usable-face gate. Corridor ordering must remain deterministic with string road IDs.
  - **Acceptance criteria:** A bounded grid fixture yields imported-provenance roads, positive simple faces, blocks, parcels, buildings, corridors, and parcel frontage; no live rendered road originates from procedural growth.

- [x] **3. Adapt imported water to the CityModel and renderers**
  - **Files:** `src/fabric.js`, `src/render.js`, `src/map.js`, `src/ink.js`, `src/solid.js`, `test/geography.mjs`
  - **Goal:** Render the authoritative imported polygon union without weakening existing procedural water modes.
  - **Deliverables:** Convert each imported water polygon into plain model data such as `{ type: 'imported', polygon, holes, x, z, w, d }`, preserving copied coordinates and bbox compatibility. Add an even-odd polygon-with-holes branch to `drawMap()`. Generalize the shared polygon-prism helper (or add an equivalent focused helper) to accept multiple holes, then use it for low water meshes in ink and solid modes plus ring outlines in ink. Keep river/coast/island/sea rendering paths unchanged.
  - **Dependencies:** Canonical `model.fields.water.polygons` from Milestone 2.
  - **Risks:** Repeated closing coordinates and ring orientation must be normalized only for renderer shapes, not by mutating authoritative field polygons. Imported water must not use `type: 'sea'`, which would trigger island-specific rendering.
  - **Acceptance criteria:** Map smoke assertions exercise outer-ring and hole drawing; manual map/ink/solid checks show the fixture water and export valid PNGs without renderer exceptions.

- [x] **4. Add end-to-end fixture, contract, and regression coverage**
  - **Files:** `test/geography.mjs`, `README.md`, `docs/W-000005-progress.txt`
  - **Goal:** Prove all issue criteria offline and document the new public mode.
  - **Deliverables:** Add an inline normalized fixture with at least a 3×3 at-grade road grid, stable source IDs/classes, bridge/elevated/tunnel edges, and imported water placed so multiple buildable faces remain. Assert provenance; positive simple faces; water-safe blocks/parcels/buildings; complete nested import stats; deterministic serialization; and map drawing through a canvas-context double. Assert at-grade lake crossings fail with source context, bridge/elevated crossings pass, and route positions/render placement expose legacy bridge plus elevated/below-grade state. Document the config, errors, and deferred provider/UI work.
  - **Dependencies:** Milestones 1–3.
  - **Risks:** The fixture must be large enough to exercise corridors and fabric while remaining fast and deterministic.
  - **Acceptance criteria:** Focused and full suites pass, and procedural graph/BSP invariant behavior remains unchanged.

- [ ] **5. Manual renderer acceptance and PR handoff**
  - **Files:** `docs/W-000005-progress.txt` plus the issue-scoped implementation files above
  - **Goal:** Complete visual acceptance and leave one reviewable PR.
  - **Deliverables:** Serve the repository locally; generate the documented geographic fixture, render it through map, ink, and solid, and export one PNG from each mode without committing binaries. After independent verification, create one Conventional Commit such as `feat(geography): add W-000005 geographic fabric mode` with `Closes #40`, then open a PR in the default orchestrated `--ship pr` mode.
  - **Dependencies:** Milestones 1–4 and implementation verification.
  - **Risks:** Browser automation can fail in restricted sandboxes; record the exact blocker rather than claiming completion.
  - **Acceptance criteria:** Automated gates pass; map/ink/solid fixture rendering and PNG export are observed, or the PR is explicitly handed off with the unresolved manual blocker.
  - **Visual evidence:** Parent verification rendered the geographic fixture through local `serve.sh` and headless Chromium. Noncommitted PNGs: map 780×437, ink 1654×2339, solid 780×437; imported water and its hole are visible. PR handoff remains for the parent.

### Test strategy

- **Imported-road provenance:** Generate the fixture through `generateCity()`. For every `model.roads` and `model.bridges` entry, resolve `model.graph.edges[entry.edge]` and assert imported `sourceIndex`/`sourceId` metadata. Assert every rendered edge belongs to the fixture and that no procedural-only road ID or growth stat appears.
- **Fabric geometry:** Assert non-empty positive simple `model.faces`; blocks reference those faces; parcels are valid polygons with a `frontage` field; at least one parcel has usable frontage and at least one building is produced. Densely sample accepted block/buildable/parcel/building boundaries against `model.fields.water.sdf`.
- **CityModel compatibility:** Reuse the invariant harness's model-contract expectations in focused assertions: all standard arrays exist, road axes/bboxes are finite, graph/corridors/stats/traffic are present, and life/air generation does not throw. Keep geographic-only invariants out of the procedural 100-seed matrix.
- **Water rendering:** Use a canvas-context double to assert map paths include imported outer and hole rings and use even-odd filling. Inspect plain water entries and shared polygon geometry inputs automatically. Manually render map, ink, and solid and export PNGs; do not commit binary output.
- **Errors/recovery:** Assert empty records, polygon-only records, and line data with no bounded face throw a message matching `geographic source has no usable road faces` with useful counts/codes. Assert an untagged at-grade road entering imported water throws an edge/source-specific unusable-data error while bridge/elevated versions pass. Immediately call `generateCity()` with valid geographic and procedural configs to prove recovery.
- **Determinism/regression:** Compare two geographic model serializations byte-for-byte. Run the existing procedural graph/BSP suite, whose deterministic hashes and invariants must remain unchanged.
- **Local browser result:** Parent verification rendered the geographic fixture through local `serve.sh` plus headless Chromium. Noncommitted PNGs: map 780×437, ink 1654×2339, solid 780×437, with imported water and its hole visible. Binaries stay out of the repository.
- **Commands:** `git diff --check`; `node test/geography.mjs`; `node test/roadgraph-import.mjs`; `npm test`; `git diff --name-only origin/main...HEAD` against the issue allowlist.

### Acceptance criteria mapping

| Issue criterion | Milestone(s) | How verified |
| --- | --- | --- |
| `source: 'geographic'` bypasses procedural road growth | 1, 2, 4 | Every rendered road/bridge resolves to an imported graph edge with fixture provenance; geographic stats expose importer data rather than growth proposals |
| Imported roads produce valid faces, blocks, parcels, and frontage | 2, 4 | `node test/geography.mjs` asserts simple positive faces, non-empty fabric, valid polygons, frontage fields, and water-safe geometry; `node test/roadgraph-import.mjs` retains topology coverage |
| Geographic mode conforms to the existing `CityModel` contract | 1, 2, 4, 5 | Focused model-shape/analysis assertions, map canvas smoke test, and manual ink/solid fixture rendering without exceptions |
| Imported water polygons render in map, ink, and solid modes | 3, 4, 5 | Even-odd map assertion plus manual three-mode fixture checklist and PNG exports |
| Empty or unusable geographic data returns a clear generation error | 1, 4 | Empty/polygon-only/no-face throws assert stable message and diagnostics; valid geographic and procedural calls immediately afterward prove recovery |

### File allowlist

- `src/model.js`
- `src/fabric.js`
- `src/render.js`
- `src/map.js`
- `src/ink.js`
- `src/solid.js`
- `src/routing.js`
- `test/geography.mjs`
- `README.md`
- `docs/W-000005-IMPLEMENTATION_PLAN.md`
- `docs/W-000005-progress.txt`

`src/roadgraph-import.js`, `src/graph.js`, `src/fields.js`, `src/corridors.js`, `package.json`, provider code, and product UI are expected to remain unchanged unless verification exposes a concrete contract defect and a revised implementation contract is approved.

### Out-of-scope / deferred

- Raw GeoJSON projection/normalization inside `generateCity()`; callers supply normalized local records.
- Provider requests, tokens, asynchronous loading, location/radius UI, attribution, or live-network tests (W-000008).
- Imported building footprints and park/land-use rendering (W-000006).
- Hybrid imported/procedural fabric (W-000007).
- New tunnel rendering, terrain semantics for source elevations, provider-specific tag classification, and automatic viewport fitting.
- Changes to procedural graph growth, BSP subdivision, existing presets, or renderer aesthetic identity.

### Immediate next steps

1. Obtain operator approval of this plan and the exact implementation contract/workload class.
2. Delegate implementation only inside `.arc/worktrees/W-000005` and the file allowlist.
3. Inspect the diff, run focused and full verification, then run independent ARC Verify.
4. Visual map/ink/solid PNG checklist is complete; binaries remain uncommitted.
5. If accepted, commit, push, and open a PR with `Closes #40`; leave the worktree in place under PR-first shipping.
