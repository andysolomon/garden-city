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
import { TRAFFIC_SAMPLE_COUNT, buildDrivableAdjacency, lengthBudgetDijkstra, sampleTraffic, shortestPath, positionOnRoute } from '../src/routing.js';
import { makeDirection, makeNoise, makeWater } from '../src/fields.js';
import { fitRect, mergeLandlockedParcels } from '../src/blocks.js';
import {
  segmentsTouch, segIntersect, signedArea, isSimple, area, pointInPolygon, distToBoundary, orientedRect, pointSegDist,
  polyIntersectsRect, mergeAdjacentPolygons, sharedBoundaryLength, offsetPolygon, shrinkPolygonMulti,
} from '../src/geom.js';

const PATTERNS = ['manhattan', 'paris', 'tokyo', 'medieval', 'atlanta'];
const LANDS = ['flat', 'river', 'coast', 'island'];
const DENS = ['low', 'med', 'high', 'extreme'];
const RAILS = ['none', 'metro', 'elevated', 'terminal'];
const ENGINES = ['graph', 'bsp'];
const N = Number(process.argv[2] || 100);

const failures = [];
const makeTotals = () => ({ cities: 0, corridorLen: [], roads: 0, bridges: 0, faces: 0, blocks: 0, offsetDrops: 0, parcels: 0, landlocked: 0, slivers: 0, degenerate: 0, buildings: 0, ms: 0 });
const totals = Object.fromEntries(ENGINES.map(engine => [engine, makeTotals()]));

function check(seed, cond, msg) { if (!cond) failures.push(`${seed}: ${msg}`); }

function checkRing(seed, ring, label) {
  check(seed, Array.isArray(ring) && ring.length >= 3, `${label} is not a polygon ring`);
  if (!Array.isArray(ring) || ring.length < 3) return;
  check(seed, ring.every(p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite)), `${label} has non-finite vertices`);
  if (ring.every(p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite))) {
    check(seed, signedArea(ring) > 0 && isSimple(ring), `${label} is not positive and simple`);
  }
}

function checkModelContract(seed, model, engine) {
  check(seed, model.engine === engine, `model engine label is not ${engine}`);
  const lists = ['roads', 'bridges', 'blocks', 'parks', 'plazas', 'parcels', 'buildings', 'landmarks', 'water', 'reserved', 'trees', 'cars', 'drones', 'cranes'];
  for (const list of lists) check(seed, Array.isArray(model[list]), `${list} is not an array`);

  const rectEntries = ['blocks', 'parks', 'plazas', 'parcels'];
  for (const list of rectEntries) for (const [i, entry] of (model[list] || []).entries()) {
    const label = `${list}[${i}]`;
    checkRing(seed, entry.polygon, `${label}.polygon`);
    check(seed, ['x', 'z', 'w', 'd'].every(key => Number.isFinite(entry[key])) && entry.w > 0 && entry.d > 0,
      `${label} lost positive bbox fields`);
  }

  for (const [list, entries] of [['roads', model.roads], ['bridges', model.bridges]]) for (const [i, entry] of (entries || []).entries()) {
    const label = `${list}[${i}]`;
    checkRing(seed, entry.polygon, `${label}.polygon`);
    check(seed, ['x', 'z', 'w', 'd', 'width', 'len', 'cx', 'cz', 'angle'].every(key => Number.isFinite(entry[key]))
      && entry.w > 0 && entry.d > 0 && entry.width > 0 && entry.len > 0, `${label} lost road axis fields`);
    check(seed, [entry.a, entry.b].every(p => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite)), `${label} lost road endpoints`);
    check(seed, typeof entry.type === 'string', `${label} lost road type`);
  }

  for (const [i, entry] of (model.buildings || []).entries()) {
    const label = `buildings[${i}]`;
    check(seed, ['cx', 'cz', 'w', 'd', 'h', 'y', 'angle', 'x', 'z'].every(key => Number.isFinite(entry[key]))
      && entry.w > 0 && entry.d > 0 && entry.h > 0, `${label} lost building fields`);
    check(seed, typeof entry.zone === 'string' && typeof entry.style === 'string', `${label} lost zone/style`);
    if (entry.footprint) checkRing(seed, entry.footprint, `${label}.footprint`);
    if (entry.courtyard) checkRing(seed, entry.courtyard, `${label}.courtyard`);
  }

  for (const [i, entry] of (model.landmarks || []).entries()) {
    const label = `landmarks[${i}]`;
    check(seed, ['x', 'z', 'w', 'd', 'h', 'angle'].every(key => Number.isFinite(entry[key]))
      && entry.w > 0 && entry.d > 0 && entry.h > 0, `${label} lost landmark fields`);
  }

  for (const [i, entry] of (model.reserved || []).entries()) {
    check(seed, ['x', 'z', 'w', 'd'].every(key => Number.isFinite(entry[key])) && entry.w > 0 && entry.d > 0,
      `reserved[${i}] lost bbox fields`);
  }

  if (engine === 'bsp') {
    check(seed, !model.graph && !model.corridors && !model.stats && !model.traffic && !model.walkshed,
      'BSP unexpectedly exposes graph or traffic metadata');
  } else {
    check(seed, !!model.graph && !!model.corridors && !!model.stats && !!model.traffic, 'graph model lacks graph metadata');
  }
}

function modelIsLand(model, x, z) {
  if (typeof model.fields?.water?.isLand === 'function') return model.fields.water.isLand(x, z);
  const water = model.water.find(w => w.type === 'river' || w.type === 'coast' || w.type === 'sea');
  if (!water) return true;
  if (water.type === 'river') return x <= water.x || x >= water.x + water.w;
  if (water.type === 'coast') return x >= water.x + water.w;
  const shore = Array.from({ length: 56 }, (_, i) => {
    const t = i / 56 * Math.PI * 2;
    return [Math.cos(t) * water.rx, Math.sin(t) * water.rz];
  });
  return pointInPolygon(x, z, shore);
}

function checkBuildingClearance(seed, model) {
  for (const [bi, building] of (model.buildings || []).entries()) {
    const vertices = building.footprint
      ? building.footprint.concat(building.courtyard || [])
      : orientedRect(building.cx, building.cz, building.w, building.d, building.angle || 0);
    for (const [x, z] of vertices) {
      check(seed, modelIsLand(model, x, z), `building ${bi} at ${x.toFixed(0)},${z.toFixed(0)} in water`);
      for (const r of model.reserved || []) check(seed,
        !(x > r.x + .5 && x < r.x + r.w - .5 && z > r.z + .5 && z < r.z + r.d - .5),
        `building ${bi} corner inside reserved corridor`);
    }
  }
}

function modelSignature(model) {
  return JSON.stringify(model, (key, value) => {
    if (key === 'graph' || key === 'fields' || key === 'block' || key === 'face' || typeof value === 'function') return undefined;
    return value;
  });
}

function checkModelDeterminism(seed, model, repeat) {
  check(seed, hashSeed(modelSignature(model)) === hashSeed(modelSignature(repeat)), 'non-deterministic shared model output');
}

function lineAngleDistance(a, b) {
  const d = Math.abs((a - b) % Math.PI);
  return Math.min(d, Math.PI - d);
}

function checkDirectionField() {
  const straight = makeDirection([
    { type: 'grid', angle: 0, x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], makeNoise('focused/direction'), { noiseAmp: 0 });
  check('focused/direction-grid', straight(37, -19) === 0, 'global grid basis drifted');

  const radial = makeDirection([
    { type: 'radial', x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0 });
  check('focused/direction-radial', Math.abs(radial(0, 1) - Math.PI / 2) < 1e-12, 'radial basis is not outward');
  check('focused/direction-radial', radial(0, 0) === 0, 'radial center is not deterministic');

  const exactPiGrid = makeDirection([
    { type: 'grid', angle: Math.PI, x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0 });
  check('focused/direction-range', exactPiGrid(0, 0) >= 0 && exactPiGrid(0, 0) < Math.PI,
    'exact Math.PI grid angle escaped [0,pi)');
  check('focused/direction-range', exactPiGrid(0, 0) === 0, 'exact Math.PI grid angle was not canonicalized');

  const westwardRadial = makeDirection([
    { type: 'radial', x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0 });
  check('focused/direction-range', westwardRadial(-1, 0) >= 0 && westwardRadial(-1, 0) < Math.PI,
    'westward radial angle escaped [0,pi)');
  check('focused/direction-range', westwardRadial(-1, 0) === 0, 'westward radial angle was not canonicalized');

  const blended = makeDirection([
    { type: 'grid', angle: 0, x: 0, z: 0, sigma: 10, weight: 2 },
    { type: 'grid', angle: Math.PI / 4, x: 10, z: 0, sigma: 10, weight: 1 },
  ], null, { noiseAmp: 0 });
  const expected = Math.atan2(Math.exp(-1), 2) / 2;
  check('focused/direction-tensor', Math.abs(blended(0, 0) - expected) < 1e-12, 'tensor RBF blend is incorrect');
  const repeat = makeDirection([
    { type: 'grid', angle: 0, x: 0, z: 0, sigma: 10, weight: 2 },
    { type: 'grid', angle: Math.PI / 4, x: 10, z: 0, sigma: 10, weight: 1 },
  ], null, { noiseAmp: 0 });
  check('focused/direction-tensor', blended(3, 4) === repeat(3, 4), 'tensor field is not deterministic');

  const coast = makeWater({ kind: 'coast', edge: 0 }, 100);
  const shoreline = makeDirection([
    { type: 'grid', angle: 0, x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0, shores: coast.shores });
  check('focused/direction-shore', lineAngleDistance(shoreline(0, 0), Math.PI / 2) < 1e-12, 'shoreline field is not tangent-aligned');
  check('focused/direction-shore', shoreline(0, 0) >= 0 && shoreline(0, 0) < Math.PI, 'shoreline angle is outside [0,pi)');

  const falloff = makeDirection([
    { type: 'grid', angle: Math.PI / 4, x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0, shores: coast.shores, boundarySigma: 10, boundaryWeight: 3 });
  const expectedOneSigma = Math.atan2(1, -3 * Math.exp(-1)) / 2;
  check('focused/direction-shore-falloff', Math.abs(falloff(10, 0) - expectedOneSigma) < 1e-12,
    'shoreline RBF does not use point distance');
  check('focused/direction-shore-falloff', lineAngleDistance(falloff(0, 0), Math.PI / 2)
    < lineAngleDistance(falloff(10, 0), Math.PI / 2)
    && lineAngleDistance(falloff(10, 0), Math.PI / 2) < lineAngleDistance(falloff(60, 0), Math.PI / 2),
  'shoreline influence does not decay with distance');

  const repeatShore = makeDirection([
    { type: 'grid', angle: Math.PI / 4, x: 0, z: 0, sigma: Infinity, weight: 1 },
  ], null, { noiseAmp: 0, shores: coast.shores, boundarySigma: 10, boundaryWeight: 3 });
  check('focused/direction-shore-determinism', [0, 10, 60].every(x => falloff(x, 0) === repeatShore(x, 0)),
    'shoreline direction is not deterministic');

  const flatSources = [
    { type: 'grid', angle: .31, x: 0, z: 0, sigma: Infinity, weight: 1 },
    { type: 'radial', x: 80, z: -40, sigma: 170, weight: .7 },
  ];
  const flatNoiseA = makeDirection(flatSources, makeNoise('focused/flat-direction'), { noiseAmp: .2, noiseScale: .07 });
  const flatNoiseB = makeDirection(flatSources, makeNoise('focused/flat-direction'), {
    noiseAmp: .2, noiseScale: .07, shores: makeWater({ kind: 'flat' }, 100).shores,
  });
  check('focused/direction-flat', [-180, -20, 0, 75, 210].every(x => [-160, 0, 130].every(z => flatNoiseA(x, z) === flatNoiseB(x, z))),
    'empty shoreline data changed flat direction output');
}

checkDirectionField();

function checkParcelMerge() {
  const left = [[0, 0], [10, 0], [10, 10], [0, 10]];
  // The shared side is deliberately split into two edges on the neighbour.
  const right = [[10, 0], [20, 0], [20, 10], [10, 10], [10, 5]];
  const union = mergeAdjacentPolygons(left, right);
  check('focused/parcel-union', sharedBoundaryLength(left, right) === 10, 'split shared boundary measured incorrectly');
  check('focused/parcel-union', !!union && signedArea(union) > 0 && isSimple(union), 'adjacent union is not a positive simple polygon');
  check('focused/parcel-union', !!union && Math.abs(area(union) - area(left) - area(right)) < 1e-9, 'adjacent union changed parcel area');
  check('focused/parcel-union', mergeAdjacentPolygons(left, [[10, 10], [12, 10], [12, 12], [10, 12]]) === null,
    'point contact was treated as a shared parcel boundary');

  const shortFrontage = [[0, 0], [10, 0], [10, 4], [0, 4]];
  const landlocked = [[10, 0], [20, 0], [20, 10], [10, 10]];
  const longFrontage = [[10, 10], [20, 10], [20, 20], [10, 20]];
  const frontageFor = poly => poly.some(([, z]) => z === 20) ? { edge: 'long' }
    : poly.some(([x]) => x === 0) ? { edge: 'short' } : null;
  const result = mergeLandlockedParcels([shortFrontage, landlocked, longFrontage], frontageFor);
  check('focused/parcel-choice', result.merged === 1 && result.parcels.length === 2, 'landlocked parcel was not consumed exactly once');
  const joined = result.parcels.find(p => area(p.polygon) > 100);
  check('focused/parcel-choice', !!joined && area(joined.polygon) === 200 && joined.frontage?.edge === 'long',
    'landlocked parcel did not choose its longest shared boundary');

  const fallback = mergeLandlockedParcels([left, right], () => null);
  check('focused/parcel-fallback', fallback.merged === 0 && fallback.parcels.length === 2,
    'frontage-free component collapsed instead of retaining courtyard fallback');

  const frontage = poly => poly.some(([, z]) => z === 0) ? { edge: 'front' } : null;
  const lShape = [
    [[0, 0], [30, 0], [30, 10], [0, 10]],
    [[0, 10], [10, 10], [10, 30], [0, 30]],
  ];
  const lResult = mergeLandlockedParcels(lShape, frontage);
  const lParcel = lResult.parcels[0];
  const lRect = lParcel && fitRect(lParcel.polygon, 0, 0);
  check('focused/l-merge-fit', lResult.merged === 1 && lResult.parcels.length === 1 && lParcel.frontage,
    'L-shaped frontage parcel was not merged with its landlocked leg');
  check('focused/l-merge-fit', !!lRect && lRect.w >= 5.5 && lRect.d >= 5.5
    && ringContainedByParcel(orientedRect(lRect.cx, lRect.cz, lRect.w, lRect.d, lRect.angle), lParcel.polygon),
  'L-shaped merged parcel lost a contained regular fit');

  const uShape = [
    [[0, 0], [30, 0], [30, 10], [0, 10]],
    [[0, 10], [10, 10], [10, 30], [0, 30]],
    [[20, 10], [30, 10], [30, 30], [20, 30]],
  ];
  const uResult = mergeLandlockedParcels(uShape, frontage);
  const uParcel = uResult.parcels[0];
  const uRect = uParcel && fitRect(uParcel.polygon, 0, 0);
  check('focused/u-merge-fit', uResult.merged === 2 && uResult.parcels.length === 1 && uParcel.frontage,
    'U-shaped frontage parcel did not consume both landlocked legs');
  check('focused/u-merge-fit', !!uRect && uRect.w >= 5.5 && uRect.d >= 5.5
    && ringContainedByParcel(orientedRect(uRect.cx, uRect.cz, uRect.w, uRect.d, uRect.angle), uParcel.polygon),
  'U-shaped merged parcel lost a contained regular fit');
}

checkParcelMerge();

// A six-metre neck disappears under a five-metre inset. The bounded split
// path must retain the two valid lobes instead of dropping the whole block.
{
  const face = [[0, 0], [30, 0], [30, 12], [50, 12], [50, 0], [80, 0], [80, 30],
    [50, 30], [50, 18], [30, 18], [30, 30], [0, 30]];
  const dists = face.map(() => 5);
  const pieces = shrinkPolygonMulti(face, dists);
  check('focused/split-offset', offsetPolygon(face, dists) === null, 'fixture does not exercise the split-event fallback');
  check('focused/split-offset', pieces.length === 2, `split inset retained ${pieces.length} pieces instead of 2`);
  check('focused/split-offset', pieces.every(piece => signedArea(piece) > 0 && isSimple(piece) && area(piece) === 400),
    'split inset pieces are not positive simple 400m² lobes');
  check('focused/split-offset', !ringsInteriorOverlap(pieces[0], pieces[1]), 'split inset lobes overlap');
  check('focused/split-offset', JSON.stringify(pieces) === JSON.stringify(shrinkPolygonMulti(face, dists)),
    'split inset is not deterministic');
}

function ringWithinPolygon(ring, container, tol = 1e-3) {
  return ring.every((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]].every(([x, z]) =>
      pointInPolygon(x, z, container) || distToBoundary(x, z, container) < tol);
  });
}

function ringsInteriorOverlap(a, b, tol = 1e-6) {
  if (a.some(([x, z]) => pointInPolygon(x, z, b) && distToBoundary(x, z, b) > tol)) return true;
  if (b.some(([x, z]) => pointInPolygon(x, z, a) && distToBoundary(x, z, a) > tol)) return true;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i], q = a[(i + 1) % a.length], r = b[j], s = b[(j + 1) % b.length];
    const hit = segIntersect(p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1]);
    if (hit && hit.t > tol && hit.t < 1 - tol && hit.u > tol && hit.u < 1 - tol) return true;
  }
  return false;
}

function ringContainedByParcel(ring, parcel, tol = 1e-6) {
  if (!ring.every(([x, z]) => pointInPolygon(x, z, parcel) || distToBoundary(x, z, parcel) <= tol)) return false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (let j = 0; j < parcel.length; j++) {
      const p = parcel[j], q = parcel[(j + 1) % parcel.length];
      if (segmentsTouch(a[0], a[1], b[0], b[1], p[0], p[1], q[0], q[1])) return false;
    }
  }
  return true;
}

// A corner-only fit accepts this C-shaped parcel's 36×36 box even though its
// right edge crosses the open middle notch. The fixed fit must retain a usable
// candidate while rejecting that spanning rectangle.
{
  const parcel = [[0, 0], [40, 0], [40, 14], [28, 14], [28, 26], [40, 26], [40, 40], [0, 40]];
  const rect = fitRect(parcel, 0, 0);
  check('focused/fit-rect-concave', !!rect, 'concave parcel lost every usable rectangle');
  check('focused/fit-rect-concave', !rect || ringContainedByParcel(orientedRect(rect.cx, rect.cz, rect.w, rect.d, rect.angle), parcel),
    'rectangle still spans the C-shaped parcel notch');
}

function shorelineNearest(x, z, shores) {
  let best = { d: Infinity, angle: 0 };
  for (const shore of shores) {
    const points = shore.pts || shore;
    const count = shore.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const hit = pointSegDist(x, z, a[0], a[1], b[0], b[1]);
      if (hit.d < best.d) best = { d: hit.d, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }
  }
  return best;
}

function shorelineSignature(m) {
  const shoreSamples = m.fields.water.shores.flatMap(s => {
    const points = s.pts, count = s.closed ? points.length : points.length - 1;
    return Array.from({ length: count }, (_, i) => {
      const a = points[i], b = points[(i + 1) % points.length];
      return m.fields.direction((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    });
  });
  return JSON.stringify({
    nodes: m.graph.nodes,
    edges: m.graph.edges.map(e => [e.a, e.b, e.cls, e.removed]),
    shoreSamples,
  });
}

function checkGeneratedShoreline(seed, config) {
  const m = generateCity(config), repeat = generateCity({ ...config });
  const shores = m.fields.water.shores;
  for (const shore of shores) {
    const points = shore.pts, count = shore.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2;
      check(seed, lineAngleDistance(m.fields.direction(x, z), Math.atan2(b[1] - a[1], b[0] - a[0])) < .3,
        `generated ${config.land} field is not tangent at shore segment ${i}`);
    }
  }

  const nearby = [];
  for (const e of m.graph.edges) {
    if (e.removed || VIRTUAL.has(e.cls)) continue;
    const a = m.graph.nodes[e.a], b = m.graph.nodes[e.b];
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, near = shorelineNearest(x, z, shores);
    if (near.d < 110) nearby.push(lineAngleDistance(Math.atan2(b.z - a.z, b.x - a.x), near.angle));
  }
  const aligned = nearby.filter(d => d < .45).length;
  check(seed, nearby.length >= 4 && aligned >= 2 && aligned / nearby.length >= .2,
    `generated ${config.land} graph lacks boundary-aligned edges (${aligned}/${nearby.length})`);
  check(seed, shorelineSignature(m) === shorelineSignature(repeat), 'shoreline generation is not deterministic');
}

for (const [land, pattern] of [
  ['coast', 'manhattan'], ['coast', 'paris'], ['coast', 'medieval'],
  ['river', 'manhattan'], ['river', 'paris'], ['river', 'medieval'],
]) {
  checkGeneratedShoreline(`focused/${land}-${pattern}`, {
    seed: `FOCUSED-${land.toUpperCase()}-${pattern.toUpperCase()}`,
    engine: 'graph', pattern, land, density: 'high', rail: 'none', massing: 'mixed',
    sector: 'mixed', detail: 'med', life: 'off', air: 'none',
  });
}

function checkFootprints(seed, m, requireCourtyard = false) {
  const footprints = m.buildings.filter(b => b.footprint);
  if (requireCourtyard) check(seed, footprints.length > 0, 'euro city has no perimeter courtyard building');
  for (const [bi, b] of footprints.entries()) {
    check(seed, b.style === 'perimeter', `footprint building ${bi} is not perimeter style`);
    check(seed, Array.isArray(b.courtyard) && b.courtyard.length >= 3, `footprint building ${bi} has no courtyard ring`);
    check(seed, signedArea(b.footprint) > 0 && isSimple(b.footprint), `footprint building ${bi} outer ring invalid`);
    check(seed, signedArea(b.courtyard) > 0 && isSimple(b.courtyard), `footprint building ${bi} courtyard ring invalid`);
    check(seed, area(b.courtyard) < area(b.footprint), `footprint building ${bi} courtyard is not smaller than outer ring`);
    for (const [x, z] of b.courtyard) {
      check(seed, pointInPolygon(x, z, b.footprint) && distToBoundary(x, z, b.footprint) > .5,
        `footprint building ${bi} courtyard vertex outside outer ring`);
    }
    for (const key of ['cx', 'cz', 'w', 'd', 'h', 'y', 'angle', 'x', 'z']) {
      check(seed, Number.isFinite(b[key]), `footprint building ${bi} lost rectangle field ${key}`);
    }
    check(seed, !m.reserved.some(r => polyIntersectsRect(b.footprint, r)), `footprint building ${bi} intersects reserved corridor`);
  }
  for (const [bi, b] of m.buildings.entries()) {
    if (b.footprint) continue;
    const ring = orientedRect(b.cx, b.cz, b.w, b.d, b.angle || 0);
    const x0 = Math.min(...ring.map(([x]) => x)), x1 = Math.max(...ring.map(([x]) => x));
    const z0 = Math.min(...ring.map(([, z]) => z)), z1 = Math.max(...ring.map(([, z]) => z));
    const owner = m.parcels.find(p => p.x <= x0 + 1e-6 && p.x + p.w >= x1 - 1e-6
      && p.z <= z0 + 1e-6 && p.z + p.d >= z1 - 1e-6
      && ringContainedByParcel(ring, p.polygon));
    check(seed, !!owner, `regular building ${bi} footprint is not contained by an owning parcel`);
  }
  for (const p of m.parcels) {
    if (!p.frontage) continue;
    check(seed, p.built || p.vacant || p.fallback === 'courtyard', 'frontage parcel was silently lost');
    if (p.fallback === 'courtyard') check(seed,
      m.parks.some(k => k.court && k.fallback === 'courtyard' && k.polygon === p.polygon),
      'frontage parcel courtyard fallback was not emitted');
  }
  return footprints;
}

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

function trafficSignature(m) {
  const t = m.traffic;
  if (!t) return null;
  return JSON.stringify({
    requested: t.requested, sampleCount: t.sampleCount, edgeCounts: t.edgeCounts,
    corridorCounts: t.corridorCounts, routes: t.routes,
  });
}

function checkTrafficVolume(seed, m) {
  const t = m.traffic, g = m.graph;
  check(seed, !!t && !!g, 'graph city lacks traffic analysis');
  if (!t || !g) return;
  check(seed, TRAFFIC_SAMPLE_COUNT === 128, 'traffic sample budget is not the approved 128 routes');
  check(seed, t.requested === TRAFFIC_SAMPLE_COUNT, `traffic requested ${t.requested} samples`);
  check(seed, t.sampleCount === TRAFFIC_SAMPLE_COUNT && t.samples === TRAFFIC_SAMPLE_COUNT
    && t.routes.length === TRAFFIC_SAMPLE_COUNT, `traffic sampler did not return ${TRAFFIC_SAMPLE_COUNT} routes`);

  const edgeCounts = Array.from({ length: g.edges.length }, () => 0);
  const corridorCounts = Object.fromEntries(m.corridors.map(c => [String(c.id), 0]));
  const edgeCorridor = new Map();
  for (const c of m.corridors) {
    check(seed, Number.isFinite(c.traffic), `corridor ${c.id} lacks numeric traffic annotation`);
    for (const edgeId of c.edgeIds) edgeCorridor.set(edgeId, c.id);
  }
  for (const [ri, route] of t.routes.entries()) {
    check(seed, route.originCorridorId !== route.destinationCorridorId
      && route.originCorridor !== route.destinationCorridor, `sample ${ri} uses one corridor`);
    check(seed, Array.isArray(route.edges) && Array.isArray(route.nodes)
      && route.nodes.length === route.edges.length + 1, `sample ${ri} route shape is invalid`);
    for (let i = 0; i < route.edges.length; i++) {
      const edgeId = route.edges[i], edge = g.edges[edgeId];
      check(seed, !!edge && !edge.removed && !VIRTUAL.has(edge.cls), `sample ${ri} uses non-live edge ${edgeId}`);
      check(seed, edge && ((edge.a === route.nodes[i] && edge.b === route.nodes[i + 1])
        || (edge.b === route.nodes[i] && edge.a === route.nodes[i + 1])), `sample ${ri} disconnects at ${i}`);
      if (!edge) continue;
      edgeCounts[edgeId]++;
      const corridorId = edgeCorridor.get(edgeId);
      if (corridorId !== undefined) corridorCounts[String(corridorId)]++;
    }
    const origin = m.corridors.find(c => c.id === route.originCorridorId && c.name === route.originCorridor);
    const destination = m.corridors.find(c => c.id === route.destinationCorridorId && c.name === route.destinationCorridor);
    check(seed, !!origin && origin.nodeIds.includes(route.nodes[0]), `sample ${ri} start is off origin corridor`);
    check(seed, !!destination && destination.nodeIds.includes(route.nodes.at(-1)), `sample ${ri} end is off destination corridor`);
  }

  check(seed, JSON.stringify(t.edgeCounts) === JSON.stringify(edgeCounts), 'edge traffic counts disagree with sampled routes');
  check(seed, JSON.stringify(t.corridorCounts) === JSON.stringify(corridorCounts), 'corridor traffic counts disagree with sampled routes');
  for (let edgeId = 0; edgeId < g.edges.length; edgeId++) {
    check(seed, Number.isFinite(g.edges[edgeId].traffic) && g.edges[edgeId].traffic === edgeCounts[edgeId], `graph edge ${edgeId} traffic mismatch`);
  }
  for (const entry of m.roads.concat(m.bridges)) {
    check(seed, Number.isFinite(entry.traffic) && entry.traffic === edgeCounts[entry.edge], `road edge ${entry.edge} traffic mismatch`);
  }
  for (const c of m.corridors) check(seed, c.traffic === corridorCounts[String(c.id)], `corridor ${c.id} annotation mismatch`);
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

// Focused R5 volume checks: the graph analysis is present even when life is
// off, is reproducible from the traffic stream, and remains bounded in cost.
{
  const config = {
    seed: 'TRAFFIC-VOLUME', engine: 'graph', pattern: 'paris', land: 'river',
    density: 'med', rail: 'none', massing: 'mixed', sector: 'mixed', detail: 'med',
    life: 'off', air: 'none',
  };
  const timingRuns = 3;
  const generationTimes = [], samplingTimes = [];
  let m, repeat;
  for (let run = 0; run < timingRuns; run++) {
    const generationStart = performance.now();
    const candidate = generateCity(config);
    generationTimes.push(performance.now() - generationStart);
    const samplingStart = performance.now();
    const sampled = sampleTraffic(candidate.graph, candidate.corridors, config.seed);
    samplingTimes.push(performance.now() - samplingStart);
    if (!m) { m = candidate; repeat = sampled; }
    check('focused/traffic-volume', trafficSignature(candidate) === trafficSignature(m), `generation run ${run} is not deterministic`);
  }
  checkTrafficVolume('focused/traffic-volume', m);
  check('focused/traffic-volume', m.cars.length === 0, 'traffic volume analysis changed life=off');

  check('focused/traffic-volume', trafficSignature(m) === JSON.stringify({
    requested: repeat.requested, sampleCount: repeat.sampleCount, edgeCounts: repeat.edgeCounts,
    corridorCounts: repeat.corridorCounts, routes: repeat.routes,
  }), 'reusable traffic sampler is not deterministic');
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(`traffic timing [medium-light; ${timingRuns} runs; ${TRAFFIC_SAMPLE_COUNT} routes]: `
    + `standalone sampling avg/max=${average(samplingTimes).toFixed(2)}/${Math.max(...samplingTimes).toFixed(2)}ms; `
    + `total generation avg/max=${average(generationTimes).toFixed(2)}/${Math.max(...generationTimes).toFixed(2)}ms`);
}

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

// Representative perimeter-block matrix: density, street pattern, terrain,
// and rail exclusions all exercise the polygon + courtyard path directly.
for (const [seed, pattern, land, density, rail] of [
  ['PERIMETER-FLAT', 'paris', 'flat', 'med', 'none'],
  ['PERIMETER-RIVER', 'medieval', 'river', 'high', 'elevated'],
  ['PERIMETER-ISLAND', 'tokyo', 'island', 'extreme', 'terminal'],
  ['PERIMETER-COAST', 'atlanta', 'coast', 'low', 'metro'],
]) {
  const config = {
    seed, engine: 'graph', pattern, land, density, rail, massing: 'euro',
    sector: 'mixed', detail: 'med', life: 'off', air: 'sparse',
  };
  const m = generateCity(config), repeat = generateCity({ ...config });
  checkFootprints(`focused/${seed}`, m, true);
  const rings = city => JSON.stringify(city.buildings.map(b => [
    b.cx, b.cz, b.w, b.d, b.h, b.angle, b.footprint, b.courtyard,
  ]));
  check(`focused/${seed}`, rings(m) === rings(repeat), 'non-deterministic perimeter serialization');
}

for (const engine of ENGINES) {
  const summary = totals[engine];
  for (let i = 0; i < N; i++) {
    const config = {
      seed: `T${i}`, engine,
      pattern: PATTERNS[i % PATTERNS.length], land: LANDS[(i >> 1) % LANDS.length],
      density: DENS[(i >> 3) % DENS.length], rail: RAILS[(i >> 2) % RAILS.length],
      massing: ['mixed', 'core', 'euro', 'lowrise', 'industrial'][i % 5], sector: 'mixed',
      detail: 'med', life: 'low', air: 'sparse',
    };
    const t0 = performance.now();
    const m = generateCity(config);
    summary.ms += performance.now() - t0;
    const repeat = generateCity({ ...config });
    summary.cities++;
    const seed = `${engine}/${config.seed}/${config.pattern}/${config.land}/${config.density}/${config.rail}`;
    checkModelContract(seed, m, engine);
    checkBuildingClearance(seed, m);
    checkModelDeterminism(seed, m, repeat);
    if (engine !== 'graph') {
      summary.roads += m.roads.length;
      summary.bridges += m.bridges.length;
      summary.blocks += m.blocks.length;
      summary.parcels += m.parcels.length;
      summary.buildings += m.buildings.length;
      continue;
    }
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
    summary.degenerate += m.stats.degenerateFaces;
  }

  // 5. Parcels lie inside their block; Σ parcel areas ≤ buildable area.
  {
    const perBlock = new Map();
    for (const b of m.blocks) for (const [i, piece] of (b.buildablePieces || []).entries()) {
      check(seed, signedArea(piece) > 0 && isSimple(piece) && area(piece) > 0, 'buildable piece is not positive and simple');
      check(seed, ringWithinPolygon(piece, b.face.polygon), 'buildable piece outside owning face');
      for (let j = 0; j < i; j++) check(seed, !ringsInteriorOverlap(piece, b.buildablePieces[j]), 'buildable pieces overlap');
    }
    for (const p of m.parcels) {
      const pieces = p.block.buildablePieces || [p.block.buildable];
      const B = pieces.find(piece => ringWithinPolygon(p.polygon, piece));
      check(seed, signedArea(p.polygon) > 0 && isSimple(p.polygon) && area(p.polygon) > 0, 'parcel polygon is not positive and simple');
      check(seed, !!B, 'parcel is outside every owning buildable piece');
      perBlock.set(p.block, (perBlock.get(p.block) || 0) + area(p.polygon));
    }
    for (const [b, a] of perBlock) {
      const unionArea = (b.buildablePieces || [b.buildable]).reduce((sum, piece) => sum + area(piece), 0);
      check(seed, a <= unionArea * (1 + 1e-6), `parcel area ${a.toFixed(0)} exceeds buildable union ${unionArea.toFixed(0)}`);
    }
  }

  // 6. Every built parcel has frontage.
  for (const p of m.parcels) if (p.built) check(seed, !!p.frontage, 'built parcel without frontage');

  // 7. No building in water or inside a reserved corridor. Polygonal prism
  //    buildings validate both rings; boxes retain their oriented corners.
  checkFootprints(seed, m, config.massing === 'euro');

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
      p: mm.parcels.map(p => [p.polygon, p.frontage, p.landlocked]),
      b: mm.buildings.map(b => [b.cx, b.cz, b.w, b.d, b.h, b.angle, b.footprint, b.courtyard]),
      w: mm.walkshed, wb: mm.blocks.map(b => b.walkshed),
      tv: trafficSignature(mm),
      c: mm.cars.map(c => [c.x, c.z, c.rot, c.path, c.nodes, c.routeLength, c.t, c.speed, c.originCorridor, c.originCorridorId, c.destinationCorridor, c.destinationCorridorId]),
    });
    const h1 = hashSeed(ser(m)), h2 = hashSeed(ser(repeat));
    check(seed, h1 === h2, 'non-deterministic');
  }

  summary.roads += m.roads.length; summary.bridges += m.bridges.length;
  summary.faces += m.faces.length; summary.blocks += m.blocks.length; summary.offsetDrops += m.stats.offsetDrops;
  summary.parcels += m.parcels.length; summary.landlocked += m.stats.landlocked; summary.slivers += m.stats.slivers;
  summary.buildings += m.buildings.length;
  const lens = m.corridors.filter(c => c.cls === 'arterial').map(c => c.length).sort((a, b) => a - b);
  if (lens.length) summary.corridorLen.push(lens[lens.length >> 1]);
  }
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
  check(seed, !m.graph && !m.corridors && !m.stats && !m.traffic, 'BSP unexpectedly exposes graph traffic metadata');
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
const graphTotals = totals.graph, bspTotals = totals.bsp;
if (N >= 100) check('summary/graph', graphTotals.landlocked / Math.max(1, graphTotals.parcels) < .03,
  `landlocked parcel rate ${pct(graphTotals.landlocked, graphTotals.parcels)} is not materially below the 4.7% baseline`);
console.log(`graph: cities ${graphTotals.cities}  avg ${(graphTotals.ms / Math.max(1, graphTotals.cities)).toFixed(0)}ms`);
console.log(`graph: roads ${graphTotals.roads}  bridges ${graphTotals.bridges}  faces ${graphTotals.faces}  blocks ${graphTotals.blocks}  offset drops ${pct(graphTotals.offsetDrops, graphTotals.blocks)}  degenerate faces ${graphTotals.degenerate}`);
const graphCorridors = graphTotals.corridorLen.sort((a, b) => a - b);
console.log(`graph: arterial corridor median length (median over cities): ${graphCorridors.length ? graphCorridors[graphCorridors.length >> 1].toFixed(0) : 0}`);
console.log(`graph: parcels ${graphTotals.parcels}  landlocked ${pct(graphTotals.landlocked, graphTotals.parcels)}  slivers dropped ${graphTotals.slivers}  buildings ${graphTotals.buildings}`);
console.log(`bsp: cities ${bspTotals.cities}  avg ${(bspTotals.ms / Math.max(1, bspTotals.cities)).toFixed(0)}ms`);
console.log(`bsp: roads ${bspTotals.roads}  bridges ${bspTotals.bridges}  blocks ${bspTotals.blocks}  parcels ${bspTotals.parcels}  buildings ${bspTotals.buildings}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURES`);
  for (const f of failures.slice(0, 40)) console.log('  ' + f);
  process.exit(1);
}
console.log('all invariants hold');
