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
import { normalizeGeoJSON, SUPPORTED_GEOMETRY_TYPES } from '../src/geojson.js';
import { makeImportedWater, makeWater } from '../src/fields.js';
import { graphFabric } from '../src/fabric.js';
import { generateCity } from '../src/model.js';
import { drawMap } from '../src/map.js';
import { positionOnRoute, routeCarPlacement } from '../src/routing.js';
import { RNG } from '../src/rng.js';
import { centroid, isSimple, orientedRect, pointInPolygon } from '../src/geom.js';

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

// --- GeoJSON normalization -------------------------------------------------

assert.deepEqual(SUPPORTED_GEOMETRY_TYPES, ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

const lineFeature = {
  type: 'Feature',
  id: 'line-1',
  properties: { name: 'Main Street', tags: { lanes: 2 } },
  // The trailing elevation element is a valid GeoJSON position component and
  // must be read past rather than rejected.
  geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0.002, 12.5]] },
};
const multiLineFeature = {
  type: 'Feature',
  id: 0,
  properties: { name: 'Branching Way' },
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [[0, 0], [0.001, 0]],
      [[0.001, 0], [0.001, -0.002], [0.003, -0.002]],
    ],
  },
};
const polygonFeature = {
  type: 'Feature',
  properties: { kind: 'park' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [0.004, 0], [0.004, 0.004], [0, 0.004], [0, 0]],
      [[0.001, 0.001], [0.002, 0.001], [0.002, 0.002], [0.001, 0.002], [0.001, 0.001]],
    ],
  },
};
const multiPolygonFeature = {
  type: 'Feature',
  id: 42,
  properties: {},
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]],
      [
        [[0.005, 0.005], [0.008, 0.005], [0.008, 0.008], [0.005, 0.008], [0.005, 0.005]],
        [[0.006, 0.006], [0.007, 0.006], [0.007, 0.007], [0.006, 0.006]],
      ],
    ],
  },
};

const supported = {
  type: 'FeatureCollection',
  features: [lineFeature, multiLineFeature, polygonFeature, multiPolygonFeature],
};
const normalized = normalizeGeoJSON(supported, equator);
assert.deepEqual(normalized.diagnostics, []);
assert.equal(normalized.records.length, 4);
assert.deepEqual(normalized.records.map(record => record.index), [0, 1, 2, 3]);
assert.deepEqual(normalized.records.map(record => record.geometry.type), ['line', 'line', 'polygon', 'polygon']);

// Exact projected nesting: one part per LineString, one entry per source part,
// one polygon per source polygon, and rings grouped inside their polygon.
const [lineRecord, multiLineRecord, polygonRecord, multiPolygonRecord] = normalized.records;
assert.deepEqual(lineRecord.geometry, {
  type: 'line',
  parts: [[equator.project([0, 0]), equator.project([0.001, 0.002])]],
});
assert.deepEqual(multiLineRecord.geometry, {
  type: 'line',
  parts: multiLineFeature.geometry.coordinates.map(part => part.map(position => equator.project(position))),
});
assert.deepEqual(polygonRecord.geometry, {
  type: 'polygon',
  polygons: [polygonFeature.geometry.coordinates.map(ring => ring.map(position => equator.project(position)))],
});
assert.deepEqual(multiPolygonRecord.geometry, {
  type: 'polygon',
  polygons: multiPolygonFeature.geometry.coordinates.map(
    polygon => polygon.map(ring => ring.map(position => equator.project(position))),
  ),
});
assert.equal(polygonRecord.geometry.polygons[0].length, 2, 'polygon holes stay grouped with their outer ring');
assert.equal(multiPolygonRecord.geometry.polygons.length, 2);
assert.deepEqual(multiPolygonRecord.geometry.polygons.map(polygon => polygon.length), [1, 2]);

// The projection really is applied: local metres, north as negative z.
closePoint(lineRecord.geometry.parts[0][1], [0.001 * metresPerDegree, -0.002 * metresPerDegree]);
for (const point of lineRecord.geometry.parts[0]) {
  assert.equal(point.length, 2, 'elevation is dropped from projected points');
  assert.ok(equator.isInViewport(point));
}

// Source identifiers, including numeric zero and absent ids.
assert.deepEqual(normalized.records.map(record => record.sourceId), ['line-1', 0, null, 42]);
assert.deepEqual(
  normalizeGeoJSON({ ...lineFeature, id: { nope: true } }, equator).records[0].sourceId,
  null,
  'non string/number ids are reported as absent',
);

// Properties are copied, not aliased or shared with the source feature.
assert.deepEqual(lineRecord.properties, { name: 'Main Street', tags: { lanes: 2 } });
assert.notEqual(lineRecord.properties, lineFeature.properties);
const throwaway = normalizeGeoJSON(lineFeature, equator).records[0];
throwaway.properties.name = 'mutated';
assert.equal(lineFeature.properties.name, 'Main Street', 'record properties are a copy, not the source object');
assert.equal(lineRecord.properties.name, 'Main Street');
assert.deepEqual(polygonRecord.properties, { kind: 'park' });
assert.deepEqual(multiPolygonRecord.properties, {});
assert.deepEqual(
  normalizeGeoJSON({ ...polygonFeature, properties: null }, equator).records[0].properties,
  {},
  'missing properties normalize to an empty object',
);

// A bare Feature normalizes as a one-feature collection.
const singleFeature = normalizeGeoJSON(multiLineFeature, equator);
assert.deepEqual(singleFeature.diagnostics, []);
assert.deepEqual(singleFeature.records[0].geometry, multiLineRecord.geometry);
assert.equal(singleFeature.records[0].index, 0);

// Mixed valid and unusable features: every failure is skipped with one ordered
// diagnostic, and the trailing valid sibling still normalizes.
const mixed = {
  type: 'FeatureCollection',
  features: [
    lineFeature,
    null,
    { type: 'Feature', id: 'p1', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', id: 7, properties: {}, geometry: null },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [0.001, 0], [0, 0]], []]] },
    },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], ['a', 0]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [0, 91]] } },
    { type: 'Nonsense', geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] } },
    polygonFeature,
  ],
};
const mixedResult = normalizeGeoJSON(mixed, equator);
assert.deepEqual(mixedResult.records.map(record => record.index), [0, 9], 'valid siblings survive malformed input');
assert.deepEqual(mixedResult.records[0].geometry, {
  type: 'line',
  parts: [[equator.project([0, 0]), equator.project([0.001, 0.002])]],
});
assert.deepEqual(mixedResult.records[1].geometry, polygonRecord.geometry);
assert.deepEqual(
  mixedResult.diagnostics.map(({ index, sourceId, geometryType, code }) => [index, sourceId, geometryType, code]),
  [
    [1, null, null, 'invalid-feature'],
    [2, 'p1', 'Point', 'unsupported-geometry'],
    [3, 7, null, 'missing-geometry'],
    [4, null, 'LineString', 'empty-geometry'],
    [5, null, 'MultiPolygon', 'invalid-coordinate'],
    [6, null, 'LineString', 'invalid-coordinate'],
    [7, null, 'LineString', 'invalid-coordinate'],
    [8, null, 'LineString', 'invalid-feature'],
  ],
);
for (const diagnostic of mixedResult.diagnostics) {
  assert.equal(typeof diagnostic.message, 'string');
  assert.ok(diagnostic.message.length > 0);
}
assert.deepEqual(
  mixedResult.diagnostics.map(diagnostic => diagnostic.index),
  [...mixedResult.diagnostics.map(diagnostic => diagnostic.index)].sort((a, b) => a - b),
  'diagnostics stay in source order',
);
assert.deepEqual(normalizeGeoJSON({ type: 'FeatureCollection', features: [] }, equator), { records: [], diagnostics: [] });

// Determinism: repeated normalization of the same fixture serializes identically.
assert.equal(JSON.stringify(normalized), JSON.stringify(normalizeGeoJSON(supported, equator)));
assert.equal(JSON.stringify(mixedResult), JSON.stringify(normalizeGeoJSON(mixed, equator)));
assert.equal(
  JSON.stringify(normalizeGeoJSON(supported, makeProjection([0, 0]))),
  JSON.stringify(normalizeGeoJSON(supported, makeProjection({ lon: 0, lat: 0 }))),
);

// Only API-level arguments throw.
assert.throws(() => normalizeGeoJSON(null, equator), TypeError);
assert.throws(() => normalizeGeoJSON([lineFeature], equator), TypeError);
assert.throws(() => normalizeGeoJSON({ type: 'FeatureCollection' }, equator), TypeError);
assert.throws(() => normalizeGeoJSON({ type: 'LineString', coordinates: [] }, equator), TypeError);
assert.throws(() => normalizeGeoJSON(supported, {}), TypeError);
assert.throws(() => normalizeGeoJSON(supported, null), TypeError);

// Structural geometry validation: too few positions, unclosed rings, and safe
// projection-failure capture. Valid siblings still normalize.
const onePositionLine = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0]] } },
    lineFeature,
  ],
};
const onePositionResult = normalizeGeoJSON(onePositionLine, equator);
assert.deepEqual(onePositionResult.records.map(record => record.index), [1]);
assert.deepEqual(onePositionResult.diagnostics, [{
  index: 0,
  sourceId: null,
  geometryType: 'LineString',
  code: 'invalid-coordinate',
  message: 'coordinates must contain at least two positions',
}]);

const shortMultiLinePart = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'MultiLineString',
    coordinates: [[[0, 0], [0.001, 0]], [[0.002, 0]]],
  },
}, equator);
assert.equal(shortMultiLinePart.records.length, 0);
assert.deepEqual(shortMultiLinePart.diagnostics[0].code, 'invalid-coordinate');
assert.match(shortMultiLinePart.diagnostics[0].message, /coordinates\[1\] must contain at least two positions/);

const shortPolygonRing = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[[0, 0], [0.001, 0], [0, 0]]],
  },
}, equator);
assert.equal(shortPolygonRing.records.length, 0);
assert.deepEqual(shortPolygonRing.diagnostics[0].code, 'invalid-coordinate');
assert.match(shortPolygonRing.diagnostics[0].message, /coordinates\[0\] must contain at least four positions/);

const unclosedPolygonRing = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[[0, 0], [0.004, 0], [0.004, 0.004], [0, 0.004]]],
  },
}, equator);
assert.equal(unclosedPolygonRing.records.length, 0);
assert.deepEqual(unclosedPolygonRing.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  unclosedPolygonRing.diagnostics[0].message,
  /coordinates\[0\] must be closed with matching first and last longitude and latitude/,
);

const malformedMultiPolygonRing = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]],
      [[[0.005, 0.005], [0.008, 0.005], [0.008, 0.008], [0.005, 0.007]]],
    ],
  },
}, equator);
assert.equal(malformedMultiPolygonRing.records.length, 0);
assert.deepEqual(malformedMultiPolygonRing.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  malformedMultiPolygonRing.diagnostics[0].message,
  /coordinates\[1\]\[0\] must be closed with matching first and last longitude and latitude/,
);

// Elevation differences do not affect ring closure checks.
const closedRingWithElevation = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[[0, 0, 1], [0.004, 0], [0.004, 0.004, 2], [0, 0.004], [0, 0, 99]]],
  },
}, equator);
assert.equal(closedRingWithElevation.records.length, 1);

const structuralRecovery = normalizeGeoJSON({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0]] } },
    polygonFeature,
  ],
}, equator);
assert.deepEqual(structuralRecovery.records.map(record => record.index), [1]);
assert.deepEqual(structuralRecovery.records[0].geometry, polygonRecord.geometry);
assert.deepEqual(structuralRecovery.diagnostics[0].code, 'invalid-coordinate');

function projectionThatThrows(value) {
  return { project() { throw value; } };
}

const unformattableProjectionThrow = '\\[unformattable throw value\\]';

for (const [thrown, expectedFragment] of [
  [new Error('projection failed'), 'projection failed'],
  ['string throw', 'string throw'],
  [null, 'null'],
  [undefined, 'undefined'],
  [Object.create(null), unformattableProjectionThrow],
  [{ toString() { throw new Error('hostile toString'); } }, unformattableProjectionThrow],
  [{ [Symbol.toPrimitive]() { throw new Error('hostile toPrimitive'); } }, unformattableProjectionThrow],
  [{
    toString() { throw new Error('hostile toString'); },
    [Symbol.toPrimitive]() { throw new Error('hostile toPrimitive'); },
  }, unformattableProjectionThrow],
]) {
  const result = normalizeGeoJSON({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
  }, projectionThatThrows(thrown));
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.diagnostics[0].code, 'invalid-coordinate');
  assert.match(result.diagnostics[0].message, new RegExp(`could not be projected: ${expectedFragment}`));
}

const hostileProjectionRecovery = normalizeGeoJSON({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] } },
    lineFeature,
  ],
}, (() => {
  let throwOnce = true;
  return {
    project(coordinate) {
      if (throwOnce) {
        throwOnce = false;
        throw { [Symbol.toPrimitive]() { throw new Error('hostile'); } };
      }
      return equator.project(coordinate);
    },
  };
})());
assert.deepEqual(hostileProjectionRecovery.records.map(record => record.index), [1]);
assert.deepEqual(hostileProjectionRecovery.diagnostics[0].code, 'invalid-coordinate');
assert.match(hostileProjectionRecovery.diagnostics[0].message, /could not be projected: \[unformattable throw value\]/);

const proxyThrowingGetPrototypeOf = new Proxy({ [Symbol.toPrimitive]() { throw new Error('hostile'); } }, {
  getPrototypeOf() {
    throw new Error('hostile getPrototypeOf');
  },
});
const proxyThrowingGetPrototypeOfResult = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
}, projectionThatThrows(proxyThrowingGetPrototypeOf));
assert.equal(proxyThrowingGetPrototypeOfResult.records.length, 0);
assert.deepEqual(proxyThrowingGetPrototypeOfResult.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  proxyThrowingGetPrototypeOfResult.diagnostics[0].message,
  /could not be projected: \[unformattable throw value\]/,
);

const { proxy: revokedProjectionProxy, revoke: revokeProjectionProxy } = Proxy.revocable(
  { [Symbol.toPrimitive]() { throw new Error('hostile'); } },
  {},
);
revokeProjectionProxy();
const revokedProjectionProxyResult = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
}, projectionThatThrows(revokedProjectionProxy));
assert.equal(revokedProjectionProxyResult.records.length, 0);
assert.deepEqual(revokedProjectionProxyResult.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  revokedProjectionProxyResult.diagnostics[0].message,
  /could not be projected: \[unformattable throw value\]/,
);

const proxyWrappedError = new Proxy(new Error('proxy-wrapped projection failure'), {
  get(target, key) {
    if (key === 'message') throw new Error('hostile message trap');
    return Reflect.get(target, key);
  },
});
const proxyWrappedErrorResult = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
}, projectionThatThrows(proxyWrappedError));
assert.equal(proxyWrappedErrorResult.records.length, 0);
assert.deepEqual(proxyWrappedErrorResult.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  proxyWrappedErrorResult.diagnostics[0].message,
  /could not be projected: \[unformattable throw value\]/,
);

const projectionSiblingRecovery = normalizeGeoJSON({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] } },
    lineFeature,
  ],
}, (() => {
  let throwOnce = true;
  return {
    project(coordinate) {
      if (throwOnce) {
        throwOnce = false;
        throw proxyThrowingGetPrototypeOf;
      }
      return equator.project(coordinate);
    },
  };
})());
assert.deepEqual(projectionSiblingRecovery.records.map(record => record.index), [1]);
assert.deepEqual(projectionSiblingRecovery.diagnostics[0].code, 'invalid-coordinate');
assert.match(
  projectionSiblingRecovery.diagnostics[0].message,
  /could not be projected: \[unformattable throw value\]/,
);

const bigintGeometryTypeResult = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: { type: 1n, coordinates: [[0, 0], [0.001, 0]] },
}, equator);
assert.equal(bigintGeometryTypeResult.records.length, 0);
assert.deepEqual(bigintGeometryTypeResult.diagnostics[0].code, 'unsupported-geometry');
assert.match(
  bigintGeometryTypeResult.diagnostics[0].message,
  /geometry type 1n is not one of LineString, MultiLineString, Polygon, MultiPolygon/,
);

const hostileGeometryType = new Proxy({ evil: true }, {
  get() {
    throw new Error('hostile geometry type');
  },
});
const hostileGeometryTypeResult = normalizeGeoJSON({
  type: 'Feature',
  properties: {},
  geometry: { type: hostileGeometryType, coordinates: [[0, 0], [0.001, 0]] },
}, equator);
assert.equal(hostileGeometryTypeResult.records.length, 0);
assert.deepEqual(hostileGeometryTypeResult.diagnostics[0].code, 'unsupported-geometry');
assert.match(
  hostileGeometryTypeResult.diagnostics[0].message,
  /geometry type \[unformattable value\] is not one of LineString, MultiLineString, Polygon, MultiPolygon/,
);

const { proxy: revokedGeometryType, revoke: revokeGeometryType } = Proxy.revocable({}, {});
revokeGeometryType();
const geometryTypeSiblingRecovery = normalizeGeoJSON({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: revokedGeometryType, coordinates: [[0, 0], [0.001, 0]] } },
    lineFeature,
  ],
}, equator);
assert.deepEqual(geometryTypeSiblingRecovery.records.map(record => record.index), [1]);
assert.deepEqual(geometryTypeSiblingRecovery.diagnostics[0].code, 'unsupported-geometry');
assert.match(
  geometryTypeSiblingRecovery.diagnostics[0].message,
  /geometry type \[unformattable value\] is not one of LineString, MultiLineString, Polygon, MultiPolygon/,
);

// --- Imported water boundary -----------------------------------------------

const closedRect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const polygonWaterRecord = polygons => ({
  index: 0, sourceId: null, properties: {}, geometry: { type: 'polygon', polygons },
});

const lakeRecords = [
  { index: 0, geometry: { type: 'line', parts: [[[0, 0], [1, 1]]] } },
  polygonWaterRecord([[closedRect(-20, -10, 20, 10)]]),
];
const lakeSnapshot = JSON.stringify(lakeRecords);
const lake = makeImportedWater(lakeRecords, 100);
assert.equal(lake.kind, 'imported');
assert.deepEqual(lake.polygons, [[closedRect(-20, -10, 20, 10)]]);
assert.notEqual(lake.polygons[0][0], lakeRecords[1].geometry.polygons[0][0]);
assert.equal(JSON.stringify(lakeRecords), lakeSnapshot, 'imported water mutated normalized records');
assert.equal(lake.isLand(0, 0), false);
assert.equal(lake.isLand(30, 0), true);
assert.equal(lake.sdf(0, 0), -10);
assert.equal(lake.sdf(30, 0), 10);
assert.equal(lake.sdf(20, 0), 0);
assert.deepEqual(lake.shores, [{ pts: [[-20, -10], [20, -10], [20, 10], [-20, 10]], closed: true }]);

const holeRing = closedRect(-5, -5, 5, 5);
const holed = makeWater({ kind: 'imported', records: [
  polygonWaterRecord([[closedRect(-20, -20, 20, 20), holeRing]]),
] }, 100);
assert.equal(holed.isLand(0, 0), true, 'a polygon hole must remain land');
assert.equal(holed.isLand(10, 0), false);
assert.equal(holed.sdf(0, 0), 5);
assert.equal(holed.sdf(10, 0), -5);
assert.equal(holed.sdf(5, 0), 0);
assert.equal(holed.shores.length, 2);
assert.ok(holed.shores.every(shore => shore.closed));

const overlapping = makeImportedWater([
  polygonWaterRecord([
    [closedRect(-20, -10, 5, 10)],
    [closedRect(0, -10, 20, 10)],
  ]),
], 100);
assert.equal(overlapping.isLand(-10, 0), false);
assert.equal(overlapping.isLand(10, 0), false);
assert.equal(overlapping.isLand(30, 0), true);
assert.equal(overlapping.sdf(5, 0), -10, 'a hidden overlap edge is not union shoreline');
assert.equal(overlapping.sdf(30, 0), 10);

const multiPolygonRings = [
  [closedRect(-40, -10, -30, 10)],
  [closedRect(30, -10, 40, 10)],
];
const multiPolygonWater = makeImportedWater([polygonWaterRecord(multiPolygonRings)], 100);
assert.deepEqual(multiPolygonWater.polygons, multiPolygonRings);
assert.notEqual(multiPolygonWater.polygons[0][0], multiPolygonRings[0][0]);
assert.equal(multiPolygonWater.polygons.length, 2);
assert.equal(multiPolygonWater.isLand(-35, 0), false);
assert.equal(multiPolygonWater.isLand(35, 0), false);
assert.equal(multiPolygonWater.isLand(0, 0), true);
assert.equal(multiPolygonWater.shores.length, 2);

const crossing = makeImportedWater([
  polygonWaterRecord([[closedRect(-80, -20, 80, 20)]]),
], 100);
assert.deepEqual(crossing.shores, [
  { pts: [[-50, -20], [50, -20]], closed: false },
  { pts: [[50, 20], [-50, 20]], closed: false },
]);
for (const shore of crossing.shores) for (const point of shore.pts) {
  assert.ok(point[0] >= -50 && point[0] <= 50 && point[1] >= -50 && point[1] <= 50);
}
assert.deepEqual(makeImportedWater([
  polygonWaterRecord([[closedRect(60, 60, 80, 80)]]),
], 100).shores, []);
const emptyImported = makeImportedWater([], 100);
assert.deepEqual(emptyImported.polygons, []);
assert.deepEqual(emptyImported.shores, []);
assert.equal(emptyImported.isLand(0, 0), true);
assert.equal(emptyImported.sdf(0, 0), 1e9);
assert.equal(
  JSON.stringify(crossing),
  JSON.stringify(makeImportedWater([polygonWaterRecord([[closedRect(-80, -20, 80, 20)]])], 100)),
  'imported boundaries must serialize deterministically',
);
assert.throws(() => makeImportedWater(null, 100), TypeError);
assert.throws(() => makeImportedWater([polygonWaterRecord([[[[0, 0], [1, 0], [NaN, 1], [0, 0]]]])], 100), TypeError);
assert.throws(
  () => makeImportedWater([polygonWaterRecord([[[ [0, 0], [0, 0], [0, 0], [0, 0] ]]])], 100),
  TypeError,
);
assert.throws(
  () => makeImportedWater([polygonWaterRecord([[[ [0, 0], [10, 0], [20, 0], [0, 0] ]]])], 100),
  /non-zero area/,
);

// Existing procedural samples retain their contract when the imported branch
// is unused.
assert.equal(makeWater({ kind: 'flat' }, 100).sdf(0, 0), 1e9);
assert.ok(makeWater({ kind: 'river', x0: -10, x1: 10 }, 100).sdf(0, 0) < 0);
assert.ok(makeWater({ kind: 'coast', edge: 0 }, 100).sdf(-10, 0) < 0);
assert.ok(makeWater({ kind: 'island', rx: 20, rz: 10 }, 100).sdf(0, 0) > 0);

// Exercise the real graph/fabric boundary with a bounded imported mask. The
// eastern water polygon crosses the viewport; roads may bridge it, while all
// other road axes and retained buildable geometry must sample on land.
const importedLand = { kind: 'imported', records: [
  polygonWaterRecord([[closedRect(120, -600, 600, 600)]]),
] };
const importedModel = {
  roads: [], roadCaps: [], bridges: [], blocks: [], parcels: [], buildings: [],
  parks: [], plazas: [], trees: [], cars: [], drones: [], cranes: [], rail: null,
  landmarks: [], water: [], reserved: [],
};
graphFabric(importedModel, importedLand, new RNG('geography/imported-fabric'), {
  seed: 'geography/imported-fabric', density: 'low', pattern: 'manhattan',
  sector: 'mixed', detail: 'low', massing: 'modern',
});
const importedMask = importedModel.fields.water;
function sampleBoundaryOnLand(poly, clearance, label) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      assert.ok(importedMask.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) >= clearance,
        `${label} sampled inside imported water`);
    }
  }
}
for (const [index, road] of importedModel.roads.entries()) {
  const count = Math.max(1, Math.ceil(road.len / 3));
  for (let k = 0; k <= count; k++) {
    const t = k / count;
    assert.ok(importedMask.sdf(road.a[0] + (road.b[0] - road.a[0]) * t,
      road.a[1] + (road.b[1] - road.a[1]) * t) >= -0.25, `road ${index} enters imported water`);
  }
}
for (const [label, entries, clearance] of [
  ['block', importedModel.blocks.flatMap(block => (block.buildablePieces || (block.buildable ? [block.buildable] : []))
    .map(polygon => ({ polygon }))), 0.5],
  ['parcel', importedModel.parcels, 0.5],
  ['building', importedModel.buildings.map(building => ({ polygon: building.footprint })), 0.5],
]) for (const [index, entry] of entries.entries()) {
  if (entry.polygon) sampleBoundaryOnLand(entry.polygon, clearance, `${label} ${index}`);
}
assert.ok(importedModel.roads.length > 0 && importedModel.blocks.length > 0 && importedModel.parcels.length > 0);

// Closed imported lakes are disconnected graph components until a road reaches
// them. A 30-point ring previously disappeared during face extraction, leaving
// a land-centred block around water; a 500-point ring could instead become the
// largest component and discard every procedural road. Keep graph-only shores
// bounded and independently validate every accepted fabric polygon against the
// authoritative (unsimplified) mask.
function circularLake(vertexCount) {
  const ring = [];
  for (let i = 0; i < vertexCount; i++) {
    const angle = i / vertexCount * Math.PI * 2;
    ring.push([100 + Math.cos(angle) * 35, Math.sin(angle) * 35]);
  }
  return ring;
}

function assertClosedCircleShore(vertexCount) {
  const ring = circularLake(vertexCount);
  const records = [polygonWaterRecord([[ring.concat([ring[0].slice()])]])];
  const first = makeImportedWater(records, 900);
  const second = makeImportedWater(records, 900);
  assert.equal(first.shores.length, 1, `${vertexCount}-point in-viewport circle must be one shore`);
  assert.equal(first.shores[0].closed, true, `${vertexCount}-point in-viewport circle must stay closed`);
  assert.ok(first.shores[0].pts.length >= 3 && first.shores[0].pts.length <= 24,
    `${vertexCount}-point circle must respect the graph-only point bound`);
  assert.notDeepEqual(first.shores[0].pts[0], first.shores[0].pts.at(-1),
    `${vertexCount}-point closed shore must not repeat its first point`);
  assert.equal(JSON.stringify(first.shores), JSON.stringify(second.shores),
    `${vertexCount}-point circle shore must serialize deterministically`);
}

assertClosedCircleShore(30);
assertClosedCircleShore(500);

function lakeFabric(vertexCount) {
  const ring = circularLake(vertexCount);
  const model = {
    roads: [], roadCaps: [], bridges: [], blocks: [], parcels: [], buildings: [],
    parks: [], plazas: [], trees: [], cars: [], drones: [], cranes: [], rail: null,
    landmarks: [], water: [], reserved: [],
  };
  graphFabric(model, { kind: 'imported', records: [
    polygonWaterRecord([[ring.concat([ring[0].slice()])]]),
  ] }, new RNG(`geography/closed-lake-${vertexCount}`), {
    seed: `geography/closed-lake-${vertexCount}`, density: 'low', pattern: 'manhattan',
    sector: 'mixed', detail: 'low', massing: 'modern',
  });
  return { model, ring };
}

function assertLakeFabricOnLand(vertexCount) {
  const { model, ring } = lakeFabric(vertexCount);
  const mask = model.fields.water;
  assert.equal(mask.polygons[0][0].length, vertexCount + 1, 'authoritative lake ring was simplified');
  assert.ok(mask.shores.length === 1 && mask.shores[0].pts.length <= 24,
    'graph-only lake shore must have a deterministic point bound');
  assert.ok(model.roads.length > 0, `${vertexCount}-vertex lake discarded procedural roads`);

  const geometry = [
    ...model.blocks.map(block => ['block', block.polygon, 0]),
    ...model.blocks.flatMap(block => (block.buildablePieces || (block.buildable ? [block.buildable] : []))
      .map(poly => ['buildable', poly, .5])),
    ...model.parcels.map(parcel => ['parcel', parcel.polygon, .5]),
    ...model.buildings.map(building => ['building', building.footprint
      || orientedRect(building.cx, building.cz, building.w, building.d, building.angle || 0), .5]),
  ];
  for (const [index, [label, poly, clearance]] of geometry.entries()) {
    const [cx, cz] = centroid(poly);
    assert.ok(mask.isLand(cx, cz), `${vertexCount}-vertex lake ${label} ${index} centroid is water`);
    assert.ok(!ring.some(point => pointInPolygon(point[0], point[1], poly)),
      `${vertexCount}-vertex lake ${label} ${index} encloses imported water`);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        assert.ok(mask.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) >= clearance,
          `${vertexCount}-vertex lake ${label} ${index} crosses imported water`);
      }
    }
  }
  assert.ok(model.blocks.length > 0 && model.parcels.length > 0 && model.buildings.length > 0,
    `${vertexCount}-vertex lake did not exercise the complete fabric`);
}

assertLakeFabricOnLand(30);
assertLakeFabricOnLand(500);

function densifyClosed(ring, pointsPerEdge) {
  const dense = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (let k = 0; k < pointsPerEdge; k++) {
      const t = k / pointsPerEdge;
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return dense;
}

function assertShoreChordsAvoidLand(water, label) {
  for (const [index, shore] of water.shores.entries()) {
    const n = shore.pts.length;
    const count = shore.closed ? n : n - 1;
    assert.ok(count >= 1, `${label} shore ${index} is empty`);
    for (let i = 0; i < count; i++) {
      const a = shore.pts[i], b = shore.pts[(i + 1) % n];
      const samples = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let k = 1; k < samples; k++) {
        const t = k / samples;
        assert.ok(water.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) <= 0.5,
          `${label} shore ${index} chord ${i} cuts land`);
      }
    }
  }
}

// C-shaped lake: uniform 24-point decimation would chord the mouth through land.
const concaveCore = [
  [-80, -50], [80, -50], [80, 50], [25, 50], [25, -10], [-25, -10], [-25, 50], [-80, 50],
];
const concaveDense = densifyClosed(concaveCore, 40);
const concaveWater = makeImportedWater([
  polygonWaterRecord([[concaveDense.concat([concaveDense[0].slice()])]]),
], 900);
assert.ok(concaveWater.shores.length >= 1);
assert.ok(concaveWater.shores.every(shore => shore.pts.length <= 24));
assert.equal(concaveWater.isLand(0, 20), true, 'the C-mouth must remain land');
assert.equal(concaveWater.isLand(0, -30), false);
assertShoreChordsAvoidLand(concaveWater, 'concave C');

const ribbonLand = { kind: 'imported', records: [
  polygonWaterRecord([[closedRect(-350, -0.35, 350, 0.35)]]),
] };
const ribbonModel = {
  roads: [], roadCaps: [], bridges: [], blocks: [], parcels: [], buildings: [],
  parks: [], plazas: [], trees: [], cars: [], drones: [], cranes: [], rail: null,
  landmarks: [], water: [], reserved: [],
};
graphFabric(ribbonModel, ribbonLand, new RNG('geography/thin-ribbon'), {
  seed: 'geography/thin-ribbon', density: 'low', pattern: 'manhattan',
  sector: 'mixed', detail: 'low', massing: 'modern',
});
assert.ok(ribbonModel.roads.length > 0 && ribbonModel.blocks.length > 0);
for (const [index, block] of ribbonModel.blocks.entries()) {
  assert.ok(ribbonModel.fields.water.isLand(block.cx, block.cz), `thin ribbon block ${index} centroid is water`);
  assert.ok(!containsRing(block.polygon, ribbonLand.records[0].geometry.polygons[0][0]),
    `thin ribbon block ${index} encloses the water ribbon`);
}

function containsRing(poly, ring) {
  const count = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? ring.length - 1 : ring.length;
  for (let i = 0; i < count; i++) {
    if (pointInPolygon(ring[i][0], ring[i][1], poly)) return true;
    const q = ring[(i + 1) % count];
    if (pointInPolygon((ring[i][0] + q[0]) / 2, (ring[i][1] + q[1]) / 2, poly)) return true;
  }
  return false;
}

// --- W-000005: geographic-mode generateCity ------------------------------
const geoLine = (index, points, properties = {}) => ({
  index, sourceId: `road-${index}`, properties, geometry: { type: 'line', parts: [points] },
});
const geoRecords = (() => {
  const records = [];
  const axes = [-150, -50, 50, 150];
  for (const x of axes) records.push(geoLine(records.length, [[x, -150], [x, 150]]));
  for (const z of axes) records.push(geoLine(records.length, [[-150, z], [150, z]]));
  records.push(geoLine(records.length, [[150, 0], [260, 0]], { bridge: 'yes' }));
  records.push(geoLine(records.length, [[-150, 0], [-260, 0]], { tunnel: 'yes' }));
  records.push({
    index: records.length, sourceId: 'lake', properties: {},
    geometry: { type: 'polygon', polygons: [[closedRect(250, 250, 400, 400), closedRect(300, 300, 350, 350)]] },
  });
  return records;
})();
const geoConfig = {
  seed: 'geo', source: 'geographic', geography: { records: geoRecords, diagnostics: [{ code: 'upstream-note' }] },
  density: 'med', pattern: 'manhattan', sector: 'mixed', detail: 'low', massing: 'modern',
  land: 'flat', rail: 'none', life: 'none', air: 'none',
};
const geoModel = generateCity(geoConfig);
assert.equal(geoModel.source, 'geographic');
for (const key of ['roads', 'bridges', 'roadCaps', 'water', 'blocks', 'parcels', 'buildings', 'parks', 'plazas', 'corridors', 'faces']) {
  assert.ok(Array.isArray(geoModel[key]), `geographic model.${key} is an array`);
}
assert.ok(geoModel.graph && geoModel.stats && geoModel.traffic, 'geographic model exposes graph/stats/traffic');
assert.ok(geoModel.roads.length > 0 && geoModel.bridges.length === 1 && geoModel.corridors.length > 0);
const geoEdges = geoModel.graph.edges;
for (const entry of [...geoModel.roads, ...geoModel.bridges]) {
  const e = geoEdges[entry.edge];
  assert.ok(e && Number.isInteger(e.sourceIndex) && typeof e.roadId === 'string', 'rendered road resolves to imported provenance');
  assert.equal(geoRecords[e.sourceIndex].geometry.type, 'line');
  assert.ok(!e.tunnel && !((e.level ?? 0) < 0), 'below-grade edges are not rendered as surface roads');
  assert.equal(entry.bridge, !!(e.bridge || (e.level ?? 0) > 0));
}
assert.equal(geoEdges[geoModel.bridges[0].edge].bridge, true);
assert.ok(geoEdges.some(e => e.tunnel), 'tunnel edge is retained as graph data');
assert.ok(geoModel.roadCaps.length > 0 && geoModel.roadCaps.every(c => !c.elevated), 'no cap is fully elevated in the fixture');
assert.ok(geoModel.faces.length > 0);
for (const face of geoModel.faces) {
  assert.ok(face.area > 0 && isSimple(face.polygon), 'geographic faces are simple with positive area');
}
assert.ok(geoModel.blocks.length > 0 && geoModel.parcels.length > 0 && geoModel.buildings.length > 0);
assert.ok(geoModel.parcels.some(p => p.frontage), 'geographic parcels carry frontage');
assert.equal(geoModel.water.length, 1);
assert.equal(geoModel.water[0].type, 'imported');
assert.equal(geoModel.water[0].polygon.length, 4);
assert.deepEqual(geoModel.water[0].holes.map(h => h.length), [4]);
assert.equal(geoModel.water[0].sourceId, 'lake');
assert.ok(geoModel.geography && Array.isArray(geoModel.geography.diagnostics) && geoModel.geography.stats);
assert.deepEqual(geoModel.geography.upstreamDiagnostics, [{ code: 'upstream-note' }]);
assert.equal(geoModel.stats.lineRecords, 10);
const importerCountKeys = [
  'records', 'lineRecords', 'skippedRecords', 'sourceParts', 'sourceSegments',
  'candidateSubsegments', 'nodes', 'edges', 'duplicateSegments', 'components',
  'roadComponents', 'disconnectedComponents', 'disconnectedEdges', 'diagnostics',
  'bridges', 'elevatedEdges', 'bridgeElevatedEdges',
];
for (const key of importerCountKeys) {
  assert.ok(Number.isFinite(geoModel.stats.import[key]), `geographic stats.import.${key}`);
  assert.equal(geoModel.geography.stats[key], geoModel.stats.import[key], `geography/import stats disagree for ${key}`);
}
assert.equal(geoModel.stats.import.diagnostics, geoModel.geography.diagnostics.length);
assert.equal(geoModel.stats.import.bridgeElevatedEdges, 1);
for (const key of ['nodes', 'edges', 'faces', 'corridors']) {
  assert.ok(Number.isFinite(geoModel.stats[key]), `top-level UI stats.${key}`);
}
for (const key of ['faces', 'spurs', 'droppedEdges', 'degenerateFaces', 'offsetDrops', 'landlocked', 'slivers', 'corridors']) {
  assert.ok(Number.isFinite(geoModel.stats[key]), `geographic stats.${key}`);
}
assert.equal(JSON.stringify(generateCity(geoConfig)), JSON.stringify(geoModel), 'geographic generation is deterministic');

// Authoritative imported water rejects an untagged surface road instead of
// clipping or silently promoting it. The same source span is valid when its
// metadata explicitly marks a bridge or a positive level.
const centralWater = {
  index: 8, sourceId: 'central-lake', properties: {},
  geometry: { type: 'polygon', polygons: [[closedRect(-25, -25, 25, 25)]] },
};
const waterCrossingRecords = properties => [
  ...geoRecords.slice(0, 8), centralWater,
  { ...geoLine(9, [[-50, 0], [50, 0]], properties), sourceId: 'lake-crossing' },
];
const crossingError = /geographic source has unusable road-water data: at-grade edge=\d+ sourceIndex=9 sourceId="lake-crossing".*enters imported water/;
assert.throws(() => generateCity({
  ...geoConfig, seed: 'geo-water-invalid', geography: { records: waterCrossingRecords({}) },
}), crossingError);
const bridgeCrossingModel = generateCity({
  ...geoConfig, seed: 'geo-water-bridge', geography: { records: waterCrossingRecords({ bridge: 'yes' }) },
});
const elevatedCrossingModel = generateCity({
  ...geoConfig, seed: 'geo-water-elevated', geography: { records: waterCrossingRecords({ level: 1 }) },
});
for (const [label, model] of [['bridge', bridgeCrossingModel], ['elevated', elevatedCrossingModel]]) {
  const crossing = model.graph.edges.find(e => e.sourceId === 'lake-crossing');
  assert.ok(crossing, `${label} lake crossing remains in the imported graph`);
  assert.ok(model.bridges.some(entry => entry.edge === model.graph.edges.indexOf(crossing)), `${label} lake crossing renders on a deck`);
  assert.ok(model.blocks.length && model.parcels.length && model.buildings.length, `${label} water-safe fabric remains buildable`);
  const safePolygons = [
    ...model.blocks.flatMap(block => block.buildablePieces || (block.buildable ? [block.buildable] : [])),
    ...model.parcels.map(parcel => parcel.polygon),
    ...model.buildings.map(building => building.footprint || orientedRect(building.cx, building.cz, building.w, building.d, building.angle || 0)),
  ];
  assert.ok(safePolygons.length > 0, `${label} fixture exposes buildable geometry`);
  for (const [polygonIndex, polygon] of safePolygons.entries()) for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const samples = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      assert.ok(model.fields.water.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) > .5,
        `${label} buildable polygon ${polygonIndex} enters water`);
    }
  }
}

const routePosition = (model, predicate) => {
  const edge = model.graph.edges.findIndex(predicate);
  assert.ok(edge >= 0, 'route grade fixture edge exists');
  const metadata = model.graph.edges[edge];
  return positionOnRoute(model.graph, {
    path: [edge], nodes: [metadata.a, metadata.b], routeLength: model.graph.edgeLength(edge),
    t: 0, speed: 0, x: 0, z: 0, rot: 0,
  });
};
const bridgePosition = routePosition(geoModel, e => e.bridge);
assert.deepEqual({ bridge: bridgePosition.bridge, elevated: bridgePosition.elevated, belowGrade: bridgePosition.belowGrade, tunnel: bridgePosition.tunnel },
  { bridge: true, elevated: true, belowGrade: false, tunnel: false });
const tunnelPosition = routePosition(geoModel, e => e.tunnel);
assert.deepEqual({ bridge: tunnelPosition.bridge, elevated: tunnelPosition.elevated, belowGrade: tunnelPosition.belowGrade, tunnel: tunnelPosition.tunnel },
  { bridge: false, elevated: false, belowGrade: true, tunnel: true });
const elevatedPosition = routePosition(elevatedCrossingModel, e => e.sourceId === 'lake-crossing');
assert.deepEqual({ bridge: elevatedPosition.bridge, elevated: elevatedPosition.elevated, belowGrade: elevatedPosition.belowGrade, tunnel: elevatedPosition.tunnel },
  { bridge: false, elevated: true, belowGrade: false, tunnel: false });
assert.equal(positionOnRoute({ edgeLength: () => 0 }, { x: 1, z: 2, rot: 3, bridge: true }).bridge, true,
  'legacy non-routed bridge state retains its boolean meaning');

assert.deepEqual(routeCarPlacement(elevatedPosition, () => 100, () => 200, 1.4, 3.4),
  { x: elevatedPosition.x, y: 203.4, z: elevatedPosition.z, visible: true });
assert.deepEqual(routeCarPlacement(elevatedPosition, () => 100, () => 200, 2.3, 3.5),
  { x: elevatedPosition.x, y: 203.5, z: elevatedPosition.z, visible: true });
assert.equal(routeCarPlacement(tunnelPosition, () => 100, () => 200, 1.4, 3.4).visible, false);
assert.equal(routeCarPlacement(tunnelPosition, () => 100, () => 200, 2.3, 3.5).visible, false);

// Imported water reaches the map canvas as outer ring + hole with an even-odd fill.
const canvasCalls = [];
const canvasCtx = new Proxy({
  beginPath() { canvasCalls.push(['begin']); }, moveTo(x, y) { canvasCalls.push(['move', x, y]); },
  lineTo(x, y) { canvasCalls.push(['line', x, y]); }, closePath() { canvasCalls.push(['close']); },
  fill(rule) { canvasCalls.push(['fill', rule ?? null]); },
  setLineDash() {}, save() {}, restore() {}, fillRect() {}, stroke() {}, arc() {}, translate() {}, rotate() {}, fillText() {},
}, { set(target, key, value) { target[key] = value; return true; } });
const waterOnly = Object.fromEntries(['edges', 'nodes', 'spurs', 'faces', 'water', 'elevation', 'population', 'direction', 'reserved',
  'walkshed', 'blocks', 'parcels', 'buildings', 'labels', 'traffic'].map(k => [k, k === 'water']));
drawMap(canvasCtx, geoModel, 200, 200, waterOnly);
const waterBegin = canvasCalls.findIndex(c => c[0] === 'begin');
const waterFill = canvasCalls.findIndex((c, i) => i > waterBegin && c[0] === 'fill');
assert.ok(waterBegin >= 0 && waterFill > waterBegin, 'imported water traced a canvas path');
const waterPath = canvasCalls.slice(waterBegin + 1, waterFill);
assert.equal(waterPath.filter(c => c[0] === 'move').length, 2, 'outer ring and hole each start a subpath');
assert.equal(waterPath.filter(c => c[0] === 'close').length, 2);
assert.equal(waterPath.filter(c => c[0] === 'line').length, 6);
assert.deepEqual(canvasCalls[waterFill], ['fill', 'evenodd']);

// Unusable geographic road data throws a clear, recoverable error.
const geoErr = /geographic source has no usable road faces/;
assert.throws(() => generateCity({ ...geoConfig, geography: { records: [] } }), geoErr);
assert.throws(() => generateCity({ ...geoConfig, geography: { records: [geoRecords.at(-1)] } }), geoErr);
assert.throws(() => generateCity({ ...geoConfig, geography: { records: [geoLine(0, [[0, 0], [100, 0]])] } }), geoErr);
assert.throws(() => generateCity({ ...geoConfig, geography: null }), TypeError);
assert.throws(() => generateCity({ ...geoConfig, engine: 'bsp' }), /graph engine/);
assert.equal(JSON.stringify(generateCity(geoConfig)), JSON.stringify(geoModel), 'geographic generation recovers after errors');
const proceduralConfig = { ...geoConfig, source: undefined, geography: undefined, seed: 'procedural-after-geo' };
const proceduralAfter = generateCity(proceduralConfig);
assert.ok(proceduralAfter.roads.length > 0 && proceduralAfter.source !== 'geographic');
assert.equal(proceduralAfter.geography, undefined);
assert.equal(JSON.stringify(generateCity(proceduralConfig)), JSON.stringify(proceduralAfter), 'procedural path is unchanged');

console.log(JSON.stringify({
  tests: 'geography',
  projectedEastAtEquatorM: equator.project([1, 0])[0],
  fixturePoints: projectedFixture.length,
  clippedPieces: reentry.length,
  geojsonRecords: normalized.records.length,
  geojsonDiagnostics: mixedResult.diagnostics.length,
}));
