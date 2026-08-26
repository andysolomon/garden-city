# V2: The Road Graph

Design plan for replacing rectangular subdivision with a planar road graph.

Status: **implemented (P0–P5).** The road graph is the default engine;
the V1 subdivision generator remains behind `config.engine = 'bsp'`.

Where things live:

| Piece | File |
|---|---|
| Geometry kernel (orientation predicate, quantization, polygon ops, multi-piece half-plane split) | `src/geom.js` |
| Fields: water SDF from shore polylines, population, blended-angle direction, exclusion | `src/fields.js` |
| Flat graph + spatial hashes, growth loop, local constraints, face extraction | `src/graph.js` |
| Per-edge inward offset, OBB parcel split, frontage, building fit | `src/blocks.js` |
| Graph fabric: fields → growth → faces → blocks → parcels → buildings | `src/fabric.js` |
| Morphology presets (manhattan / paris / tokyo / medieval / atlanta) | `src/presets.js` |
| Top-down debug map with layer toggles | `src/map.js` (MODE → MAP / DEBUG) |
| Contact sheet (N seeds as thumbnails) | `contact.html` |
| Corridor aggregation + street names | `src/corridors.js` |
| Invariant harness, 100 seeds | `test/invariants.mjs` (`npm test`) |

Deviations from the plan below, all deliberate:
- The city boundary square and every shoreline are inserted into the graph as
  zero-width `boundary` / `shore` edges before growth, so streets snap to,
  split and T-junction onto them like any other edge and every face closes.
  Water faces are discarded by centroid; bridges are committed at proposal
  time by scanning the water SDF along the ray (§4 step 1).
- Only the largest connected component is kept before face extraction
  (an island's fabric is not attached to the boundary square).
- Parcel splitting uses a multi-piece half-plane clip instead of
  Sutherland–Hodgman — SH stitches disjoint pieces of a concave block
  together, which the parcel-inside-block invariant caught on seed T8.
- Landlocked parcels become courtyards (rendered as quiet park fill) rather
  than being merged; the rate is ~5% across the harness.
- Block offset is miter first, then a **stepped shrink** (`shrinkPolygon`)
  when the miter self-intersects: the polygon is inset in small steps and
  any edge that collapses is removed before the next step — a discretized
  straight skeleton that handles edge events. Split events (a concave block
  pinching in two) still drop; the residual rate is ~1%.
- Arterials and collectors **continue straight through** a road they cross
  or an intersection they land on (locals still end at the first road they
  meet), and a segment whose interior runs within 0.4 × block spacing of a
  near-parallel edge is rejected. Together these make avenues corridors
  across the city instead of chains of T-junctions. Corridors are
  aggregated by `roadId` in `src/corridors.js` and named deterministically;
  the map's LABELS layer and the poster's [STREETS] panel show them.

---

## 1. Why

Today `generateCity()` builds streets by recursively splitting a rectangle:
each split lays one road and recurses into the two halves. Leaf rectangles
become blocks. It is ~40 lines, it is fast, and it is a dead end.

What it structurally cannot express:

| Missing | Why the BSP can't do it |
|---|---|
| Intersections | Roads are overlapping rectangles. No crossing is ever represented as data. |
| Connectivity | There is no "can you drive A→B". No routing, no traffic, no transit walksheds. |
| Continuous corridors | An "arterial" is one split line, not a named street running across the city. |
| Non-orthogonal streets | Every road is axis-aligned. No diagonals, curves, radials. |
| Non-rectangular blocks | Every block is a rectangle, so every city is Cartesian. |
| Dead ends, cul-de-sacs, T-junctions | The recursion always cuts edge to edge. |
| Irregular parcels | Parcels are a grid inside a rectangle. |

The visual consequence is the one that matters: **every city we can generate is
Manhattan.** Paris, Tokyo, and a medieval core are not reachable by tuning
parameters, because the parameters sit on top of a structure that only has
right angles.

A *road graph* fixes this by making the streets a graph — nodes are
intersections, edges are street segments — and deriving everything downstream
from it. Blocks are no longer chosen; they are the **faces** of the graph.

This is the Parish & Müller pipeline (*Procedural Modeling of Cities*,
SIGGRAPH 2001): grow a street network under global goals and local
constraints, extract the enclosed areas, subdivide them into lots, then put
buildings on the lots. Chen et al. (*Interactive Procedural Street Modeling*,
SIGGRAPH 2008) is the refinement we want for controlling street *direction*.

---

## 2. The core data structure

Two representations. Build with the simple one, compile to the second once.

**During growth** — flat, easy to mutate, easy to make deterministic:

```js
graph = {
  nodes: [ { x, z, degree } ],                    // intersections + endpoints
  edges: [ { a, b, class, width, roadId } ],      // undirected, indices into nodes
  roads: [ { id, class, name, edgeIds: [] } ],    // a named corridor spanning many edges
}
```

**For face extraction** — directed half-edges with angular ordering:

```js
compiled = {
  halfEdges: [ { from, to, twin, next, face } ],
  around:    Map<nodeId, halfEdgeId[]>,           // sorted by angle, CCW
  faces:     [ { polygon: [[x,z],…], area, edgeClasses: [] } ],
}
```

Do **not** try to maintain full DCEL invariants during growth. Snapping and
edge splitting make that error-prone. Grow the flat graph, then compile once.

`class` is the road hierarchy: `highway | arterial | collector | local | alley`.
It drives width, growth priority, branch angles, bridge eligibility, and the
setback applied to blocks fronting it.

---

## 3. Fields: where morphology comes from

Everything the growth algorithm decides, it decides by sampling a field at a
point. Fields are plain functions, so they can later be swapped for painted
masks, heightmaps, or GIS data without touching the growth code.

```js
fields = {
  water(x, z),        // → signed distance; < 0 is water
  elevation(x, z),    // → metres (V2.1; flat for now)
  population(x, z),   // → 0..1 development pressure
  direction(x, z),    // → { major, minor } street angles in radians
  exclusion(x, z),    // → bool, reserved corridors / parks / no-build
}
```

`population` is a sum of Gaussian blobs at **urban centers**: one CBD, a few
secondary centers, plus a blob at each rail station and port. This is what
produces polycentric cities, and it replaces today's `dist`-from-origin
height bias with something that can have two downtowns.

`direction` is the important one — it is the entire difference between
Manhattan and Paris.

**Target implementation (tensor fields, per Chen et al.):** a 2×2 symmetric
traceless tensor at each point encodes two orthogonal directions. Basis fields
blend with radial-basis weights `e^(-d²/σ²)`:

- *grid* — constant tensor at angle θ over a region
- *radial* — eigenvector points away from a center (boulevards from a place)
- *boundary-aligned* — eigenvector parallel to a coastline or river bank
- *noise* — perturbation for organic fabric

Streets are then traced as hyperstreamlines: majors give arterials, minors
give cross-streets.

**Shippable first cut:** implement `direction(x,z)` as a blended *angle*
function with the same signature — weighted blend of a constant angle
(grid regions), `atan2` around centers (radial regions), and value-noise
perturbation (organic regions). Same interface, ~1/5 the code, upgradeable to
tensors later without changing any caller.

---

## 4. Growth: priority queue + local constraints

```
Q ← seed proposals at the CBD (and at each secondary center)
while Q not empty and edgeCount < budget:
    p ← pop lowest-priority proposal
    p' ← applyLocalConstraints(p)        // may modify, or reject
    if p' accepted:
        commit edge to graph
        push successors(p')              // forward, branch-left, branch-right
```

A proposal is `{ t, fromNode, angle, length, class, depth }`. `t` orders
growth so higher classes complete before lower ones fill in.

**Local constraints — the crux of the whole algorithm.** Applied in order to
the proposed endpoint:

1. **Water / exclusion.** Endpoint in water → reject, *unless* the class is
   bridge-eligible and the crossing span is under `maxBridgeSpan` with land on
   the far side; then commit a `bridge` edge. (This subsumes today's
   `clipRoadsToWater` post-pass — in V2 water is a constraint at growth time,
   not a cleanup afterwards.)
2. **Snap to node.** Within `snapRadius` of an existing node → connect to it
   instead of creating a new one. Prevents pairs of intersections a metre
   apart.
3. **Split edge.** Segment crosses an existing edge → truncate at the
   intersection, split the crossed edge, create a node. **This is what keeps
   the graph planar** and it is non-negotiable.
4. **Extend to edge.** Endpoint within `extendRadius` of an existing edge →
   extend to meet it, forming a T-junction, rather than dangling just short.
5. **Minimum angle.** Reject if the new edge makes an angle below `minAngle`
   with an existing edge at that node. Sliver junctions produce sliver blocks
   that produce unbuildable parcels — kill them here, at the cheapest point.
6. **Minimum length.** After truncation by 3 or 4, reject if what's left is
   shorter than `minLength`.

Successor generation is where the pattern presets bite: branch probability
from `population`, branch angle from `direction` (≈90° for grid, tangential
for radial, jittered for organic), and segment length from class.

---

## 5. Faces → blocks

Once growth is done and the graph is planar, blocks come for free.

1. **Prune spurs.** Iteratively remove degree-1 nodes and their edges into a
   separate `spurs` list (cul-de-sacs, dangling stubs). A dead end otherwise
   makes the face walk traverse the same edge in both directions and produce a
   zero-area artifact. Re-attach spurs for rendering after extraction.
2. **Sort incident half-edges by angle** at every node.
3. **Walk faces.** For directed edge `u→v`, the next edge in the face is the
   neighbour of `v` immediately *clockwise* from the direction back toward `u`.
   Follow `next` until you return to the start — that closed walk is one face.
4. **Discard the outer face.** Exactly one walk has the opposite winding /
   largest magnitude signed area. Drop it.
5. **Filter degenerates.** Zero area, area below `minBlockArea`, or
   self-intersecting → drop.

Each face carries the class of every edge on its boundary, which is what lets
step 6 apply a deep setback on the arterial frontage and a shallow one on the
alley.

---

## 6. Blocks → buildable area → parcels

**Inward offset.** Offset each block edge inward by
`roadHalfWidth(edgeClass) + setback(zone, edgeClass)`. Per-edge distances,
not one uniform inset.

Miter offset with a miter limit is fine for the mostly-convex blocks a road
graph produces. Reflex vertices and thin necks make naive offsetting
self-intersect; the correct general tool is the **straight skeleton**
(Aichholzer & Aurenhammer). Plan: implement miter + a validity pass (re-check
winding, area, and self-intersection; drop the block if it degenerates), and
only reach for a straight skeleton if the drop rate is material.

**Parcel subdivision — recursive OBB split:**

1. Take the polygon's oriented bounding box. (Use the longest edge's angle
   rather than full rotating calipers — blocks are street-aligned, so it's
   nearly always the same answer for a fraction of the cost.)
2. If `area < targetParcelArea` or `minDimension < minParcelWidth`, emit it.
3. Otherwise split with a line perpendicular to the OBB long axis at the
   midpoint ± seeded jitter; clip the polygon into two halves; recurse.
4. Drop slivers by area and aspect ratio.

`targetParcelArea` comes from `population` and zone, so density stops being a
global constant and becomes a field — small lots downtown, large lots at the
edge, from the same code path.

**Frontage is a first-class property.** A parcel is buildable only if it
touches the block boundary. Deep subdivision creates *landlocked* interior
parcels; that's the classic artifact. Options, in preference order: merge into
a neighbour, convert to block-interior courtyard/green, or run an alley to it
(which means going back and adding edges to the graph). Whichever we pick,
each parcel records `frontage: { edgeIndex, class, direction }` — that vector
is what orients the building, places its entrance, and sets its setback depth.

---

## 7. Impact on the renderers

This is the part that costs the most and is easiest to underestimate. The
`CityModel` contract changes shape, and `ink.js` / `solid.js` both assume
axis-aligned `{x, z, w, d}` rectangles everywhere.

| Model field | Today | V2 | Renderer work |
|---|---|---|---|
| `blocks`, `parks`, `plazas` | rect | `{ polygon: [[x,z],…] }` | `THREE.Shape` → `ShapeGeometry` for fills; `InkLines.poly()` for outlines. Moderate. |
| `roads` | rect | polyline + width | Ribbon mesh: quad strip with mitered joins, **plus a filled cap polygon at every intersection** or corners show notches. Fiddly — budget real time. |
| `buildings` | rect | rect + `rot` (V2.0), optional `footprint` polygon (V2.1) | V2.0 is one line in the instanced-matrix loop. V2.1 needs `ExtrudeGeometry`. |
| `bridges` | rect | graph edge flagged `bridge` | Mostly reusable. |

Deliberate staging: **buildings get a yaw before they get polygonal
footprints.** An oriented box aligned to its frontage vector captures most of
the visual payoff of non-orthogonal streets for a fraction of the renderer
work. Polygon footprints matter most for euro/perimeter blocks, which follow
the block outline — do them in V2.1 when there's something to show off.

Keep the V1 subdivision generator behind a config flag through the whole
migration, so a broken graph never blocks work on the ink renderer.

---

## 8. Verification

A road graph is the kind of system that is subtly wrong in ways an isometric
render will not reveal. Two things are non-optional:

**A top-down debug map renderer, built first.** Canvas or SVG, orthographic,
top-down, with node ids, edge classes by colour, face ids, and toggles per
layer. Debugging a planar graph through the ink view is not possible. This is
P0 for a reason.

**Invariants, asserted in a test harness over ~100 seeds:**

1. Planarity — no two edges intersect except at shared endpoints.
2. No two nodes closer than `snapRadius`.
3. Every face polygon is simple and has positive area under a fixed winding.
4. `Σ face areas + road area ≈ land area` (within tolerance).
5. Every parcel lies inside its block; `Σ parcel areas ≤ block buildable area`.
6. Every parcel carrying a building has street frontage.
7. No building intersects water or a reserved corridor.
8. **Determinism** — same seed produces an identical hash of the serialized
   graph. Guard this from day one; it is very easy to lose to a `Map`
   iteration order or a float comparison, and very annoying to find later.

Geometric robustness notes: use one epsilon-consistent orientation predicate
everywhere, quantize coordinates to a fixed grid quantum on commit to avoid
near-degenerate configurations, and put node lookups behind a spatial hash
(snap queries are the inner loop).

---

## 9. Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P0** | Field infrastructure + top-down debug map renderer | Can visualize `population`, `water`, `direction` as overlays |
| **P1** | Graph core, growth loop, local constraints | Planarity + determinism invariants pass over 100 seeds; graph renders as lines in map view |
| **P2** | Face extraction → blocks; adapter emitting OBB rects | Existing ink/solid renderers draw a graph-derived city unchanged |
| **P3** | Offset + parcel subdivision + frontage | Frontage and area invariants pass; landlocked-parcel rate under threshold |
| **P4** | Renderer upgrade: polygon grounds, road ribbons, oriented buildings | Non-orthogonal city renders correctly in ink + solid |
| **P5** | Morphology presets | Manhattan / Paris / Tokyo / medieval / Atlanta are visually distinguishable at a glance |

---

## 10. Not in scope for V2

Naming these now so they don't creep in:

- Terrain heightfield and slope-constrained roads (V2.1 — `elevation` is
  stubbed flat, the hook exists)
- Traffic or pedestrian simulation (the graph *enables* it; that's the point,
  but it isn't this milestone)
- Building interiors, floor plans, façade grammars (CGA-style shape grammars
  are a separate axis — see Müller et al. 2006)
- LOD / streaming for very large cities
- Editing tools (painting fields by hand, dragging streets)

---

## 11. Risks

- **Geometric robustness.** Snapping and edge-splitting near tolerance
  boundaries is where this class of system breaks. Mitigation: coordinate
  quantization, one shared orientation predicate, invariants from P1.
- **Renderer cost underestimated.** Road ribbons with correct intersection
  caps are more work than they look. Mitigation: P2's OBB adapter keeps the
  old renderers working while the graph stabilizes.
- **Topologically valid, visually ugly.** A correct graph can still produce a
  city that looks worse than the current BSP one. Mitigation: build a contact-
  sheet tool (render N seeds as thumbnails at once) so art-direction knobs can
  be judged across seeds quickly, not one seed at a time.
- **Losing the identity.** The ink renderer is the product. Every phase must
  end with something that renders in ink mode — never a long stretch where the
  only output is a debug map.

---

## References

- Parish & Müller, *Procedural Modeling of Cities*, SIGGRAPH 2001 — the
  road-growth / lot-subdivision pipeline this plan follows.
- Chen, Esch, Wonka, Müller & Zhang, *Interactive Procedural Street Modeling*,
  SIGGRAPH 2008 — tensor-field street direction control.
- Müller, Wonka, Haegler, Ulmer & Van Gool, *Procedural Modeling of Buildings*,
  SIGGRAPH 2006 — CGA shape grammars, relevant to the layer below this one.
- Aichholzer & Aurenhammer, straight skeleton — correct polygon offsetting.
