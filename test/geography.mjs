import assert from 'node:assert/strict';
import {
  EARTH_RADIUS_M,
  VIEWPORT_SIZE,
  VIEWPORT_HALF,
  makeProjection,
  createProjection,
  isInViewport,
  cropPoint,
  cropPoints,
  clipSegment,
  clipPolyline,
} from '../src/geography.js';

const DEG_TO_RAD = Math.PI / 180;
const metresPerDegree = EARTH_RADIUS_M * DEG_TO_RAD;

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

function closePoint(actual, expected, tolerance = 1e-7) {
  assert.equal(actual.length, 2);
  close(actual[0], expected[0], tolerance);
  close(actual[1], expected[1], tolerance);
}

function assertOnSourceSegment(point, segment) {
  const [[ax, az], [bx, bz]] = segment;
  const xScale = Math.max(1, Math.abs(ax), Math.abs(bx), Math.abs(point[0]));
  const zScale = Math.max(1, Math.abs(az), Math.abs(bz), Math.abs(point[1]));
  const dx = bx / xScale - ax / xScale;
  const dz = bz / zScale - az / zScale;
  const px = point[0] / xScale - ax / xScale;
  const pz = point[1] / zScale - az / zScale;
  const tolerance = 1e-12;

  if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) {
    const t = px / dx;
    assert.ok(t >= -tolerance && t <= 1 + tolerance, `${JSON.stringify(point)} is outside its source segment`);
    assert.ok(Math.abs(pz - dz * t) <= tolerance, `${JSON.stringify(point)} is not on its source segment`);
  } else if (dz !== 0) {
    const t = pz / dz;
    assert.ok(t >= -tolerance && t <= 1 + tolerance, `${JSON.stringify(point)} is outside its source segment`);
    assert.ok(Math.abs(px - dx * t) <= tolerance, `${JSON.stringify(point)} is not on its source segment`);
  } else {
    assert.deepEqual(point, [ax, az]);
  }
}

assert.equal(EARTH_RADIUS_M, 6378137);
assert.equal(VIEWPORT_SIZE, 900);
assert.equal(VIEWPORT_HALF, 450);
assert.equal(makeProjection, createProjection);

const equator = createProjection({ lon: 0, lat: 0 });
const arrayOrigin = makeProjection([0, 0]);
assert.deepEqual(equator.project([0, 0]), [0, 0]);
assert.deepEqual(arrayOrigin.project({ lon: 0, lat: 0 }), [0, 0]);
closePoint(equator.project([1, 0]), [metresPerDegree, 0]);
closePoint(equator.project([0, 1]), [0, -metresPerDegree]);
closePoint(equator.project([0, -1]), [0, metresPerDegree]);
closePoint(equator.forward(1, 0), [metresPerDegree, 0]);

const latitude60 = makeProjection([0, 60]);
close(latitude60.project([1, 60])[0], metresPerDegree * Math.cos(60 * DEG_TO_RAD));
close(latitude60.project([0, 61])[1], -metresPerDegree);

const scaled = makeProjection([0, 0], { metresPerUnit: 2, viewportSize: 100 });
closePoint(scaled.project([1, 0]), [metresPerDegree / 2, 0]);
assert.equal(scaled.metresPerUnit, 2);
assert.equal(scaled.metersPerUnit, 2);
assert.deepEqual(scaled.bounds, { minX: -50, maxX: 50, minZ: -50, maxZ: 50 });
assert.ok(scaled.isInViewport([50, -50]));
assert.equal(scaled.cropPoint([51, 0]), null);

for (const alias of ['metresPerUnit', 'metersPerUnit']) {
  assert.throws(() => makeProjection([0, 0], { [alias]: Number.EPSILON / 2 }), RangeError);
}
const epsilonScaled = makeProjection([0, 0], { metresPerUnit: Number.EPSILON });
assert.ok(epsilonScaled.project([1, 0]).every(Number.isFinite));
assert.ok(epsilonScaled.inverse([1, 0]).every(Number.isFinite));

const antimeridian = makeProjection([179.9, 0]);
const acrossDateLine = antimeridian.project([-179.9, 0]);
closePoint(acrossDateLine, [metresPerDegree * 0.2, 0]);
closePoint(antimeridian.inverse(acrossDateLine), [-179.9, 0]);
closePoint(antimeridian.unproject(antimeridian.project({ lon: 179.95, lat: -0.01 })), [179.95, -0.01], 1e-12);

const fixture = [
  [-0.001, 0.001],
  [0.002, 0.0015],
  [0.002, -0.002],
  [-0.001, -0.0015],
];
const projectedFixture = equator.projectSequence(fixture);
const repeatedFixture = equator.projectCoordinates(fixture);
assert.deepEqual(projectedFixture, repeatedFixture);
for (const point of projectedFixture) assert.ok(equator.isInViewport(point));
const fixtureBounds = projectedFixture.reduce((bounds, [x, z]) => ({
  minX: Math.min(bounds.minX, x), maxX: Math.max(bounds.maxX, x),
  minZ: Math.min(bounds.minZ, z), maxZ: Math.max(bounds.maxZ, z),
}), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
assert.ok(fixtureBounds.minX >= -VIEWPORT_HALF && fixtureBounds.maxX <= VIEWPORT_HALF);
assert.ok(fixtureBounds.minZ >= -VIEWPORT_HALF && fixtureBounds.maxZ <= VIEWPORT_HALF);
assert.deepEqual(equator.inverseSequence(projectedFixture).map(([lon, lat]) => [Number(lon.toFixed(12)), Number(lat.toFixed(12))]), fixture);
assert.equal(JSON.stringify(projectedFixture), JSON.stringify(equator.projectSequence(fixture)));

for (const edge of [
  [-VIEWPORT_HALF, -VIEWPORT_HALF], [VIEWPORT_HALF, -VIEWPORT_HALF],
  [VIEWPORT_HALF, VIEWPORT_HALF], [-VIEWPORT_HALF, VIEWPORT_HALF],
]) {
  assert.ok(isInViewport(edge));
  assert.ok(equator.isInViewport(edge));
  assert.deepEqual(cropPoint(edge), edge);
}
assert.equal(isInViewport([VIEWPORT_HALF + Number.EPSILON, 0]), true, 'representable epsilon did not cross the edge');
assert.equal(isInViewport([VIEWPORT_HALF + 1e-8, 0]), false);
assert.equal(cropPoint([0, -VIEWPORT_HALF - 1]), null);
assert.deepEqual(cropPoints([[-1, 0], [451, 0], [0, 450]]), [[-1, 0], [0, 450]]);

assert.deepEqual(clipSegment([-900, 0], [900, 0]), [[-450, 0], [450, 0]]);
assert.deepEqual(clipSegment([-450, -450], [450, 450]), [[-450, -450], [450, 450]]);
assert.deepEqual(clipPolyline([[-600, 0], [600, 0]]), [[[-450, 0], [450, 0]]]);
assert.deepEqual(clipPolyline([[0, 0]]), [[[0, 0]]]);
assert.deepEqual(clipPolyline([[-600, 500], [600, 500]]), []);

const largeClips = [
  { segment: [[-1e6, 0], [1e6, 0]], expected: [[-450, 0], [450, 0]] },
  { segment: [[0, -1e6], [0, 1e6]], expected: [[0, -450], [0, 450]] },
  { segment: [[-1e6, -1e6], [1e6, 1e6]], expected: [[-450, -450], [450, 450]] },
  { segment: [[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0]], expected: [[-450, 0], [450, 0]] },
  { segment: [[0, -Number.MAX_VALUE], [0, Number.MAX_VALUE]], expected: [[0, -450], [0, 450]] },
  {
    segment: [[-Number.MAX_VALUE, -Number.MAX_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE]],
    expected: [[-450, -450], [450, 450]],
  },
  { segment: [[0, 0], [Number.MAX_VALUE, 0]], expected: [[0, 0], [450, 0]] },
  { segment: [[Number.MAX_VALUE, 0], [0, 0]], expected: [[450, 0], [0, 0]] },
  { segment: [[0, 0], [-Number.MAX_VALUE, 0]], expected: [[0, 0], [-450, 0]] },
  { segment: [[-Number.MAX_VALUE, 0], [0, 0]], expected: [[-450, 0], [0, 0]] },
  { segment: [[0, 0], [Number.MAX_VALUE, Number.MAX_VALUE]], expected: [[0, 0], [450, 450]] },
  { segment: [[Number.MAX_VALUE, Number.MAX_VALUE], [0, 0]], expected: [[450, 450], [0, 0]] },
  { segment: [[0, 0], [-Number.MAX_VALUE, -Number.MAX_VALUE]], expected: [[0, 0], [-450, -450]] },
  { segment: [[-Number.MAX_VALUE, -Number.MAX_VALUE], [0, 0]], expected: [[-450, -450], [0, 0]] },
];
for (const { segment, expected } of largeClips) {
  const result = clipSegment(...segment);
  assert.deepEqual(result, expected);
  assert.ok(result);
  for (const point of result) {
    assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
    assert.ok(isInViewport(point));
    assertOnSourceSegment(point, segment);
  }
}

// Subnormal interpolation must retain the source line's signed minimum value;
// evaluating a power below Number.MIN_VALUE before applying the mantissa would
// incorrectly turn this boundary intersection into zero.
const subnormalSegment = [[-Number.MAX_VALUE, -Number.MIN_VALUE], [-Number.EPSILON / 2, Number.MIN_VALUE]];
const subnormalExpected = [[-VIEWPORT_HALF, Number.MIN_VALUE], [-Number.EPSILON / 2, Number.MIN_VALUE]];
assert.deepEqual(clipSegment(...subnormalSegment), subnormalExpected);
assert.deepEqual(clipSegment(...subnormalSegment.slice().reverse()), subnormalExpected.slice().reverse());
for (const point of clipSegment(...subnormalSegment)) assertOnSourceSegment(point, subnormalSegment);

for (const segment of [
  [[Number.MAX_VALUE, -1], [Number.MAX_VALUE, 1]],
  [[-Number.MAX_VALUE, -1], [-Number.MAX_VALUE, 1]],
  [[-1, Number.MAX_VALUE], [1, Number.MAX_VALUE]],
  [[-1, -Number.MAX_VALUE], [1, -Number.MAX_VALUE]],
]) {
  assert.equal(clipSegment(...segment), null);
}

// The line enters, leaves, travels outside, then re-enters. The two in-bounds
// runs stay as separate pieces instead of being falsely joined.
const reentry = clipPolyline([
  [-600, 100], [0, 100], [600, 100], [600, 300], [0, 300], [-600, 300],
]);
assert.deepEqual(reentry, [
  [[-450, 100], [0, 100], [450, 100]],
  [[450, 300], [0, 300], [-450, 300]],
]);
for (const piece of reentry) {
  for (const point of piece) assert.ok(isInViewport(point));
}
assert.deepEqual(equator.clipPolyline(reentry[0]), [reentry[0]]);
assert.deepEqual(equator.clipPolyline(reentry[1]), [reentry[1]]);

assert.throws(() => makeProjection([0]), TypeError);
assert.throws(() => makeProjection({ lon: 181, lat: 0 }), RangeError);
assert.throws(() => makeProjection({ lon: 0, lat: -91 }), RangeError);
assert.throws(() => makeProjection({ lon: 0, lat: 90 }), RangeError);
assert.throws(() => makeProjection({ lon: NaN, lat: 0 }), TypeError);
assert.throws(() => makeProjection([0, 0], { metresPerUnit: 0 }), RangeError);
assert.throws(() => makeProjection([0, 0], { viewportSize: -1 }), RangeError);
assert.throws(() => makeProjection([0, 0], { viewportSize: Infinity }), TypeError);
assert.throws(() => equator.project([0, 91]), RangeError);
assert.throws(() => equator.project([0, NaN]), TypeError);
assert.throws(() => equator.inverse([Infinity, 0]), TypeError);
assert.throws(() => equator.inverse([0, metresPerDegree * 91]), RangeError);
assert.throws(() => equator.projectSequence([0, 1]), TypeError);
assert.throws(() => clipPolyline([[0, 0], [Infinity, 1]]), TypeError);
assert.throws(() => isInViewport([0, 0], { minX: 1, maxX: -1, minZ: -1, maxZ: 1 }), RangeError);

console.log(JSON.stringify({
  tests: 'geography',
  projectedEastAtEquatorM: equator.project([1, 0])[0],
  fixturePoints: projectedFixture.length,
  clippedPieces: reentry.length,
}));
