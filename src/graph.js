// The road graph: nodes are intersections, edges are street segments
// (docs/V2-ROAD-GRAPH.md §2, §4, §5).
//
// Growth mutates a flat graph (arrays + spatial hashes). Face extraction runs
// once afterwards on an angularly-sorted adjacency, never during growth.
//
// Virtual edge classes: `boundary` (the city square) and `shore` (water
// lines) are inserted before growth so that streets snap to them, split them
// and form T-junctions on them exactly like real roads. They carry width 0
// and are never rendered as roads; they exist so faces close properly.

import {
  quantize, dist, angleBetween, angleDiff, segIntersect, pointSegDist,
  signedArea, isSimple, ccw,
} from './geom.js';
import { nearestAligned } from './fields.js';

export const VIRTUAL = new Set(['boundary', 'shore']);

// ---------------------------------------------------------------------------
// Flat graph with spatial hashes
// ---------------------------------------------------------------------------
export class RoadGraph {
  constructor(cell = 24) {
    this.nodes = [];   // { x, z }
    this.edges = [];   // { a, b, cls, width, bridge, roadId, removed }
    this.adj = [];     // nodeId → [edgeId]
    this.cell = cell;
    this.nodeHash = new Map();
    this.edgeHash = new Map();
  }
  key(cx, cz) { return cx * 65536 + cz; }
  cellOf(v) { return Math.floor(v / this.cell); }

  addNode(x, z) {
    const id = this.nodes.length;
    this.nodes.push({ x, z });
    this.adj.push([]);
    const k = this.key(this.cellOf(x), this.cellOf(z));
    if (!this.nodeHash.has(k)) this.nodeHash.set(k, []);
    this.nodeHash.get(k).push(id);
    return id;
  }

  addEdge(a, b, props) {
    const id = this.edges.length;
    this.edges.push({ a, b, cls: props.cls, width: props.width || 0, bridge: !!props.bridge, roadId: props.roadId ?? -1, removed: false });
    this.adj[a].push(id); this.adj[b].push(id);
    this.hashEdge(id, true);
    return id;
  }

  hashEdge(id, insert) {
    const e = this.edges[id], A = this.nodes[e.a], B = this.nodes[e.b];
    const x0 = this.cellOf(Math.min(A.x, B.x)), x1 = this.cellOf(Math.max(A.x, B.x));
    const z0 = this.cellOf(Math.min(A.z, B.z)), z1 = this.cellOf(Math.max(A.z, B.z));
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz);
      if (insert) { if (!this.edgeHash.has(k)) this.edgeHash.set(k, []); this.edgeHash.get(k).push(id); }
      else { const arr = this.edgeHash.get(k); if (arr) { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); } }
    }
  }

  // Split edge `id` at (x, z): edge keeps its `a` end, a new edge takes the
  // `b` end, and the new node between them is returned.
  splitEdge(id, x, z) {
    const e = this.edges[id];
    const b = e.b;
    this.hashEdge(id, false);
    const n = this.addNode(x, z);
    e.b = n;
    this.hashEdge(id, true);
    this.adj[b] = this.adj[b].filter(k => k !== id);
    this.adj[n].push(id);
    this.addEdge(n, b, { cls: e.cls, width: e.width, bridge: e.bridge, roadId: e.roadId });
    return n;
  }

  nodesNear(x0, z0, x1, z1) {
    const out = [];
    for (let cx = this.cellOf(x0); cx <= this.cellOf(x1); cx++) for (let cz = this.cellOf(z0); cz <= this.cellOf(z1); cz++) {
      const arr = this.nodeHash.get(this.key(cx, cz));
      if (arr) for (const id of arr) out.push(id);
    }
    return out.sort((p, q) => p - q);
  }

  edgesNear(x0, z0, x1, z1) {
    const seen = new Set(), out = [];
    for (let cx = this.cellOf(x0); cx <= this.cellOf(x1); cx++) for (let cz = this.cellOf(z0); cz <= this.cellOf(z1); cz++) {
      const arr = this.edgeHash.get(this.key(cx, cz));
      if (arr) for (const id of arr) if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out.sort((p, q) => p - q);
  }

  other(edgeId, node) { const e = this.edges[edgeId]; return e.a === node ? e.b : e.a; }

  angleFrom(node, edgeId) {
    const o = this.nodes[this.other(edgeId, node)], n = this.nodes[node];
    return Math.atan2(o.z - n.z, o.x - n.x);
  }

  edgeLength(id) { const e = this.edges[id]; return dist(this.nodes[e.a].x, this.nodes[e.a].z, this.nodes[e.b].x, this.nodes[e.b].z); }

  // Find or create a node at a point that may sit on an existing edge
  // (used when inserting shore polylines that end on the boundary).
  nodeAt(x, z) {
    x = quantize(x); z = quantize(z);
    for (const n of this.nodesNear(x - 1, z - 1, x + 1, z + 1)) {
      if (this.nodes[n].x === x && this.nodes[n].z === z) return n;
    }
    for (const e of this.edgesNear(x - 1, z - 1, x + 1, z + 1)) {
      const E = this.edges[e], A = this.nodes[E.a], B = this.nodes[E.b];
      if (pointSegDist(x, z, A.x, A.z, B.x, B.z).d < 0.01) return this.splitEdge(e, x, z);
    }
    return this.addNode(x, z);
  }
}

// ---------------------------------------------------------------------------
// Priority queue (binary heap on t, then insertion sequence → deterministic)
// ---------------------------------------------------------------------------
class Heap {
  constructor() { this.a = []; this.seq = 0; }
  push(p) { p.seq = this.seq++; const a = this.a; a.push(p); let i = a.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (this.lt(a[i], a[j])) { [a[i], a[j]] = [a[j], a[i]]; i = j; } else break; } }
  pop() { const a = this.a; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.lt(a[l], a[m])) m = l; if (r < a.length && this.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
  lt(p, q) { return p.t < q.t || (p.t === q.t && p.seq < q.seq); }
  get size() { return this.a.length; }
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------
// P (growth parameters, see presets.js):
//   widths, spacing {major, minor}, lenScale, branch, arterialSelfBranch,
//   popMin, minAngle, snapRadius, extendRadius, minLength, maxTurn, jitter,
//   stopProb, bridgeP, maxBridgeSpan, maxDepth, delay, diagonals
export function growRoads({ rng, fields, P, size, budget, centers }) {
  const g = new RoadGraph();
  const H = size / 2;
  const stats = { proposals: 0, rejected: 0, bridges: 0 };

  // Boundary square.
  const c = [g.addNode(-H, -H), g.addNode(H, -H), g.addNode(H, H), g.addNode(-H, H)];
  for (let i = 0; i < 4; i++) g.addEdge(c[i], c[(i + 1) % 4], { cls: 'boundary' });

  // Shorelines.
  for (const s of fields.water.shores) {
    const ids = s.pts.map(p => g.nodeAt(p[0], p[1]));
    const n = ids.length;
    for (let i = 0; i < (s.closed ? n : n - 1); i++) g.addEdge(ids[i], ids[(i + 1) % n], { cls: 'shore' });
  }

  const Q = new Heap();
  let nextRoadId = 0;
  let realEdges = 0;

  const align = (x, z, heading) => {
    const target = nearestAligned(fields.direction(x, z), heading);
    const d = angleDiff(target, heading);
    return heading + Math.max(-P.maxTurn, Math.min(P.maxTurn, d));
  };

  const segLen = (cls, heading, x, z, pop) => {
    const major = fields.direction(x, z);
    const k = Math.round(angleDiff(nearestAligned(major, heading), major) / (Math.PI / 2));
    const base = (k % 2 === 0) ? P.spacing.major : P.spacing.minor;
    return base * P.lenScale[cls] * (1.2 - .4 * pop) * rng.float(.92, 1.08);
  };

  // Seed proposals: arterials in the four field directions at every center.
  centers.forEach((ctr, i) => {
    const node = g.addNode(quantize(ctr.x), quantize(ctr.z));
    const major = fields.direction(ctr.x, ctr.z);
    for (let k = 0; k < 4; k++) {
      const a = major + k * Math.PI / 2;
      Q.push({ t: i * 2, from: node, angle: a, cls: 'arterial', len: segLen('arterial', a, ctr.x, ctr.z, 1), depth: 0, roadId: nextRoadId++ });
    }
    if (i === 0) {
      for (let d = 0; d < (P.diagonals || 0); d++) {
        const a = major + Math.PI / 4 + d * Math.PI / 2 + rng.float(-.2, .2);
        for (const s of [0, Math.PI]) Q.push({ t: 0, from: node, angle: a + s, cls: 'arterial', free: true, len: P.spacing.major * P.lenScale.arterial, depth: 0, roadId: nextRoadId++ });
      }
    }
  });

  // --- water scan along a ray: first entry into water and first exit after it
  function scanWater(ax, az, ang, len, maxSpan) {
    if (!fields.water.shores.length) return { enter: null, exit: null };
    const cx = Math.cos(ang), sz = Math.sin(ang);
    const sdf = t => fields.water.sdf(ax + cx * t, az + sz * t);
    const step = 3;
    let enter = null, exit = null, prev = 0, prevV = sdf(0);
    // Scan only to `len` unless water was entered, then look for the far bank.
    for (let t = step; t <= (enter === null ? len : len + maxSpan); t += step) {
      const v = sdf(t);
      if (enter === null) {
        if (v < -0.5 && prevV >= -0.5) { enter = refine(prev, t, prevV, v); if (enter > len) return { enter: null, exit: null }; }
      } else if (v > 0.5) { exit = refine(prev, t, prevV, v); break; }
      prev = t; prevV = v;
    }
    return { enter, exit };
    function refine(t0, t1, v0, v1) { // linear interpolation of the zero crossing
      const f = v0 / (v0 - v1);
      return t0 + (t1 - t0) * Math.max(0, Math.min(1, f));
    }
  }

  // --- local constraints + commit (docs §4). Returns null on rejection.
  function commit(from, ex, ez, cls, opts = {}) {
    const A = g.nodes[from];
    const R = P.extendRadius, S = P.snapRadius;

    // 4. Extend to edge: pull the endpoint onto a nearby edge (overshooting
    //    slightly so the crossing test below sees a clean intersection).
    {
      let best = null;
      for (const e of g.edgesNear(ex - R, ez - R, ex + R, ez + R)) {
        const E = g.edges[e];
        if (E.removed || E.a === from || E.b === from) continue;
        const a = g.nodes[E.a], b = g.nodes[E.b];
        const d = pointSegDist(ex, ez, a.x, a.z, b.x, b.z);
        if (d.d < R && (!best || d.d < best.d)) best = d;
      }
      if (best) {
        const dx = best.x - A.x, dz = best.z - A.z, l = Math.hypot(dx, dz) || 1;
        ex = best.x + dx / l * .6; ez = best.z + dz / l * .6;
      }
    }

    // 2+3. Earliest event along the segment: a node within snapRadius of the
    //      path (snap) or a crossing with an existing edge (split).
    const bx0 = Math.min(A.x, ex) - S, bx1 = Math.max(A.x, ex) + S;
    const bz0 = Math.min(A.z, ez) - S, bz1 = Math.max(A.z, ez) + S;
    let event = null;
    for (const n of g.nodesNear(bx0, bz0, bx1, bz1)) {
      if (n === from) continue;
      const N = g.nodes[n];
      const d = pointSegDist(N.x, N.z, A.x, A.z, ex, ez);
      if (d.d <= S && (!event || d.t < event.t - 1e-9)) event = { t: d.t, type: 'node', node: n };
    }
    for (const e of g.edgesNear(bx0, bz0, bx1, bz1)) {
      const E = g.edges[e];
      if (E.removed || E.a === from || E.b === from) continue;
      const a = g.nodes[E.a], b = g.nodes[E.b];
      const it = segIntersect(A.x, A.z, ex, ez, a.x, a.z, b.x, b.z);
      if (it && (!event || it.t < event.t - 1e-9)) event = { t: it.t, type: 'cross', edge: e, x: it.x, z: it.z };
    }

    let endNode = null, splitAt = null, endX, endZ;
    if (event && event.type === 'node') endNode = event.node;
    else if (event) {
      const E = g.edges[event.edge], a = g.nodes[E.a], b = g.nodes[E.b];
      if (dist(event.x, event.z, a.x, a.z) <= S) endNode = E.a;
      else if (dist(event.x, event.z, b.x, b.z) <= S) endNode = E.b;
      else { splitAt = event.edge; endX = quantize(event.x); endZ = quantize(event.z); }
    } else { endX = quantize(ex); endZ = quantize(ez); }
    if (endNode !== null) { endX = g.nodes[endNode].x; endZ = g.nodes[endNode].z; }

    // 1. Bounds + exclusion (water is handled by the caller via scanWater).
    if (endNode === null && (Math.abs(endX) > H || Math.abs(endZ) > H)) return null;
    if (endNode === null && fields.exclusion(endX, endZ)) return null;

    // 6. Minimum length (joins into an existing node may be a bit shorter).
    const L = dist(A.x, A.z, endX, endZ);
    if (L < (endNode !== null ? P.minLength * .4 : P.minLength)) return null;
    if (endNode !== null && g.adj[endNode].some(e => g.other(e, endNode) === from)) return null;

    // 5. Minimum angle at both ends.
    const ang = Math.atan2(endZ - A.z, endX - A.x);
    for (const e of g.adj[from]) if (!g.edges[e].removed && angleBetween(g.angleFrom(from, e), ang) < P.minAngle) return null;
    if (endNode !== null) {
      for (const e of g.adj[endNode]) if (!g.edges[e].removed && angleBetween(g.angleFrom(endNode, e), ang + Math.PI) < P.minAngle) return null;
    }
    if (splitAt !== null) {
      const ea = g.angleFrom(g.edges[splitAt].a, splitAt);
      if (angleBetween(ea, ang) < P.minAngle || angleBetween(ea + Math.PI, ang) < P.minAngle) return null;
    }

    // Final verification of the exact segment that will be committed: it must
    // cross nothing (other than at its own endpoints) and pass no stray node.
    for (const e of g.edgesNear(Math.min(A.x, endX) - 1, Math.min(A.z, endZ) - 1, Math.max(A.x, endX) + 1, Math.max(A.z, endZ) + 1)) {
      const E = g.edges[e];
      if (E.removed || E.a === from || E.b === from || e === splitAt) continue;
      if (endNode !== null && (E.a === endNode || E.b === endNode)) continue;
      const a = g.nodes[E.a], b = g.nodes[E.b];
      if (segIntersect(A.x, A.z, endX, endZ, a.x, a.z, b.x, b.z, 1e-6)) return null;
    }
    for (const n of g.nodesNear(Math.min(A.x, endX) - S, Math.min(A.z, endZ) - S, Math.max(A.x, endX) + S, Math.max(A.z, endZ) + S)) {
      if (n === from || n === endNode) continue;
      const N = g.nodes[n];
      if (pointSegDist(N.x, N.z, A.x, A.z, endX, endZ).d < S) return null;
    }
    // Clearance: the interior of the segment must not run alongside a
    // near-parallel edge closer than the parallel gap (a fraction of the
    // block spacing) — two streets interleaving that closely make a sliver
    // block, not a block. Crossing edges only need snapRadius.
    const G = P.parallelGap;
    for (const e of g.edgesNear(Math.min(A.x, endX) - G, Math.min(A.z, endZ) - G, Math.max(A.x, endX) + G, Math.max(A.z, endZ) + G)) {
      const E = g.edges[e];
      if (E.removed || E.a === from || E.b === from || e === splitAt || VIRTUAL.has(E.cls)) continue;
      if (endNode !== null && (E.a === endNode || E.b === endNode)) continue;
      const a = g.nodes[E.a], b = g.nodes[E.b];
      const ea = Math.atan2(b.z - a.z, b.x - a.x);
      const parallel = Math.min(angleBetween(ea, ang), angleBetween(ea + Math.PI, ang)) < .45;
      const limit = parallel ? G : S;
      for (const t of [.25, .5, .75]) {
        if (pointSegDist(A.x + (endX - A.x) * t, A.z + (endZ - A.z) * t, a.x, a.z, b.x, b.z).d < limit) return null;
      }
    }

    // Commit.
    let node = endNode, created = false;
    if (node === null) {
      node = splitAt !== null ? g.splitEdge(splitAt, endX, endZ) : g.addNode(endX, endZ);
      created = true;
    }
    g.addEdge(from, node, { cls, width: P.widths[cls], bridge: !!opts.bridge, roadId: opts.roadId });
    realEdges++;
    if (opts.bridge) stats.bridges++;
    return { node, created, joined: splitAt };
  }

  // `through`: the street just crossed an existing road — continue forward
  // but don't branch (the crossed road already provides the cross-streets).
  function successors(p, node, ang, through = false) {
    const N = g.nodes[node];
    const pop = fields.population(N.x, N.z);
    const cls = p.cls;
    const stop = rng.bool(P.stopProb[cls] || 0);
    const popOk = cls === 'arterial' || pop >= P.popMin[cls];
    if (!stop && p.depth < P.maxDepth[cls] && popOk) {
      Q.push({ t: p.t + 1, from: node, angle: ang, cls, free: p.free, len: p.free ? p.len : segLen(cls, ang, N.x, N.z, pop), depth: p.depth + 1, roadId: p.roadId });
    }
    for (const side of [-1, 1]) {
      if (through) break;
      const prob = P.branch[cls] * (cls === 'arterial' ? 1 : (.6 + .4 * pop));
      if (!rng.bool(prob)) continue;
      let bcls = cls === 'arterial' ? (rng.bool(P.arterialSelfBranch) ? 'arterial' : 'collector')
        : cls === 'collector' ? (rng.bool(.25) ? 'collector' : 'local') : 'local';
      if (bcls !== 'arterial' && pop < P.popMin[bcls]) continue;
      const a = ang + side * Math.PI / 2;
      Q.push({ t: p.t + P.delay[bcls], from: node, angle: a, cls: bcls, len: segLen(bcls, a, N.x, N.z, pop), depth: 0, roadId: nextRoadId++ });
    }
  }

  function processProposal(p) {
    stats.proposals++;
    const A = g.nodes[p.from];
    let ang = p.free ? p.angle : align(A.x, A.z, p.angle);
    if (P.jitter) ang += rng.float(-P.jitter, P.jitter);
    let len = p.len;
    const cx = Math.cos(ang), sz = Math.sin(ang);
    const w = scanWater(A.x, A.z, ang, len, P.maxBridgeSpan);
    if (w.enter !== null) {
      const eligible = w.exit !== null && (w.exit - w.enter) <= P.maxBridgeSpan && rng.bool(P.bridgeP[p.cls] || 0);
      if (eligible) {
        let from = p.from;
        if (w.enter > P.minLength * .6) {
          const r = commit(from, A.x + cx * (w.enter + 1), A.z + sz * (w.enter + 1), p.cls, { roadId: p.roadId });
          if (!r) { stats.rejected++; return; }
          from = r.node;
        }
        const F = g.nodes[from];
        const span = w.exit + 1 - dist(A.x, A.z, F.x, F.z);
        const r2 = commit(from, F.x + cx * span, F.z + sz * span, p.cls, { bridge: true, roadId: p.roadId });
        if (!r2) { stats.rejected++; return; }
        if (r2.created) {
          const N = g.nodes[r2.node];
          Q.push({ t: p.t + 1, from: r2.node, angle: ang, cls: p.cls, free: p.free, len: segLen(p.cls, ang, N.x, N.z, fields.population(N.x, N.z)), depth: p.depth + 1, roadId: p.roadId });
        }
        return;
      }
      len = w.enter + 1;
      if (len < P.minLength) { stats.rejected++; return; }
      const r = commit(p.from, A.x + cx * len, A.z + sz * len, p.cls, { roadId: p.roadId });
      if (!r) stats.rejected++;
      return; // streets end at the water's edge
    }
    const r = commit(p.from, A.x + cx * len, A.z + sz * len, p.cls, { roadId: p.roadId });
    if (!r) { stats.rejected++; return; }
    // A street that reaches the boundary or the shore ends there. One that
    // crosses another road (split) or lands on an existing intersection
    // continues straight through — that is what makes an avenue a corridor
    // across the city instead of a chain of T-junctions.
    if (r.joined !== null && VIRTUAL.has(g.edges[r.joined].cls)) return;
    if (g.adj[r.node].some(e => VIRTUAL.has(g.edges[e].cls))) return;
    const through = !r.created || r.joined !== null;
    if (through && !P.through.includes(p.cls)) return; // locals still end at the first road they meet
    successors(p, r.node, ang, through);
  }

  let guard = 0;
  while (Q.size && realEdges < budget && guard++ < budget * 40) processProposal(Q.pop());

  stats.edges = realEdges; stats.nodes = g.nodes.length; stats.queued = Q.size;
  return { graph: g, stats };
}

// ---------------------------------------------------------------------------
// Faces (docs §5): keep the component attached to the boundary, prune spurs,
// sort half-edges by angle, walk faces, drop the outer face.
// ---------------------------------------------------------------------------
export function extractFaces(g) {
  const N = g.nodes.length;
  // 1. Keep the component with the most edges. (An island's fabric is not
  //    attached to the boundary square; a disconnected fragment elsewhere
  //    would put a phantom face over everything it sits inside.)
  const comp = new Int32Array(N).fill(-1);
  const compEdges = [];
  for (let s = 0; s < N; s++) {
    if (comp[s] !== -1) continue;
    const id = compEdges.length; compEdges.push(0);
    const stack = [s]; comp[s] = id;
    while (stack.length) {
      const n = stack.pop();
      for (const e of g.adj[n]) {
        if (g.edges[e].removed) continue;
        compEdges[id]++;
        const o = g.other(e, n);
        if (comp[o] === -1) { comp[o] = id; stack.push(o); }
      }
    }
  }
  let keep = 0;
  for (let i = 1; i < compEdges.length; i++) if (compEdges[i] > compEdges[keep]) keep = i;
  let dropped = 0;
  for (const e of g.edges) if (!e.removed && comp[e.a] !== keep) { e.removed = true; dropped++; }

  // 2. Spurs: iteratively strip degree-1 nodes. Their edges stay in the graph
  //    (they are real cul-de-sacs) but are excluded from the face walk.
  const live = g.edges.map(e => !e.removed);
  const deg = new Int32Array(N);
  g.edges.forEach((e, i) => { if (live[i]) { deg[e.a]++; deg[e.b]++; } });
  const spur = new Uint8Array(g.edges.length);
  let queue = [];
  for (let n = 0; n < N; n++) if (deg[n] === 1) queue.push(n);
  while (queue.length) {
    const n = queue.pop();
    if (deg[n] !== 1) continue;
    for (const e of g.adj[n]) {
      if (!live[e] || spur[e]) continue;
      spur[e] = 1; live[e] = false;
      const o = g.other(e, n);
      deg[n]--; deg[o]--;
      if (deg[o] === 1) queue.push(o);
    }
  }
  for (let i = 0; i < g.edges.length; i++) if (spur[i]) g.edges[i].spur = true;

  // 3. Angular adjacency of face-participating edges.
  const around = new Array(N);
  for (let n = 0; n < N; n++) {
    around[n] = g.adj[n].filter(e => live[e]).map(e => ({ e, a: g.angleFrom(n, e) }));
    around[n].sort((p, q) => p.a - q.a || p.e - q.e);
  }

  // 4. Walk half-edges. Half-edge id = edge*2 + (0: a→b, 1: b→a).
  const visited = new Uint8Array(g.edges.length * 2);
  const walks = [];
  for (let e = 0; e < g.edges.length; e++) {
    if (!live[e]) continue;
    for (let dir = 0; dir < 2; dir++) {
      if (visited[e * 2 + dir]) continue;
      const poly = [], edges = [], nodes = [];
      let ce = e, u = dir === 0 ? g.edges[e].a : g.edges[e].b;
      let v = g.other(ce, u);
      let ok = true, steps = 0;
      for (;;) {
        const hid = ce * 2 + (g.edges[ce].a === u ? 0 : 1);
        if (visited[hid]) { ok = false; break; }
        visited[hid] = 1;
        poly.push([g.nodes[u].x, g.nodes[u].z]); edges.push(ce); nodes.push(u);
        const list = around[v];
        let idx = -1;
        for (let i = 0; i < list.length; i++) if (list[i].e === ce) { idx = i; break; }
        const nxt = list[(idx + 1) % list.length].e;
        u = v; v = g.other(nxt, u); ce = nxt;
        if (ce === e && u === (dir === 0 ? g.edges[e].a : g.edges[e].b)) break;
        if (++steps > g.edges.length * 2) { ok = false; break; }
      }
      if (ok && poly.length >= 3) walks.push({ poly, edges, nodes, sa: signedArea(poly) });
    }
  }

  // 5. Outer face has the largest |area| and the minority sign.
  let outerSign = 1, best = 0;
  for (const w of walks) if (Math.abs(w.sa) > best) { best = Math.abs(w.sa); outerSign = Math.sign(w.sa); }
  const faces = [];
  let degenerate = 0;
  for (const w of walks) {
    if (Math.sign(w.sa) === outerSign || Math.abs(w.sa) < 1) continue;
    if (!isSimple(w.poly)) { degenerate++; continue; }
    const poly = w.poly, edges = w.edges;
    // Normalize to CCW while keeping edge i ↔ segment (poly[i], poly[i+1]).
    let P = poly, E = edges;
    if (signedArea(poly) < 0) {
      P = poly.slice().reverse();
      E = edges.slice().reverse();
      E.push(E.shift()); // segment j of the reversed polygon is original edge n-2-j
    }
    faces.push({ id: faces.length, polygon: P, edges: E, area: Math.abs(w.sa) });
  }
  return { faces, spurCount: g.edges.filter(e => e.spur).length, droppedEdges: dropped, degenerateFaces: degenerate };
}
