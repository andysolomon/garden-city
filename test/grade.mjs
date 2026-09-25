// Focused terrain-grade regression. Run: node test/grade.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateCity } from '../src/model.js';
import { VIRTUAL, GRADE_SAMPLE_STEP, WATER_TOLERANCE } from '../src/graph.js';
import { resolvePreset } from '../src/presets.js';
import { buildDrivableAdjacency } from '../src/routing.js';
import { orientedRect } from '../src/geom.js';

const config = (seed, pattern, land, overrides = {}) => ({
  seed, engine: 'graph', pattern, land, density: 'high', rail: 'none',
  massing: 'mixed', sector: 'mixed', detail: 'med', life: 'off', air: 'none',
  ...overrides,
});

// render.js imports three.js (browser-only), and the document minimum is Node
// >=18, where no supported import interception exists. Instead of mutating
// node_modules (unsafe in read-only checkouts), the render source is read and
// loaded from an in-memory data: URL. Data URLs have no parent path, so the
// relative geom import is rewritten to an absolute file URL. The three.js
// bindings become inert stand-ins: bridge-deck helpers here are pure math and
// never touch them, and nothing runs at module top level. If the import text
// in src/render.js drifts, each replacement fails with a clear error.
async function importRenderModule() {
  const renderSource = await readFile(new URL('../src/render.js', import.meta.url), 'utf8');
  const geomUrl = new URL('../src/geom.js', import.meta.url).href;
  const replacements = [
    [`import * as THREE from 'three';`, `const THREE = {};`],
    [`import { OrbitControls } from 'three/addons/controls/OrbitControls.js';`,
     `const OrbitControls = class OrbitControls {};`],
    [`import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';`,
     `const mergeGeometries = () => null;`],
    [`import { orientedRect, pointInPolygon, pointSegDist } from './geom.js';`,
     `import { orientedRect, pointInPolygon, pointSegDist } from ${JSON.stringify(geomUrl)};`],
  ];
  let moduleText = renderSource;
  for (const [from, to] of replacements) {
    if (!moduleText.includes(from)) {
      throw new Error(`importRenderModule: expected import text missing in src/render.js: ${from}`);
    }
    moduleText = moduleText.replace(from, to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'));
}

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

// Focused bridge-deck continuity: each connected run of bridge spans shares
// one deck elevation (the highest the run needs), disconnected spans stay
// independently elevated, flat terrain keeps the flat datum, and car deck
// lookup agrees with the shared deck.
{
  const { bridgeDeckY, bridgeRunDecks, bridgeDeckLookup, terrainFrame, SHORE_BLEND, BRIDGE_CLEARANCE, CLEARANCE_MARGIN, BRIDGE_FLAT_Y } = await importRenderModule();

  // Sampler: a single hump centred on cx, zero elsewhere.
  const hump = (h, cx, half = 6) => (x) => h && Math.abs(x - cx) < half ? h : 0;

  // Connected spans with unequal terrain maxima: one deck at the run's higher
  // safe elevation, no visible step at the shared junction.
  {
    const left = { a: [-20, 0], b: [0, 0], width: 8 };
    const right = { a: [0, 0], b: [20, 0], width: 8 };
    const model = { bridges: [left, right] };
    const sample = x => Math.abs(x + 10) < 6 ? 8 : 0; // bump only under the left span
    const lone = bridgeDeckY(sample, left);
    const decks = bridgeRunDecks(model, sample);
    assert.equal(decks[0], decks[1], 'connected spans do not share one deck elevation');
    assert.equal(decks[0], lone, 'run deck drifted from the raised span height');

    // Car deck lookup: both spans of the run report the shared elevation.
    const lookup = bridgeDeckLookup(model, sample);
    assert.equal(lookup(10, 0), decks[1], 'car lookup drifted from the run deck on the flat span');
  }

  // River banks taper to water level at the shore. A bridge crossing the
  // river must be set by the actual land on its approaches, not the low
  // shoreline endpoints; both renderers use this same terrain surface.
  {
    const shore = 10;
    const model = {
      bridges: [{ a: [-shore, 0], b: [shore, 0], width: 8 }],
      fields: {
        elevation: () => 24,
        water: { sdf: x => Math.abs(x) - shore },
      },
    };
    const { surface } = terrainFrame(model);
    const bank = surface(-shore - SHORE_BLEND, 0);

    // An oblique crossing reaches the full bank over a longer axial distance
    // than the blend width: the approach must follow the shoreline distance.
    const diagonal = {
      bridges: [{ a: [-shore, 0], b: [shore, 35], width: 8 }],
      fields: {
        elevation: () => 24,
        water: { sdf: x => Math.abs(x) - shore },
      },
    };
    const diag = bridgeRunDecks(diagonal, surface)[0];
    assert.ok(diag >= bank + BRIDGE_CLEARANCE + CLEARANCE_MARGIN,
      'oblique crossing deck undershot the full bank height');

    // A high bank beside the middle of a long grazing span, with low banks
    // at both landings: the deck must clear the midspan bank too, not just
    // the terrain at its ends (the deck grid alone only reaches the blended
    // shoulder, ~4.18).
    const ridged = {
      bridges: [{ a: [-1, 0], b: [1, 100], width: 8 }],
      fields: { elevation: (x, z) => Math.abs(z - 50) < 10 ? 24 : 0, water: { sdf: x => Math.abs(x) - 1 } },
    };
    const r = terrainFrame(ridged).surface;
    const ridgeDeck = bridgeRunDecks(ridged, r)[0];
    const ridgeBank = r(-1 - SHORE_BLEND, 50) + BRIDGE_CLEARANCE + CLEARANCE_MARGIN;
    assert.ok(ridgeDeck >= ridgeBank - 1e-9, `grazing deck ${ridgeDeck} undershot midspan bank+clearance ${ridgeBank}`);
  }

  // Flat terrain: no sampler (legacy models) keeps the flat datum.
  {
    const left = { a: [0, 0], b: [20, 0], width: 8 };
    const right = { a: [20, 0], b: [40, 0], width: 8 };
    assert.equal(bridgeRunDecks({ bridges: [left, right] }, null)[0], BRIDGE_FLAT_Y, 'flat model without sampler left the flat datum');
  }

  // Car deck lookup stays keyed to the nearest bridge axis.
  {
    const a = { a: [0, 0], b: [20, 0], width: 8 };
    const b = { a: [60, 0], b: [80, 0], width: 8 };
    const lookup = bridgeDeckLookup({ bridges: [a, b] }, hump(4, 70));
    assert.equal(lookup(70, 0), bridgeDeckY(hump(4, 70), b), 'lookup ignored the nearest span terrain');
    assert.equal(lookup(10, 0), BRIDGE_FLAT_Y, 'lookup lifted an unraised span');
  }
}
