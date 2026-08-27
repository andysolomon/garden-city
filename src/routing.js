// Deterministic routing and traffic sampling over the road graph. Routing is
// deliberately plain-data: model generation can use it without importing
// three.js, and both renderers can evaluate the same car at any elapsed time.

import { VIRTUAL } from './graph.js';

export const ROUTE_SPEED = Object.freeze({ arterial: 1.45, collector: 1.12, local: .86 });

class MinHeap {
  constructor() { this.items = []; this.seq = 0; }
  push(item) {
    item.seq = this.seq++;
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < a.length && this.less(a[l], a[best])) best = l;
        if (r < a.length && this.less(a[r], a[best])) best = r;
        if (best === i) break;
        [a[i], a[best]] = [a[best], a[i]];
        i = best;
      }
    }
    return first;
  }
  less(a, b) {
    return a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && (a.node < b.node || (a.node === b.node && a.seq < b.seq)))));
  }
  get size() { return this.items.length; }
}

// node id -> [{ node, edge, length, cost }]. Removed graph edges and virtual
// face-closing edges never enter the drivable adjacency.
export function buildDrivableAdjacency(graph, speeds = ROUTE_SPEED) {
  const adjacency = graph.nodes.map(() => []);
  for (let edge = 0; edge < graph.edges.length; edge++) {
    const e = graph.edges[edge];
    if (e.removed || VIRTUAL.has(e.cls)) continue;
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const cost = length / (speeds[e.cls] || speeds.local || 1);
    adjacency[e.a].push({ node: e.b, edge, length, cost });
    adjacency[e.b].push({ node: e.a, edge, length, cost });
  }
  for (const list of adjacency) list.sort((a, b) => a.edge - b.edge || a.node - b.node);
  return adjacency;
}

// Length-limited Dijkstra for pedestrian catchments. Unlike car routing this
// uses physical edge length, not class speed. IDs are returned in numeric
// order and distances correspond one-for-one with nodeIds, making the result
// stable even when equal-distance heap entries are encountered in a different
// insertion order.
export function lengthBudgetDijkstra(graph, start, budget, adjacency = buildDrivableAdjacency(graph)) {
  if (!Number.isInteger(start) || !graph.nodes[start] || !Number.isFinite(budget) || budget < 0) return null;

  const best = new Float64Array(graph.nodes.length); best.fill(Infinity);
  const closed = new Uint8Array(graph.nodes.length);
  const reachableEdges = new Set();
  const open = new MinHeap();
  best[start] = 0;
  open.push({ node: start, g: 0, f: 0 });

  while (open.size) {
    const cur = open.pop();
    if (closed[cur.node] || cur.g !== best[cur.node]) continue;
    closed[cur.node] = 1;
    for (const step of adjacency[cur.node] || []) {
      const edge = graph.edges[step.edge];
      if (!edge || edge.removed || VIRTUAL.has(edge.cls)) continue;
      const next = cur.g + step.length;
      if (next > budget + 1e-12) continue;
      reachableEdges.add(step.edge);
      if (next >= best[step.node] - 1e-12) continue;
      best[step.node] = next;
      open.push({ node: step.node, g: next, f: next });
    }
  }

  const nodeIds = [];
  for (let node = 0; node < best.length; node++) if (Number.isFinite(best[node])) nodeIds.push(node);
  return {
    start, budget, nodeIds,
    edgeIds: [...reachableEdges].sort((a, b) => a - b),
    distances: nodeIds.map(node => best[node]),
  };
}

// A* with a fastest-road-scaled Euclidean heuristic. The result retains both
// edge and node order so route validity and per-frame geometry are explicit.
export function shortestPath(graph, start, goal, adjacency = buildDrivableAdjacency(graph), speeds = ROUTE_SPEED) {
  if (!Number.isInteger(start) || !Number.isInteger(goal) || !graph.nodes[start] || !graph.nodes[goal]) return null;
  if (start === goal) return { nodes: [start], edges: [], path: [], length: 0, cost: 0 };

  const n = graph.nodes.length;
  const best = new Float64Array(n); best.fill(Infinity);
  const prevNode = new Int32Array(n); prevNode.fill(-1);
  const prevEdge = new Int32Array(n); prevEdge.fill(-1);
  const closed = new Uint8Array(n);
  const fastest = Math.max(1, ...Object.values(speeds));
  const target = graph.nodes[goal];
  const heuristic = node => {
    const p = graph.nodes[node];
    return Math.hypot(target.x - p.x, target.z - p.z) / fastest;
  };
  const open = new MinHeap();
  best[start] = 0;
  open.push({ node: start, g: 0, f: heuristic(start) });

  while (open.size) {
    const cur = open.pop();
    if (closed[cur.node] || cur.g !== best[cur.node]) continue;
    if (cur.node === goal) break;
    closed[cur.node] = 1;
    for (const step of adjacency[cur.node] || []) {
      if (closed[step.node]) continue;
      const next = cur.g + step.cost;
      if (next >= best[step.node] - 1e-12) continue;
      best[step.node] = next;
      prevNode[step.node] = cur.node;
      prevEdge[step.node] = step.edge;
      open.push({ node: step.node, g: next, f: next + heuristic(step.node) });
    }
  }
  if (!Number.isFinite(best[goal])) return null;

  const nodes = [goal], edges = [];
  for (let node = goal; node !== start;) {
    edges.push(prevEdge[node]);
    node = prevNode[node];
    if (node < 0) return null;
    nodes.push(node);
  }
  nodes.reverse(); edges.reverse();
  const length = edges.reduce((sum, edge) => sum + graph.edgeLength(edge), 0);
  return { nodes, edges, path: edges, length, cost: best[goal] };
}

// Evaluate a route distance. Cars ping-pong at their destinations, avoiding a
// discontinuous teleport while keeping the route itself immutable.
export function positionOnRoute(graph, car, elapsed = 0) {
  const path = car.path || [];
  const nodes = car.nodes || [];
  const total = car.routeLength ?? routeLength(graph, path);
  if (!path.length || nodes.length !== path.length + 1 || !Number.isFinite(total) || total <= 0) {
    return { x: car.x, z: car.z, rot: car.rot, bridge: !!car.bridge, edge: path[0] ?? -1 };
  }

  const cycle = total * 2;
  const t = Number.isFinite(car.t) ? car.t : 0;
  const speed = Number.isFinite(car.speed) ? car.speed : 0;
  const seconds = Number.isFinite(elapsed) ? elapsed : 0;
  let phase = (t + seconds * speed) % cycle;
  if (phase < 0) phase += cycle;
  const forward = phase <= total;
  const travel = forward ? phase : cycle - phase;

  let offset = 0, index = path.length - 1;
  for (let i = 0; i < path.length; i++) {
    const length = graph.edgeLength(path[i]);
    if (travel <= offset + length || i === path.length - 1) { index = i; break; }
    offset += length;
  }
  const edge = path[index], length = graph.edgeLength(edge) || 1;
  const from = graph.nodes[nodes[index]], to = graph.nodes[nodes[index + 1]];
  const u = Math.max(0, Math.min(1, (travel - offset) / length));
  const x = from.x + (to.x - from.x) * u, z = from.z + (to.z - from.z) * u;
  const angle = Math.atan2(to.z - from.z, to.x - from.x) + (forward ? 0 : Math.PI);
  return { x, z, rot: -angle, bridge: !!graph.edges[edge].bridge, edge };
}

export function routeLength(graph, path) {
  return path.reduce((sum, edge) => sum + graph.edgeLength(edge), 0);
}
