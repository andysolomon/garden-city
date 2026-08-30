// Focused terrain-grade regression. Run: node test/grade.mjs

import assert from 'node:assert/strict';
import { generateCity } from '../src/model.js';
import { growRoads, VIRTUAL, GRADE_SAMPLE_STEP, WATER_TOLERANCE } from '../src/graph.js';
import { resolvePreset } from '../src/presets.js';
import { RNG } from '../src/rng.js';
import { buildDrivableAdjacency } from '../src/routing.js';
import { orientedRect } from '../src/geom.js';

const config = (seed, pattern, land, overrides = {}) => ({
  seed, engine: 'graph', pattern, land, density: 'high', rail: 'none',
  massing: 'mixed', sector: 'mixed', detail: 'med', life: 'off', air: 'none',
  ...overrides,
});

function signature(model) {
  return JSON.stringify({
    nodes: model.graph.nodes,
    edges: model.graph.edges.map(e => [e.a, e.b, e.cls, e.bridge, e.removed]),
    stats: model.stats,
  });
}

// Steepest sampled subsegment (≤ GRADE_SAMPLE_STEP long) of a segment.
function sampledGrade(elevation, a, b) {
  const run = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(run / GRADE_SAMPLE_STEP)), piece = run / n;
  let prev = elevation(a.x, a.z), worst = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n, h = elevation(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    worst = Math.max(worst, Math.abs(h - prev) / piece);
    prev = h;
  }
  return worst;
}

function assertGrades(model, P) {
  for (const [id, edge] of model.graph.edges.entries()) {
    if (edge.removed || edge.bridge || VIRTUAL.has(edge.cls)) continue;
    const a = model.graph.nodes[edge.a], b = model.graph.nodes[edge.b];
    const grade = sampledGrade(model.fields.elevation, a, b);
    assert.ok(grade <= P.maxGrade[edge.cls] + 1e-12,
      `edge ${id} sampled grade ${grade} exceeds ${edge.cls} limit ${P.maxGrade[edge.cls]}`);
  }
}

// No live road other than a bridge may end in water, and every live road
// (bridges included) must start on land.
function assertRoadEndpoints(model) {
  const sdf = model.fields.water.sdf;
  for (const [id, edge] of model.graph.edges.entries()) {
    if (edge.removed || VIRTUAL.has(edge.cls)) continue;
    const a = model.graph.nodes[edge.a], b = model.graph.nodes[edge.b];
    const da = sdf(a.x, a.z), db = sdf(b.x, b.z);
    const inWater = d => d < -WATER_TOLERANCE;
    if (edge.bridge) {
      assert.ok(!(inWater(da) && inWater(db)), `bridge ${id} has both ends in water`);
      continue;
    }
    assert.ok(!inWater(da) && !inWater(db), `edge ${id} (${edge.cls}) ends in water (${da}, ${db})`);
  }
}

function assertConnected(model) {
  const adjacency = buildDrivableAdjacency(model.graph);
  const active = adjacency.map((list, node) => list.length ? node : -1).filter(node => node >= 0);
  assert.ok(active.length > 1, 'city has no viable drivable graph');
  const seen = new Set([active[0]]), stack = [active[0]];
  while (stack.length) {
    for (const step of adjacency[stack.pop()]) {
      if (!seen.has(step.node)) { seen.add(step.node); stack.push(step.node); }
    }
  }
  assert.equal(seen.size, active.length, 'live drivable graph is disconnected');
}

const cases = [
  [config('GRADE-flat-manhattan', 'manhattan', 'flat'), 150],
  [config('GRADE-river-paris', 'paris', 'river'), 150],
  [config('GRADE-coast-tokyo', 'tokyo', 'coast'), 150],
  [config('GRADE-island-medieval', 'medieval', 'island'), 150],
  [config('STEEP-1', 'paris', 'river'), 150],
  [config('STEEP-52', 'manhattan', 'flat'), 150],
  [config('STEEP-58', 'tokyo', 'coast'), 150],
  [config('CONN-114', 'atlanta', 'river'), 60],
  [config('CONN-119', 'atlanta', 'island', { rail: 'metro' }), 50],
  [config('CONN-159', 'atlanta', 'island', { density: 'extreme', rail: 'terminal' }), 70],
  // Sampled interior grades end more streets on this island's slopes than the
  // endpoint-only check did; grade recovery must keep a viable network.
  [config('CONN-175', 'manhattan', 'island', { density: 'med', rail: 'terminal' }), 60],
  // All four seed arterials initially meet over-limit sampled terrain in
  // these sparse audit cases. Bounded recovery must prevent a 0–1 edge city.
  [config('AUD-53', 'medieval', 'river', { density: 'low' }), 300],
  [config('AUDIT-600-583', 'medieval', 'coast', { density: 'low', rail: 'metro' }), 300],
];
const results = [];
for (const [c, minEdges] of cases) {
  const model = generateCity(c), repeat = generateCity({ ...c });
  assertGrades(model, resolvePreset(c.pattern));
  assertRoadEndpoints(model);
  assertConnected(model);
  assert.equal(signature(model), signature(repeat), `${c.seed} is not deterministic`);
  const liveEdges = model.graph.edges.filter(edge => !edge.removed && !VIRTUAL.has(edge.cls)).length;
  assert.equal(model.stats.edges, liveEdges, `${c.seed} edge stats do not match the live drivable graph`);
  assert.equal(model.stats.roadComponents, 1, `${c.seed} component stats do not match the live drivable graph`);
  assert.ok(model.stats.edges >= minEdges, `${c.seed} growth collapsed to ${model.stats.edges} edges`);
  results.push({
    seed: c.seed, edges: model.stats.edges, disconnectedEdges: model.stats.disconnectedEdges,
    rejectedGrade: model.stats.rejectedGrade,
  });
}
assert.ok(results.some(result => result.rejectedGrade > 0), 'focused cases exercised no grade rejections');

// Missing elevation and an explicit flat sampler must retain identical legacy
// graph output.
const legacyP = resolvePreset('manhattan');
legacyP.parallelGap = Math.min(legacyP.spacing.major, legacyP.spacing.minor) * .4;
const baseFields = {
  water: { shores: [], sdf: () => 1e9 }, population: () => 1,
  direction: () => 0, exclusion: () => false,
};
const legacyArgs = { P: legacyP, size: 900, budget: 80, centers: [{ x: 0, z: 0 }] };
const missing = growRoads({ ...legacyArgs, rng: new RNG('grade/legacy'), fields: baseFields });
const flat = growRoads({ ...legacyArgs, rng: new RNG('grade/legacy'), fields: { ...baseFields, elevation: () => 12 } });
assert.deepEqual(missing, flat, 'missing elevation no longer behaves as flat terrain');

// A bridge may exceed the road-class land limit (by the same sampled measure
// land roads are held to) and must still survive.
const bridgeConfig = config('BRIDGE-25', 'manhattan', 'river');
const bridgeModel = generateCity(bridgeConfig), bridgeP = resolvePreset(bridgeConfig.pattern);
assertRoadEndpoints(bridgeModel);
const steepBridge = bridgeModel.graph.edges.some(edge => {
  if (edge.removed || !edge.bridge) return false;
  const a = bridgeModel.graph.nodes[edge.a], b = bridgeModel.graph.nodes[edge.b];
  return sampledGrade(bridgeModel.fields.elevation, a, b) > bridgeP.maxGrade[edge.cls];
});
assert.ok(steepBridge, 'over-limit bridge was not preserved');

// A bridge may cross another bridge only at a land point. Repeated water
// splits otherwise turn a valid bank-to-water subsegment into water-to-water.
const bridgeSplitModel = generateCity(config('AUDIT-505', 'manhattan', 'river', { rail: 'metro' }));
assertRoadEndpoints(bridgeSplitModel);
assert.ok(bridgeSplitModel.stats.bridges > 0, 'bridge-split regression produced no bridges');

// Focused shoreline cases validate complete oriented edges, not just centres.
for (const [seed, pattern, land] of [
  ['WATER-river', 'paris', 'river'],
  ['WATER-coast', 'tokyo', 'coast'],
  ['WATER-island', 'medieval', 'island'],
]) {
  const model = generateCity(config(seed, pattern, land));
  for (const b of model.buildings) {
    const ring = b.footprint || orientedRect(b.cx, b.cz, b.w, b.d, b.angle || 0);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], q = ring[(i + 1) % ring.length];
      const n = Math.max(1, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 4));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        assert.ok(model.fields.water.sdf(a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t) > .5,
          `${seed} building edge entered water`);
      }
    }
  }
}

console.log(JSON.stringify({ cases: results, bridgeEdges: bridgeModel.stats.bridges }));
