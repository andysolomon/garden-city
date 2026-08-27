// Invariant harness for the road-graph engine (docs/V2-ROAD-GRAPH.md §8).
// Run: npm test   (node ≥ 18, no dependencies)
//
// Generates ~100 cities spanning every pattern / land / density / rail combo
// and asserts fabric plus route-aware traffic invariants on each. Exits
// non-zero on any failure.

import { generateCity, WALKSHED_BUDGET } from '../src/model.js';
import { resolvePreset } from '../src/presets.js';
import { hashSeed } from '../src/rng.js';
import { VIRTUAL } from '../src/graph.js';
import { buildDrivableAdjacency, lengthBudgetDijkstra, shortestPath, positionOnRoute } from '../src/routing.js';
import {
  segmentsTouch, signedArea, isSimple, area, pointInPolygon, distToBoundary, orientedRect, pointSegDist,
} from '../src/geom.js';

const PATTERNS = ['manhattan', 'paris', 'tokyo', 'medieval', 'atlanta'];
const LANDS = ['flat', 'river', 'coast', 'island'];
const DENS = ['low', 'med', 'high', 'extreme'];
const RAILS = ['none', 'metro', 'elevated', 'terminal'];
const N = Number(process.argv[2] || 100);

const failures = [];
const totals = { corridorLen: [], faces: 0, blocks: 0, offsetDrops: 0, parcels: 0, landlocked: 0, slivers: 0, degenerate: 0, buildings: 0, ms: 0 };

function check(seed, cond, msg) { if (!cond) failures.push(`${seed}: ${msg}`); }

function routeHasTurn(g, car) {
  for (let i = 1; i < car.nodes.length - 1; i++) {
    const a = g.nodes[car.nodes[i - 1]], b = g.nodes[car.nodes[i]], c = g.nodes[car.nodes[i + 1]];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    const scale = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z);
    if (Math.abs(cross) > scale * .08) return true;
  }
  return false;
}

function checkTraffic(seed, m) {
  const g = m.graph;
  const adjacency = buildDrivableAdjacency(g);
  for (let node = 0; node < adjacency.length; node++) for (const step of adjacency[node]) {
    const edge = g.edges[step.edge];
    check(seed, !edge.removed && !VIRTUAL.has(edge.cls), `adjacency contains non-drivable edge ${step.edge}`);
    check(seed, edge.a === node || edge.b === node, `adjacency edge ${step.edge} is not incident to node ${node}`);
  }

  let turns = 0;
  for (const [ci, car] of m.cars.entries()) {
    check(seed, Array.isArray(car.path) && car.path.length > 1, `car ${ci} has no drivable route`);
    check(seed, Array.isArray(car.nodes) && car.nodes.length === car.path.length + 1, `car ${ci} route node/edge mismatch`);
    check(seed, Number.isFinite(car.routeLength) && car.routeLength > 0, `car ${ci} has invalid route length`);
    check(seed, Number.isFinite(car.t) && car.t >= 0 && car.t <= car.routeLength, `car ${ci} has invalid distance progress`);
    check(seed, Number.isFinite(car.speed) && car.speed > 0, `car ${ci} has invalid speed`);
    check(seed, [car.x, car.z, car.rot].every(Number.isFinite), `car ${ci} has invalid current transform`);
    check(seed, typeof car.originCorridor === 'string' && typeof car.destinationCorridor === 'string'
      && car.originCorridor !== car.destinationCorridor && car.originCorridorId !== car.destinationCorridorId,
    `car ${ci} lacks distinct named corridors`);
    const origin = m.corridors.find(c => c.id === car.originCorridorId && c.name === car.originCorridor);
    const destination = m.corridors.find(c => c.id === car.destinationCorridorId && c.name === car.destinationCorridor);
    check(seed, !!origin && origin.nodeIds.includes(car.nodes[0]), `car ${ci} start is not on its origin corridor`);
    check(seed, !!destination && destination.nodeIds.includes(car.nodes.at(-1)), `car ${ci} end is not on its destination corridor`);
    const distance = car.path.reduce((sum, edge) => sum + g.edgeLength(edge), 0);
    check(seed, Math.abs(distance - car.routeLength) < 1e-7, `car ${ci} route length does not match path`);
    for (let i = 0; i < car.path.length; i++) {
      const edgeId = car.path[i], edge = g.edges[edgeId];
      check(seed, Number.isInteger(edgeId) && edgeId >= 0 && edgeId < g.edges.length, `car ${ci} has invalid edge id ${edgeId}`);
      check(seed, !!edge && !edge.removed && !VIRTUAL.has(edge.cls), `car ${ci} uses non-drivable edge ${car.path[i]}`);
      check(seed, edge && ((edge.a === car.nodes[i] && edge.b === car.nodes[i + 1]) || (edge.b === car.nodes[i] && edge.a === car.nodes[i + 1])), `car ${ci} route disconnects at edge ${i}`);
    }
    const reroute = shortestPath(g, car.nodes[0], car.nodes.at(-1), adjacency);
    check(seed, !!reroute && JSON.stringify(reroute.path) === JSON.stringify(car.path), `car ${ci} path is not deterministic shortest route`);
    const atStart = positionOnRoute(g, car, 0);
    check(seed, Math.hypot(atStart.x - car.x, atStart.z - car.z) < 1e-7 && Math.abs(atStart.rot - car.rot) < 1e-7, `car ${ci} current transform is not its route position`);
    for (const elapsed of [0, 7.25, 31.5, 93]) {
      const p = positionOnRoute(g, car, elapsed), edge = g.edges[p.edge];
      check(seed, car.path.includes(p.edge) && [p.x, p.z, p.rot].every(Number.isFinite), `car ${ci} has invalid sampled transform at t=${elapsed}`);
      if (!edge) continue;
      const a = g.nodes[edge.a], b = g.nodes[edge.b];
      const clearance = pointSegDist(p.x, p.z, a.x, a.z, b.x, b.z).d;
      check(seed, !edge.removed && !VIRTUAL.has(edge.cls) && clearance <= edge.width / 2 + 1e-7, `car ${ci} leaves road clearance at t=${elapsed}`);
    }
    if (routeHasTurn(g, car)) turns++;
  }
  if (m.cars.length) check(seed, turns > 0, 'no routed car turns at an intersection');
}

function checkWalkshed(seed, m, expected) {
  if (!expected) {
    check(seed, !m.walkshed, 'unexpected walkshed metadata');
    check(seed, !m.blocks.some(b => 'walkshed' in b), 'unexpected walkshed block annotation');
    return;
  }
  const w = m.walkshed, g = m.graph;
  check(seed, !!w && !!g, 'station graph city lacks walkshed metadata');
  if (!w || !g) return;
  check(seed, w.start === w.stationNode && w.budget === WALKSHED_BUDGET, 'walkshed origin or budget mismatch');
  check(seed, w.nodeIds.length > 1 && w.edgeIds.length > 0, 'walkshed traversal is empty');
  check(seed, w.distances.length === w.nodeIds.length, 'walkshed node/distance mismatch');
  check(seed, w.nodeIds.every((id, i) => i === 0 || w.nodeIds[i - 1] < id), 'walkshed node IDs are not stable');
  check(seed, w.edgeIds.every((id, i) => i === 0 || w.edgeIds[i - 1] < id), 'walkshed edge IDs are not stable');
  const adjacency = buildDrivableAdjacency(g), nodeSet = new Set(w.nodeIds);
  const station = m.rail.station, sx = station.x + station.w / 2, sz = station.z + station.d / 2;
  let nearest = -1, nearestDistance = Infinity;
  for (let node = 0; node < g.nodes.length; node++) {
    if (!adjacency[node].length) continue;
    const p = g.nodes[node], d = Math.hypot(p.x - sx, p.z - sz);
    if (d < nearestDistance - 1e-12 || (Math.abs(d - nearestDistance) <= 1e-12 && node < nearest)) { nearest = node; nearestDistance = d; }
  }
  check(seed, w.stationNode === nearest && Math.abs(w.stationDistance - nearestDistance) < 1e-9, 'walkshed did not choose nearest live real node');
  for (let i = 0; i < w.nodeIds.length; i++) check(seed, w.distances[i] >= 0 && w.distances[i] <= w.budget + 1e-9, `walkshed node ${w.nodeIds[i]} exceeds budget`);
  for (const edgeId of w.edgeIds) {
    const e = g.edges[edgeId];
    check(seed, !!e && !e.removed && !VIRTUAL.has(e.cls), `walkshed contains non-drivable edge ${edgeId}`);
    check(seed, e && nodeSet.has(e.a) && nodeSet.has(e.b), `walkshed edge ${edgeId} has unreachable endpoint`);
  }
  let marked = 0;
  for (const block of m.blocks) {
    let nearestBlock = -1, nearestBlockDistance = Infinity;
    for (let node = 0; node < g.nodes.length; node++) {
      if (!adjacency[node].length) continue;
      const p = g.nodes[node], d = Math.hypot(p.x - block.cx, p.z - block.cz);
      if (d < nearestBlockDistance - 1e-12 || (Math.abs(d - nearestBlockDistance) <= 1e-12 && node < nearestBlock)) {
        nearestBlock = node;
        nearestBlockDistance = d;
      }
    }
    const qualifies = nearestBlock >= 0 && nodeSet.has(nearestBlock);
    check(seed, block.walkshed === qualifies, 'walkshed block annotation does not match nearest live node to centroid');
    if (block.walkshed) marked++;
  }
  check(seed, marked > 0, 'walkshed marks no blocks');
}

// Focused sampler checks keep renderer time out of the model and exercise the
// two route boundaries that broad generation invariants do not hit exactly.
function checkRouteMotion() {
  const graph = {
    nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    edges: [{ a: 0, b: 1, width: 8, bridge: false }, { a: 1, b: 2, width: 8, bridge: false }],
    edgeLength(id) {
      const e = this.edges[id], a = this.nodes[e.a], b = this.nodes[e.b];
      return Math.hypot(b.x - a.x, b.z - a.z);
    },
  };
  const car = { path: [0, 1], nodes: [0, 1, 2], routeLength: 20, t: 0, speed: 5 };
  const before = JSON.stringify(car);
  const p0 = positionOnRoute(graph, car, 0), p1 = positionOnRoute(graph, car, .5);
  check('focused/route-motion', p1.x > p0.x, 'elapsed progress did not move the car');

  const turnBefore = positionOnRoute(graph, car, 9.9 / car.speed);
  const turnAfter = positionOnRoute(graph, car, 10.1 / car.speed);
  check('focused/route-motion', Math.abs(turnBefore.rot - turnAfter.rot) > .5, 'turn heading did not change');

  const end = positionOnRoute(graph, car, car.routeLength / car.speed);
  const afterEnd = positionOnRoute(graph, car, car.routeLength / car.speed + .01);
  check('focused/route-motion', Math.hypot(end.x - afterEnd.x, end.z - afterEnd.z) < .1, 'route-end reversal teleported');
  const cycle = positionOnRoute(graph, car, car.routeLength * 2 / car.speed);
  check('focused/route-motion', Math.hypot(cycle.x - p0.x, cycle.z - p0.z) < 1e-7 && Math.abs(cycle.rot - p0.rot) < 1e-7, 'route cycle did not loop');
  check('focused/route-motion', JSON.stringify(car) === before, 'route sampling mutated the car');
}

checkRouteMotion();

// Physical-length traversal is independent of road class speed and excludes
// both removed and virtual edges. Results remain numerically ordered.
function checkLengthBudgetTraversal() {
  const graph = {
    nodes: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 9 }, { x: 0, z: 1 }],
    edges: [
      { a: 0, b: 1, cls: 'arterial', removed: false },
      { a: 1, b: 2, cls: 'local', removed: false },
      { a: 0, b: 3, cls: 'collector', removed: false },
      { a: 2, b: 3, cls: 'local', removed: true },
      { a: 0, b: 4, cls: 'boundary', removed: false },
    ],
  };
  const first = lengthBudgetDijkstra(graph, 0, 10), second = lengthBudgetDijkstra(graph, 0, 10);
  check('focused/walkshed-traversal', JSON.stringify(first) === JSON.stringify(second), 'length-budget traversal is non-deterministic');
  check('focused/walkshed-traversal', JSON.stringify(first?.nodeIds) === '[0,1,2,3]', 'length-budget traversal reached wrong nodes');
  check('focused/walkshed-traversal', JSON.stringify(first?.edgeIds) === '[0,1,2]', 'length-budget traversal included wrong edges');
  check('focused/walkshed-traversal', JSON.stringify(first?.distances) === '[0,5,10,9]', 'length-budget traversal returned wrong distances');
}

checkLengthBudgetTraversal();

// Regression: the T159 terminal on an extreme Atlanta island must mark a
// centroid-qualified block within the fixed physical-length budget.
{
  const config = {
    seed: 'T159', engine: 'graph', pattern: 'atlanta', land: 'island',
    density: 'extreme', rail: 'terminal', massing: 'industrial', sector: 'mixed',
    detail: 'med', life: 'low', air: 'sparse',
  };
  const m = generateCity(config);
  checkWalkshed('focused/T159', m, true);
  check('focused/T159', m.blocks.some(b => b.walkshed), 'T159 terminal walkshed marks no blocks');
}

for (let i = 0; i < N; i++) {
  const config = {
    seed: `T${i}`, engine: 'graph',
    pattern: PATTERNS[i % PATTERNS.length], land: LANDS[(i >> 1) % LANDS.length],
    density: DENS[(i >> 3) % DENS.length], rail: RAILS[(i >> 2) % RAILS.length],
    massing: ['mixed', 'core', 'euro', 'lowrise', 'industrial'][i % 5], sector: 'mixed',
    detail: 'med', life: 'low', air: 'sparse',
  };
  const t0 = performance.now();
  const m = generateCity(config);
  totals.ms += performance.now() - t0;
  const seed = `${config.seed}/${config.pattern}/${config.land}/${config.density}/${config.rail}`;
  const g = m.graph, P = resolvePreset(config.pattern);
  const live = g.edges.map((e, id) => ({ ...e, id })).filter(e => !e.removed);

  // 1. Planarity: no two live edges share a point other than a common endpoint.
  {
    const cell = 40, grid = new Map();
    const key = (x, z) => `${x},${z}`;
    for (const e of live) {
      const a = g.nodes[e.a], b = g.nodes[e.b];
      for (let cx = Math.floor(Math.min(a.x, b.x) / cell); cx <= Math.floor(Math.max(a.x, b.x) / cell); cx++)
        for (let cz = Math.floor(Math.min(a.z, b.z) / cell); cz <= Math.floor(Math.max(a.z, b.z) / cell); cz++) {
          const k = key(cx, cz);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(e);
        }
    }
    const tested = new Set();
    let bad = 0;
    for (const arr of grid.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const p = arr[i], q = arr[j], pk = p.id < q.id ? `${p.id}-${q.id}` : `${q.id}-${p.id}`;
      if (tested.has(pk)) continue;
      tested.add(pk);
      const a = g.nodes[p.a], b = g.nodes[p.b], c = g.nodes[q.a], d = g.nodes[q.b];
      if (segmentsTouch(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) { bad++; if (bad <= 3) failures.push(`${seed}: edges ${p.id} and ${q.id} intersect`); }
    }
  }

  // 2. Node spacing: no two live nodes closer than snapRadius.
  {
    const liveNode = new Uint8Array(g.nodes.length);
    for (const e of live) { liveNode[e.a] = 1; liveNode[e.b] = 1; }
    const cell = P.snapRadius, buckets = new Map();
    let bad = 0;
    for (let n = 0; n < g.nodes.length; n++) {
      if (!liveNode[n]) continue;
      const p = g.nodes[n], cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = buckets.get(`${cx + dx},${cz + dz}`);
        if (arr) for (const o of arr) {
          const q = g.nodes[o];
          if (Math.hypot(p.x - q.x, p.z - q.z) < P.snapRadius - 1e-6) { bad++; if (bad <= 3) failures.push(`${seed}: nodes ${n} and ${o} are ${Math.hypot(p.x - q.x, p.z - q.z).toFixed(2)} apart`); }
        }
      }
      const k = `${cx},${cz}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(n);
    }
  }

  // 3. Faces simple with positive area under CCW winding.
  for (const f of m.faces) {
    check(seed, signedArea(f.polygon) > 0, `face ${f.id} not CCW`);
    check(seed, isSimple(f.polygon), `face ${f.id} not simple`);
    check(seed, f.edges.length === f.polygon.length, `face ${f.id} edge/vertex mismatch`);
  }

  // 4. Area conservation: faces tile the region enclosed by the kept component.
  {
    const sum = m.faces.reduce((s, f) => s + f.area, 0);
    const expect = config.land === 'island' ? area(m.fields.water.shores[0].pts) : m.size * m.size;
    check(seed, Math.abs(sum - expect) / expect < 0.005 || m.stats.degenerateFaces > 0, `face areas sum to ${sum.toFixed(0)} vs ${expect.toFixed(0)}`);
    totals.degenerate += m.stats.degenerateFaces;
  }

  // 5. Parcels lie inside their block; Σ parcel areas ≤ buildable area.
  {
    const perBlock = new Map();
    for (const p of m.parcels) {
      const B = p.block.buildable;
      for (const [x, z] of p.polygon) {
        check(seed, pointInPolygon(x, z, B) || distToBoundary(x, z, B) < 1e-3, `parcel vertex outside block`);
      }
      perBlock.set(p.block, (perBlock.get(p.block) || 0) + area(p.polygon));
    }
    for (const [b, a] of perBlock) check(seed, a <= area(b.buildable) * (1 + 1e-6), `parcel area ${a.toFixed(0)} exceeds block ${area(b.buildable).toFixed(0)}`);
  }

  // 6. Every built parcel has frontage.
  for (const p of m.parcels) if (p.built) check(seed, !!p.frontage, 'built parcel without frontage');

  // 7. No building in water or inside a reserved corridor.
  for (const b of m.buildings) {
    for (const [x, z] of orientedRect(b.cx, b.cz, b.w, b.d, b.angle)) {
      check(seed, m.fields.water.isLand(x, z), `building at ${x.toFixed(0)},${z.toFixed(0)} in water`);
      for (const r of m.reserved) check(seed, !(x > r.x + .5 && x < r.x + r.w - .5 && z > r.z + .5 && z < r.z + r.d - .5), `building corner inside reserved corridor`);
    }
  }

  // 9. Corridors: every real edge belongs to exactly one corridor, and each
  //    corridor is one connected chain (edge i shares a node with edge i+1).
  {
    const seen = new Map();
    for (const c of m.corridors) {
      check(seed, c.orphan === 0, `corridor ${c.id} has ${c.orphan} unchained edges`);
      for (let i = 0; i < c.edgeIds.length; i++) {
        const ei = c.edgeIds[i];
        check(seed, !seen.has(ei), `edge ${ei} in two corridors`);
        seen.set(ei, c.id);
        if (i) {
          const p = g.edges[c.edgeIds[i - 1]], q = g.edges[ei];
          check(seed, [p.a, p.b].includes(q.a) || [p.a, p.b].includes(q.b), `corridor ${c.id} not a chain at edge ${i}`);
        }
      }
    }
    for (const e of live) if (!VIRTUAL.has(e.cls)) check(seed, seen.has(e.id), `edge ${e.id} in no corridor`);
  }

  // 10-12. Routed traffic uses only live real edges, stays within road
  // clearance while moving, and includes an intersection turn.
  checkTraffic(seed, m);
  checkWalkshed(seed, m, config.rail === 'terminal');

  // 8 + 13. City and traffic determinism.
  {
    const ser = mm => JSON.stringify({
      n: mm.graph.nodes, e: mm.graph.edges.map(e => [e.a, e.b, e.cls, e.removed]),
      b: mm.buildings.map(b => [b.cx, b.cz, b.w, b.d, b.h, b.angle]),
      w: mm.walkshed, wb: mm.blocks.map(b => b.walkshed),
      c: mm.cars.map(c => [c.x, c.z, c.rot, c.path, c.nodes, c.routeLength, c.t, c.speed, c.originCorridor, c.originCorridorId, c.destinationCorridor, c.destinationCorridorId]),
    });
    const h1 = hashSeed(ser(m)), h2 = hashSeed(ser(generateCity({ ...config })));
    check(seed, h1 === h2, 'non-deterministic');
  }

  totals.faces += m.faces.length; totals.blocks += m.blocks.length; totals.offsetDrops += m.stats.offsetDrops;
  totals.parcels += m.parcels.length; totals.landlocked += m.stats.landlocked; totals.slivers += m.stats.slivers;
  totals.buildings += m.buildings.length;
  const lens = m.corridors.filter(c => c.cls === 'arterial').map(c => c.length).sort((a, b) => a - b);
  if (lens.length) totals.corridorLen.push(lens[lens.length >> 1]);
}

// Focused rail matrix: only graph terminals have stations and therefore a
// walkshed; other rail variants preserve their existing no-station contract.
for (const rail of RAILS) {
  const config = {
    seed: `WALKSHED-${rail}`, engine: 'graph', pattern: 'manhattan', land: 'flat',
    density: 'med', rail, massing: 'mixed', sector: 'mixed', detail: 'med', life: 'off', air: 'sparse',
  };
  const m = generateCity(config), repeat = generateCity({ ...config });
  checkWalkshed(`focused/${rail}`, m, rail === 'terminal');
  check(`focused/${rail}`, JSON.stringify(m.walkshed) === JSON.stringify(repeat.walkshed)
    && JSON.stringify(m.blocks.map(b => b.walkshed)) === JSON.stringify(repeat.blocks.map(b => b.walkshed)), 'non-deterministic walkshed annotations');
}

// Focused life/land matrix: off remains empty, while low/high traffic routes
// are valid and reproducible for every supported terrain.
for (const [li, land] of LANDS.entries()) for (const life of ['off', 'low', 'high']) {
  const config = {
    seed: `TRAFFIC-${land}-${life}`, engine: 'graph', pattern: PATTERNS[li], land,
    density: 'med', rail: 'none', massing: 'mixed', sector: 'mixed', detail: 'med', life, air: 'sparse',
  };
  const m = generateCity(config), seed = `${config.seed}/${config.pattern}`;
  if (life === 'off') check(seed, m.cars.length === 0, 'life=off generated cars');
  else checkTraffic(seed, m);
  const cars = mm => JSON.stringify(mm.cars.map(c => [c.x, c.z, c.rot, c.path, c.nodes, c.t, c.speed]));
  check(seed, hashSeed(cars(m)) === hashSeed(cars(generateCity({ ...config }))), `non-deterministic ${life} traffic`);
}

// BSP remains a deliberately static fallback: it has no graph or corridor
// metadata, but low/high life still emit the legacy {x,z,rot} car contract.
for (const life of ['low', 'high']) {
  const config = {
    seed: `BSP-TRAFFIC-${life}`, engine: 'bsp', pattern: 'manhattan', land: 'flat',
    density: 'med', rail: 'none', massing: 'mixed', sector: 'mixed', detail: 'med', life, air: 'sparse',
  };
  const m = generateCity(config), seed = `${config.seed}/${config.engine}`;
  check(seed, !m.graph && !m.corridors && !m.stats, 'BSP unexpectedly exposes graph traffic metadata');
  check(seed, m.cars.length > 0, `BSP life=${life} generated no legacy cars`);
  for (const [ci, car] of m.cars.entries()) {
    check(seed, !car.path && [car.x, car.z, car.rot].every(Number.isFinite), `BSP car ${ci} lost static placement contract`);
  }
}

{
  const config = {
    seed: 'BSP-WALKSHED', engine: 'bsp', pattern: 'manhattan', land: 'flat',
    density: 'med', rail: 'terminal', massing: 'mixed', sector: 'mixed', detail: 'med', life: 'off', air: 'sparse',
  };
  checkWalkshed('focused/bsp-terminal', generateCity(config), false);
}

const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1) + '%';
console.log(`cities: ${N}  avg ${(totals.ms / N).toFixed(0)}ms`);
console.log(`faces ${totals.faces}  blocks ${totals.blocks}  offset drops ${pct(totals.offsetDrops, totals.blocks)}  degenerate faces ${totals.degenerate}`);
const cl = totals.corridorLen.sort((a, b) => a - b);
console.log(`arterial corridor median length (median over cities): ${cl[cl.length >> 1].toFixed(0)}`);
console.log(`parcels ${totals.parcels}  landlocked ${pct(totals.landlocked, totals.parcels)}  slivers dropped ${totals.slivers}  buildings ${totals.buildings}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES`);
  for (const f of failures.slice(0, 40)) console.log('  ' + f);
  process.exit(1);
}
console.log('all invariants hold');
