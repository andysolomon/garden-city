// Invariant harness for the road-graph engine (docs/V2-ROAD-GRAPH.md §8).
// Run: npm test   (node ≥ 18, no dependencies)
//
// Generates ~100 cities spanning every pattern / land / density / rail combo
// and asserts fabric plus route-aware traffic invariants on each. Exits
// non-zero on any failure.

import { generateCity } from '../src/model.js';
import { resolvePreset } from '../src/presets.js';
import { hashSeed } from '../src/rng.js';
import { VIRTUAL } from '../src/graph.js';
import { buildDrivableAdjacency, shortestPath, positionOnRoute } from '../src/routing.js';
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
    check(seed, car.nodes.length === car.path.length + 1, `car ${ci} route node/edge mismatch`);
    check(seed, !!car.originCorridor && !!car.destinationCorridor && car.originCorridorId !== car.destinationCorridorId, `car ${ci} lacks distinct named corridors`);
    for (let i = 0; i < car.path.length; i++) {
      const edge = g.edges[car.path[i]];
      check(seed, !!edge && !edge.removed && !VIRTUAL.has(edge.cls), `car ${ci} uses non-drivable edge ${car.path[i]}`);
      check(seed, edge && ((edge.a === car.nodes[i] && edge.b === car.nodes[i + 1]) || (edge.b === car.nodes[i] && edge.a === car.nodes[i + 1])), `car ${ci} route disconnects at edge ${i}`);
    }
    const reroute = shortestPath(g, car.nodes[0], car.nodes.at(-1), adjacency);
    check(seed, !!reroute && JSON.stringify(reroute.path) === JSON.stringify(car.path), `car ${ci} path is not deterministic shortest route`);
    for (const elapsed of [0, 7.25, 31.5, 93]) {
      const p = positionOnRoute(g, car, elapsed), edge = g.edges[p.edge];
      const a = g.nodes[edge.a], b = g.nodes[edge.b];
      const clearance = pointSegDist(p.x, p.z, a.x, a.z, b.x, b.z).d;
      check(seed, clearance <= edge.width / 2 + 1e-7, `car ${ci} leaves road clearance at t=${elapsed}`);
    }
    if (routeHasTurn(g, car)) turns++;
  }
  if (m.cars.length) check(seed, turns > 0, 'no routed car turns at an intersection');
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

  // 8 + 13. City and traffic determinism.
  {
    const ser = mm => JSON.stringify({
      n: mm.graph.nodes, e: mm.graph.edges.map(e => [e.a, e.b, e.cls, e.removed]),
      b: mm.buildings.map(b => [b.cx, b.cz, b.w, b.d, b.h, b.angle]),
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
