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

console.log(JSON.stringify({
  tests: 'geography',
  projectedEastAtEquatorM: equator.project([1, 0])[0],
  fixturePoints: projectedFixture.length,
  clippedPieces: reentry.length,
  geojsonRecords: normalized.records.length,
  geojsonDiagnostics: mixedResult.diagnostics.length,
}));
