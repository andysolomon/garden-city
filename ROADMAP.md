# Remaining work

Handoff document. Written for someone — or something — picking this repo up
cold. Read §1–§3 before writing code; they contain the constraints that are
easy to break silently and annoying to debug afterwards.

Current state: V2 (planar road graph) is complete and merged. The engine
generates five distinguishable street morphologies, all nine invariants hold
over 100 seeds, and both renderers plus the poster export work end to end.

---

## 1. Orientation

**What this is.** A procedural city generator. `generateCity(config)` returns a
plain-data `CityModel`; renderers consume it. The generator never imports
three.js and the renderers never decide layout. That separation is the
architecture — keep it.

**The one product rule.** The ink/poster renderer *is* the product identity.
Every change must end with something that still renders in ink mode. Never
leave a long stretch where the only working output is the debug map.

```sh
./serve.sh        # http://localhost:8000 — ES modules need a real server
npm test          # 100 seeds × 9 invariants, ~5s, no dependencies
open contact.html # N seeds as top-down thumbnails, for judging across seeds
```

In the app: MODE → MAP / DEBUG is the top-down graph view with per-layer
toggles. It is the only sane way to debug the graph — the isometric ink view
will not reveal topological faults.

**The pipeline.**

```
config → seeded RNG → land → rail plan (reserves corridors)
       → fields (water SDF / population / direction)
       → road-graph growth (snap · split · extend · min-angle · clearance · bridges)
       → faces = blocks → per-edge offset → OBB parcels + frontage → buildings
       → corridors + city life  ⇒  CityModel  ⇒  { ink, solid, map, poster }
```

**Where things live.** ~3,500 lines total.

| File | Lines | What |
|---|---|---|
| `src/geom.js` | 409 | Geometry kernel. One orientation predicate, quantization, polygon ops, both offset routines, multi-piece half-plane split. |
| `src/graph.js` | 506 | `RoadGraph` + spatial hashes, growth loop, the local constraints, face extraction. The heart of it. |
| `src/fields.js` | 150 | `water()` signed distance, `population()`, `direction()`, `exclusion()`, value noise. |
| `src/blocks.js` | 111 | Face → buildable polygon → parcels → frontage → building fit. |
| `src/fabric.js` | 202 | The graph pipeline, wiring the above into the model. |
| `src/presets.js` | 134 | The five morphologies. Pure parameter data + a `sources()` recipe each. |
| `src/corridors.js` | 49 | Chains edges by `roadId` into named streets. |
| `src/model.js` | 385 | Engine switch, land, rail, the legacy BSP fabric, `addLife`. |
| `src/common.js` | 70 | Density tables, zoning, massing grammar — shared by both engines. |
| `src/ink.js` / `src/solid.js` / `src/map.js` / `src/poster.js` | 410 / 245 / 225 / 183 | Renderers. |
| `test/invariants.mjs` | 173 | The harness. Extend it with every change. |

Design rationale for all of it: `docs/V2-ROAD-GRAPH.md`. That doc records both
the plan and where the implementation deliberately deviates — read its status
block before assuming something was an oversight.

---

## 2. Non-negotiables

These are invariants of the codebase, not preferences. Breaking one produces
bugs that surface far from the cause.

**Determinism.** Same seed ⇒ byte-identical city. Invariant 8 hashes the
serialized graph and rebuilds to compare, so a violation fails the harness —
but only if your new code is on a path it exercises. Rules:

- Every random draw comes from a seeded `RNG`, never `Math.random()`.
- New subsystems take their **own namespaced stream**: `new RNG(seed + ':traffic')`.
  Do not thread an existing stream into new code — adding draws mid-stream
  reshuffles every subsystem downstream of it and silently changes all cities.
- Never iterate a `Map`/`Set` whose insertion order depends on floating-point
  comparison or hash-bucket order and let that affect output. Sort by a stable
  key (usually the numeric id) first. `nodesNear`/`edgesNear` already do.

**Coordinate quantization.** Every committed node coordinate goes through
`quantize()` (`QUANTUM = 0.25`). This is why cross products of committed points
are exact in float64 and `orient()` never wobbles near-degenerate. If you add a
path that creates nodes, quantize it.

**One orientation predicate.** `geom.js` exports `orient()`. Growth, face
extraction and the harness all use it. Do not add a second epsilon comparison
elsewhere; inconsistent predicates are how this class of system breaks.

**Virtual edges.** The city boundary square and every shoreline are inserted
into the graph as zero-width edges with class `boundary` / `shore`, *before*
growth, so streets snap to, split and T-junction onto them like any other edge
and every face closes. They are **not roads**. Any code walking `graph.edges`
must skip them:

```js
import { VIRTUAL } from './graph.js';
if (e.removed || VIRTUAL.has(e.cls)) continue;
```

Forgetting this puts phantom roads along the map border and the riverbank.

**The model contract.** Both engines emit the same shapes, so renderers have
one path:

```js
roads/bridges  { polygon, type, width, a:[x,z], b:[x,z], angle, len, cx, cz, x, z, w, d }
blocks/parks/plazas/parcels  { polygon, x, z, w, d, … }
buildings      { cx, cz, w, d, h, y, angle, zone, style, x, z }   // angle = yaw, w-axis
landmarks      { x, z, w, d, h, angle }                            // x,z = CENTRE, not corner
```

`normalizeModel()` in `model.js` backfills `polygon`/bbox/axis for anything
missing them. If you add a model list, run it through there.

**The legacy engine.** `config.engine = 'bsp'` selects the V1 rectangular
subdivision. It is kept working deliberately so a broken graph never blocks
renderer work. It does **not** produce `model.graph`, `model.corridors`, or
`model.stats` — verified. Any code touching those must guard:

```js
if (!model.graph) return;   // bsp engine
```

`main.js` already guards `stats`. The harness only exercises `engine: 'graph'`,
so BSP regressions will not be caught for you.

**Traps that already bit.** Each of these cost real debugging time:

- **Sutherland–Hodgman stitches concave polygons.** Clipping a U-shaped block
  against a half-plane joins the two arms across the notch. Use
  `clipHalfPlaneMulti()`, which pairs chains along the cut line by parity.
  The parcel-inside-block invariant caught this on seed T8.
- **Miter offset cannot represent an edge collapsing.** When a short edge
  vanishes under the inset the miter self-intersects. `offsetPolygon()` runs
  first (cheap, exact for convex blocks); `shrinkPolygon()` is the fallback
  that steps the inset and drops collapsed edges.
- **`dist` means different things per engine.** In the BSP fabric it is
  geometric distance from origin, normalized. In the graph fabric it is
  `1 - population(centroid)` — a *field* sample, so a second downtown is
  correctly "central". Both feed `massBuilding()`. Do not "fix" one to match
  the other without checking what reads it.
- **`requestAnimationFrame` never fires in an occluded window.** Defer heavy
  work with `setTimeout`, or generation hangs at "GENERATING…" behind another
  window.
- **three.js version pins must exist.** A hallucinated `0.186.0` pin once
  shipped a dead file. 0.185.1 is the pinned version in `index.html`.

---

## 3. How to work on this

1. Add the invariant *first*, then the feature. Every subtle fault in this
   system so far was found by an assertion, not by looking at a render.
2. `npm test` after every change. It is 5 seconds.
3. Look at `contact.html` before declaring something visually good. Single-seed
   judgement is unreliable — a knob that improves one seed often wrecks three.
4. Confirm ink mode still renders.
5. Measure rather than assume. Every number in this document came from a script
   over 100 seeds; two earlier assumptions about this codebase turned out to be
   wrong when measured, including one in a previous handoff summary.

---

## 4. The work

Ordered by value. Item 1 is the reason the road graph was built.

### 1. Routing and traffic — highest value

**Why.** The motivating problem in the design doc was *"there is no can-you-drive-A→B"*.
The graph now answers it. Measured over every land type × three patterns, the
drivable subgraph is a **single connected component containing 100% of nodes** —
including river cities, where 8–18 bridges keep both banks reachable. There is
no island-of-unreachable-streets case to design around.

Nothing uses this yet. Cars are placed by `addLife()` in `model.js`, which picks
a random road entry and drops a static point on it — they do not move, route, or
know that intersections exist.

This is the single biggest "the city is alive" upgrade available, and the graph
work to enable it is already done.

**Approach.** New `src/routing.js`:

- Build a drivable adjacency from `graph.edges`, skipping `removed` and
  `VIRTUAL`. (`RoadGraph.adj` is already node → edge ids.)
- Dijkstra or A* with cost = length ÷ class speed, so arterials are preferred
  over alleys. A Euclidean heuristic stays admissible as long as you scale it by
  the fastest class speed — otherwise it can overestimate and A* stops being
  optimal.
- Cars get `{ path: [edgeIds], t, speed }` instead of a fixed point. Emit their
  current `{x, z, rot}` per frame, or precompute a polyline the renderer walks.
- Renderers already orient cars by `rot` — `renderCars()` in `solid.js` and the
  `faint.obox()` call in `ink.js`. Minimal renderer change.
- Use `model.corridors` for origin/destination selection: routing between two
  *named corridors* produces traffic that reads as going somewhere, rather than
  uniform noise.

**Also nearly free once routing exists.** Station walksheds — Dijkstra from the
station node out to a distance budget, shade reachable blocks. The rail station
is at `model.rail.station` and is already a population center.

**Watch out.** Take a fresh RNG stream (`seed + ':traffic'`). Guard for
`engine: 'bsp'` (no graph). Keep `life: 'off'` working.

**Done when.** Cars follow streets and turn at intersections; a new invariant
asserts every car position lies within half a road width of a drivable edge;
determinism still holds.

### 2. Polygon building footprints (perimeter blocks)

**Why.** The design doc staged this deliberately: *buildings get a yaw before
they get polygonal footprints*, because the yaw captures most of the visual
payoff for one line of renderer change. The yaw is done. Footprints are what
euro/perimeter massing actually needs — those buildings follow the block
outline and enclose a courtyard, which an oriented box cannot express.

**Approach.** For `config.massing === 'euro'`, bypass parcel→box: take the
block's `buildable` ring, offset inward again by the desired building depth
(`shrinkPolygon` handles the concave cases), and treat the region between the
two rings as one perimeter building with a courtyard. Add optional
`footprint: [[x,z], …]` to the building contract.

**Renderer cost — the underestimated part.** `instancedBoxes()` cannot draw
these; they need a separate `ExtrudeGeometry` path. In ink mode you also need a
polygon-prism line routine (`InkLines.obox()` draws exactly 12 edges — a
footprint needs `poly()` at two heights plus verticals). Budget real time here.

**Done when.** Euro massing shows courtyard blocks in ink and solid; invariant 7
(nothing in water or a reserved corridor) is extended to test footprint
vertices, not just box corners.

### 3. Tensor-field direction

**Why.** `direction()` is currently the "shippable first cut" the doc
specified: a blended *angle* field. The target is a 2×2 symmetric traceless
tensor field per Chen et al. It buys **boundary-aligned** streets — fabric that
runs parallel to a coastline or riverbank — which the angle blend cannot
express, plus better behaviour where two grids meet.

**Approach.** Rewrite `makeDirection()` in `fields.js`. The signature
`(x, z) → angle` is deliberately unchanged from the tensor version, so **no
caller changes** — `graph.js` calls it through `nearestAligned()` only. Blend
tensors with RBF weights `e^(-d²/σ²)`, extract the major eigenvector, return
its angle. Add a `boundary` basis field seeded from `fields.water.shores`.

**Done when.** All five patterns remain distinguishable on the contact sheet, a
coastal city visibly aligns its fabric to the shore, and the DIRECTION map
overlay shows smooth blending.

### 4. Terrain

**Why.** `elevation()` is stubbed flat at `fabric.js` (`elevation: () => 0`) —
the hook exists precisely so this can land without restructuring.

**Approach.** Value-noise or diamond-square heightfield in `fields.js`. In
`commit()` (`graph.js`), reject or penalize segments exceeding a maximum grade
— that alone produces switchbacks and valley-following roads.

**Renderer cost is the real work.** Every ground is currently a flat polygon at
constant `y`. Displacing them means subdividing polygons and sampling height
per vertex, in both renderers. Do the field and the road constraint first; the
city will already look different from above in the map view before any 3D work
lands.

---

## 5. Known residuals

Small, well-characterized, none urgent.

| Thing | Current | Notes |
|---|---|---|
| Offset drops | 1.1% of blocks | Was 10.3%. What remains are **split events** — a concave block pinching into two pieces mid-offset. `shrinkPolygon` handles edge events only. A full straight skeleton would fix it; probably not worth it at 1.1%. |
| Landlocked parcels | 4.7% | Become courtyards (quiet park fill). The design doc's preferred handling was **merge into a neighbour**; running an alley to them (adding graph edges) is the other option. |
| Sliver parcels dropped | ~2,400 per 100 cities | Filtered by area and min dimension in `subdivideParcels`. Expected, not a fault. |
| Corridor names | German-flavoured stems in `corridors.js` | No language/theme switch. Trivial to add, would pair with the poster's massing themes. |
| BSP engine | Untested by harness | Deliberate — it is legacy. If it starts mattering again, parameterize the harness over `engine`. |

---

## 6. Explicitly not in scope

Named so they do not creep in. From the design doc §10, still true:

- Building interiors, floor plans, CGA façade grammars (Müller et al. 2006 —
  a separate axis, one layer below this one)
- LOD / streaming for very large cities
- Editing tools (painting fields by hand, dragging streets)
- Multiplayer, persistence, or any server component

---

## References

- Parish & Müller, *Procedural Modeling of Cities*, SIGGRAPH 2001 — the
  road-growth / lot-subdivision pipeline this follows.
- Chen, Esch, Wonka, Müller & Zhang, *Interactive Procedural Street Modeling*,
  SIGGRAPH 2008 — tensor-field street direction (item 3).
- Müller, Wonka, Haegler, Ulmer & Van Gool, *Procedural Modeling of Buildings*,
  SIGGRAPH 2006 — CGA shape grammars (out of scope, for later).
- Aichholzer & Aurenhammer, straight skeleton — correct polygon offsetting
  (§5, the residual 1.1%).
