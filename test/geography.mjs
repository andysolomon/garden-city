import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { drawMap, LAYERS } from '../src/map.js';
import { positionOnRoute, routeCarPlacement } from '../src/routing.js';
import { RNG, hashSeed } from '../src/rng.js';
import { area, bbox, centroid, isSimple, orientedRect, pointInPolygon, polyIntersectsRect, segIntersect } from '../src/geom.js';

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

// --- W-000006: classified source footprints and land use ------------------
const geoPolygon = (index, sourceId, properties, polygons) => ({
  index, sourceId, properties, geometry: { type: 'polygon', polygons },
});
const footprintRecords = [
  ...geoRecords,
  geoPolygon(10, 'height-building', { kind: 'building', natural: 'water', height: '27.5', 'building:levels': 99 }, [[closedRect(-140, -140, -128, -128)]]),
  geoPolygon(11, 'levels-building', { building: 'yes', 'building:levels': '4' }, [[closedRect(-115, -140, -100, -128)]]),
  geoPolygon(12, 0, { building: 'apartments' }, [
    [closedRect(-140, -115, -125, -100), closedRect(-136, -111, -129, -104)],
    [closedRect(-118, -115, -105, -100)],
  ]),
  geoPolygon(13, 'source-park', { kind: 'park', water: 'yes' }, [[closedRect(-90, -140, -70, -120)]]),
  geoPolygon(14, 'source-landuse', { landuse: 'industrial' }, [[closedRect(-90, -110, -70, -90)]]),
  geoPolygon(15, 'tagged-water', { natural: 'water' }, [[closedRect(70, 70, 90, 90)]]),
  geoPolygon(16, 'water-building', { building: true }, [[closedRect(75, 75, 85, 85)]]),
];
const footprintSnapshot = JSON.stringify(footprintRecords);
const footprintConfig = {
  ...geoConfig, seed: 'geo-footprints', geography: { records: footprintRecords, diagnostics: [{ code: 'upstream-note' }] },
};
const footprintModel = generateCity(footprintConfig);
assert.equal(JSON.stringify(footprintRecords), footprintSnapshot, 'geographic generation mutated source records');
const importedBuildings = footprintModel.buildings.filter(building => building.imported);
const importedParks = footprintModel.parks.filter(park => park.imported);
assert.deepEqual(importedBuildings.map(building => [building.sourceIndex, building.sourceId, building.sourcePart]), [
  [10, 'height-building', 0], [11, 'levels-building', 0], [12, 0, 0], [12, 0, 1],
]);
assert.deepEqual(importedParks.map(park => [park.sourceIndex, park.sourceId, park.sourcePart, park.landUse]), [
  [13, 'source-park', 0, 'park'], [14, 'source-landuse', 0, 'industrial'],
]);
assert.equal(footprintModel.water.length, 2, 'only unclassified and explicitly tagged water become water');
assert.deepEqual(footprintModel.water.map(water => water.sourceId), ['lake', 'tagged-water']);

const sourceHeightBuilding = importedBuildings.find(building => building.sourceId === 'height-building');
const levelsHeightBuilding = importedBuildings.find(building => building.sourceId === 'levels-building');
const fallbackBuildings = importedBuildings.filter(building => building.sourceId === 0);
assert.equal(sourceHeightBuilding.h, 27.5);
assert.equal(levelsHeightBuilding.h, 12);
assert.deepEqual(fallbackBuildings.map(building => building.h), [33, 27], 'fallback height is source-identity/part stable');
assert.deepEqual(sourceHeightBuilding.footprint, closedRect(-140, -140, -128, -128).slice(0, -1));
assert.deepEqual(
  { x: sourceHeightBuilding.x, z: sourceHeightBuilding.z, w: sourceHeightBuilding.w, d: sourceHeightBuilding.d,
    cx: sourceHeightBuilding.cx, cz: sourceHeightBuilding.cz, angle: sourceHeightBuilding.angle, y: sourceHeightBuilding.y },
  { x: -140, z: -140, w: 12, d: 12, cx: -134, cz: -134, angle: 0, y: 0 },
  'imported polygon buildings retain rectangle compatibility fields',
);
assert.deepEqual(fallbackBuildings[0].courtyard, closedRect(-136, -111, -129, -104).slice(0, -1));
assert.equal(fallbackBuildings[1].courtyard, undefined, 'each MultiPolygon component becomes its own building');
assert.deepEqual(
  footprintModel.geography.diagnostics.filter(diagnostic => diagnostic.code.startsWith('imported-building-')),
  [{ index: 16, sourceId: 'water-building', sourcePart: 0, code: 'imported-building-water',
    message: 'imported building footprint is not fully on land' }],
);
assert.equal(footprintModel.geography.stats.diagnostics, footprintModel.geography.diagnostics.length);
assert.equal(footprintModel.stats.import.diagnostics, footprintModel.geography.diagnostics.length);
assert.equal(footprintModel.stats.diagnostics, footprintModel.geography.diagnostics.length,
  'top-level stats stay synchronized with imported-feature rejections');
assert.equal(JSON.stringify(generateCity(footprintConfig)), JSON.stringify(footprintModel),
  'classified geographic generation serializes identically on repeat');

function polygonsOverlap(a, b) {
  const aa = bbox(a), bb = bbox(b);
  if (!(aa.x < bb.x + bb.w && aa.x + aa.w > bb.x && aa.z < bb.z + bb.d && aa.z + aa.d > bb.z)) return false;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i], q = a[(i + 1) % a.length], r = b[j], s = b[(j + 1) % b.length];
    if (segIntersect(p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1])) return true;
  }
  return pointInPolygon(a[0][0], a[0][1], b) || pointInPolygon(b[0][0], b[0][1], a);
}

const sourceClaims = [...importedBuildings.map(building => building.footprint), ...importedParks.map(park => park.polygon)];
const generatedBuildings = footprintModel.buildings.filter(building => !building.imported);
assert.ok(generatedBuildings.length > 0, 'claim fixture retains procedural geographic massing');
for (const [buildingIndex, building] of generatedBuildings.entries()) {
  const footprint = building.footprint || orientedRect(building.cx, building.cz, building.w, building.d, building.angle || 0);
  for (const [claimIndex, claim] of sourceClaims.entries()) {
    assert.equal(polygonsOverlap(footprint, claim), false,
      `generated building ${buildingIndex} overlaps imported claim ${claimIndex}`);
  }
}

// Rail planning precedes source acceptance, so its deterministic corridor can
// be used to prove exact reserved-rectangle rejection without source RNG draws.
const railProbe = generateCity({ ...geoConfig, seed: 'geo-reserved', rail: 'elevated' });
const corridor = railProbe.reserved[0];
const reservedFootprint = closedRect(
  corridor.x + corridor.w / 2 - 4, corridor.z + corridor.d / 2 - 4,
  corridor.x + corridor.w / 2 + 4, corridor.z + corridor.d / 2 + 4,
);
const reservedRecord = geoPolygon(10, 'reserved-building', { building: 'yes' }, [[reservedFootprint]]);
const reservedModel = generateCity({
  ...geoConfig, seed: 'geo-reserved', rail: 'elevated',
  geography: { records: [...geoRecords, reservedRecord] },
});
assert.equal(reservedModel.buildings.some(building => building.sourceId === 'reserved-building'), false);
assert.deepEqual(
  reservedModel.geography.diagnostics.filter(diagnostic => diagnostic.code === 'imported-building-reserved'),
  [{ index: 10, sourceId: 'reserved-building', sourcePart: 0, code: 'imported-building-reserved',
    message: 'imported building footprint intersects reserved infrastructure' }],
);
assert.equal(reservedModel.geography.stats.diagnostics, reservedModel.geography.diagnostics.length,
  'geography stats stay synchronized with reserved-rectangle rejections');
assert.equal(reservedModel.stats.import.diagnostics, reservedModel.geography.diagnostics.length,
  'import stats stay synchronized with reserved-rectangle rejections');
assert.equal(reservedModel.stats.diagnostics, reservedModel.geography.diagnostics.length,
  'top-level stats stay synchronized with reserved-rectangle rejections');

// --- W-000006 remediation: finite levels heights, false-like tags, ring validity ---
const zeroAreaRing = closedRect(-115, -115, -75, -115).slice(0, -1);
const buildingBowtie = [[-60, -85], [-52, -77], [-52, -93], [-60, -77], [-60, -85]].slice(0, -1);
const parkBowtie = [[-10, -85], [-2, -77], [-2, -93], [-10, -77], [-10, -85]].slice(0, -1);
assert.equal(area(zeroAreaRing), 0, 'zero-area fixture ring is degenerate');
assert.ok(area(buildingBowtie) > 0 && !isSimple(buildingBowtie), 'building fixture ring is non-simple with positive area');
assert.ok(area(parkBowtie) > 0 && !isSimple(parkBowtie), 'park fixture ring is non-simple with positive area');

const remediationRecords = [
  ...geoRecords,
  geoPolygon(10, 'huge-levels', { building: 'yes', 'building:levels': '1e308' }, [[closedRect(-140, -140, -128, -128)]]),
  geoPolygon(11, 'max-levels', { building: 'yes', 'building:levels': Number.MAX_VALUE }, [[closedRect(-115, -140, -100, -128)]]),
  geoPolygon(12, 'finite-huge-levels', { building: 'yes', 'building:levels': '1e307' }, [[closedRect(-90, -140, -75, -128)]]),
  geoPolygon(13, 'false-string-building', { building: 'false', landuse: 'grass' }, [[closedRect(-40, -140, -25, -128)]]),
  geoPolygon(14, 'zero-string-building', { building: '0' }, [[closedRect(-10, -140, 10, -128)]]),
  geoPolygon(15, 'off-building', { building: 'off', landuse: 'cemetery' }, [[closedRect(25, -140, 40, -128)]]),
  geoPolygon(16, 'false-water-landuse', { landuse: 'grass', water: '0' }, [[closedRect(25, -115, 40, -100)]]),
  geoPolygon(17, 'false-boolean-building', { building: false, landuse: 'recreation_ground' }, [[closedRect(-40, -100, -25, -85)]]),
  geoPolygon(18, 'yes-building', { building: 'yes', height: '9' }, [[closedRect(-140, -115, -128, -100)]]),
  geoPolygon(19, 'zero-area-building', { building: 'yes' }, [[closedRect(-115, -115, -75, -115)]]),
  geoPolygon(20, 'nonsimple-building', { building: 'yes' }, [[buildingBowtie.concat([buildingBowtie[0].slice()])]]),
  geoPolygon(21, 'zero-area-park', { kind: 'park' }, [[closedRect(-40, -115, -25, -115)]]),
  geoPolygon(22, 'nonsimple-park', { kind: 'park' }, [[parkBowtie.concat([parkBowtie[0].slice()])]]),
];
const remediationSnapshot = JSON.stringify(remediationRecords);
const remediationConfig = {
  ...geoConfig, seed: 'geo-remediation',
  geography: { records: remediationRecords, diagnostics: [{ code: 'upstream-note' }] },
};
const remediationModel = generateCity(remediationConfig);
assert.equal(JSON.stringify(remediationRecords), remediationSnapshot, 'remediation fixture mutated source records');
const remediationBuildings = remediationModel.buildings.filter(building => building.imported);
const remediationParks = remediationModel.parks.filter(park => park.imported);
assert.ok(remediationModel.buildings.every(building => Number.isFinite(building.h) && building.h > 0),
  'every model building height is finite and positive');
assert.deepEqual(remediationBuildings.map(building => building.sourceId),
  ['huge-levels', 'max-levels', 'finite-huge-levels', 'yes-building'],
  'false-like and geometry-invalid building records create no buildings');
assert.equal(remediationBuildings.find(building => building.sourceId === 'finite-huge-levels').h,
  Number('1e307') * 3, 'a finite huge levels-derived height is still accepted');
assert.equal(remediationBuildings.find(building => building.sourceId === 'huge-levels').h,
  12 + hashSeed('huge-levels|10|0') % 25, 'overflowing levels-derived heights fall back to the stable identity hash');
assert.equal(remediationBuildings.find(building => building.sourceId === 'max-levels').h,
  12 + hashSeed('max-levels|11|0') % 25);
assert.equal(remediationBuildings.find(building => building.sourceId === 'yes-building').h, 9,
  'truthy building tags still classify and keep source heights');
assert.deepEqual(remediationParks.map(park => [park.sourceId, park.landUse]), [
  ['false-string-building', 'grass'], ['off-building', 'cemetery'],
  ['false-water-landuse', 'grass'], ['false-boolean-building', 'recreation_ground'],
], 'false-like building/water tags do not override valid land-use classification');
assert.deepEqual(remediationModel.water.map(water => water.sourceId), ['lake', 'zero-string-building'],
  'a false-like unclassified building tag falls back to water, not a building');
assert.deepEqual(
  remediationModel.geography.diagnostics.filter(diagnostic => diagnostic.code.endsWith('-geometry')),
  [
    { index: 19, sourceId: 'zero-area-building', sourcePart: 0, code: 'imported-building-geometry',
      message: 'imported building outer ring has non-positive area' },
    { index: 20, sourceId: 'nonsimple-building', sourcePart: 0, code: 'imported-building-geometry',
      message: 'imported building outer ring is not simple' },
    { index: 21, sourceId: 'zero-area-park', sourcePart: 0, code: 'imported-park-geometry',
      message: 'imported park outer ring has non-positive area' },
    { index: 22, sourceId: 'nonsimple-park', sourcePart: 0, code: 'imported-park-geometry',
      message: 'imported park outer ring is not simple' },
  ],
  'invalid imported building/park rings are omitted with deterministic type-specific diagnostics',
);
assert.equal(remediationModel.geography.stats.diagnostics, remediationModel.geography.diagnostics.length,
  'geography stats stay synchronized with ring rejections');
assert.equal(remediationModel.stats.import.diagnostics, remediationModel.geography.diagnostics.length,
  'import stats stay synchronized with ring rejections');
assert.equal(remediationModel.stats.diagnostics, remediationModel.geography.diagnostics.length,
  'top-level stats stay synchronized with ring rejections');
assert.equal(JSON.stringify(generateCity(remediationConfig)), JSON.stringify(remediationModel),
  'remediation fixture generation serializes identically on repeat');

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

// Polygon/courtyard buildings and imported parks have independent default map
// layers, while rectangle-only buildings retain the compatibility fallback.
assert.equal(LAYERS.find(([key]) => key === 'parks')[2], true);
const mapCalls = [];
const mapCtx = new Proxy({
  beginPath() { mapCalls.push(['begin']); }, moveTo(x, y) { mapCalls.push(['move', x, y]); },
  lineTo(x, y) { mapCalls.push(['line', x, y]); }, closePath() { mapCalls.push(['close']); },
  fill(rule) { mapCalls.push(['fill', rule ?? null]); }, fillRect(...args) { mapCalls.push(['fillRect', ...args]); },
  setLineDash() {}, save() {}, restore() {}, stroke() {}, arc() {}, translate() {}, rotate() {}, fillText() {},
}, { set(target, key, value) { target[key] = value; return true; } });
const mapFixture = {
  size: 100, fields: null, graph: null, water: [], reserved: [], faces: [], blocks: [], parcels: [], plazas: [], centers: null,
  parks: [{ polygon: closedRect(-40, -40, -20, -20).slice(0, -1), imported: true, landUse: 'park' }],
  buildings: [
    { footprint: closedRect(-10, -10, 10, 10).slice(0, -1), courtyard: closedRect(-4, -4, 4, 4).slice(0, -1), y: 0 },
    { cx: 30, cz: 30, w: 10, d: 8, angle: 0, y: 0 },
  ],
};
const mapLayers = Object.fromEntries(LAYERS.map(([key]) => [key, key === 'parks' || key === 'buildings']));
drawMap(mapCtx, mapFixture, 200, 200, mapLayers);
const evenOddFill = mapCalls.findIndex(call => call[0] === 'fill' && call[1] === 'evenodd');
assert.ok(evenOddFill >= 0, 'polygon building uses an even-odd map fill');
const buildingPath = mapCalls.slice(mapCalls.map(call => call[0]).lastIndexOf('begin', evenOddFill) + 1, evenOddFill);
assert.equal(buildingPath.filter(call => call[0] === 'move').length, 2, 'building outer and courtyard start separate subpaths');
assert.equal(buildingPath.filter(call => call[0] === 'close').length, 2);
assert.ok(mapCalls.some(call => call[0] === 'fill' && call[1] === null), 'imported park traces a filled polygon path');
assert.equal(mapCalls.filter(call => call[0] === 'fillRect').length, 2,
  'map background and rectangle building use fillRect fallback');

// Contact-sheet thumbnails pin an explicit layer selection; parks must be
// enabled there alongside the thumbnail's existing block/map layers.
const contactSource = readFileSync(new URL('../contact.html', import.meta.url), 'utf8');
const contactSelection = contactSource.match(/LAYERS\.map\(\(\[k\]\) => \[k, \[([^\]]*)\]\.includes\(k\)\]\)/);
assert.ok(contactSelection, 'contact.html pins an explicit thumbnail layer selection');
const contactKeys = contactSelection[1].split(',').map(key => key.trim().replaceAll('\'', '')).filter(Boolean);
for (const key of ['water', 'parks', 'blocks', 'buildings', 'edges', 'spurs']) {
  assert.ok(contactKeys.includes(key), `contact thumbnails enable the ${key} layer`);
}

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

// --- W-000007: hybrid imported infrastructure + procedural fill -------------
const proceduralGraphConfig = {
  seed: 'hybrid-compat-graph', pattern: 'manhattan', density: 'med', land: 'flat',
  rail: 'none', life: 'none', air: 'none',
};
const bspCompatConfig = { ...proceduralGraphConfig, seed: 'hybrid-compat-bsp', engine: 'bsp' };
const geographicBeforeHybrid = JSON.stringify(geoModel);
const proceduralGraphBeforeHybrid = JSON.stringify(generateCity(proceduralGraphConfig));
const bspBeforeHybrid = JSON.stringify(generateCity(bspCompatConfig));

const hybridConfig = { ...footprintConfig, seed: 'hybrid', source: 'hybrid', life: 'high' };
const hybridSnapshot = JSON.stringify(footprintRecords);
const hybridModel = generateCity(hybridConfig);
assert.equal(JSON.stringify(footprintRecords), hybridSnapshot, 'hybrid generation mutated source records');
assert.equal(hybridModel.source, 'hybrid');
assert.ok(hybridModel.graph && hybridModel.traffic && hybridModel.geography);

const hybridGeographicTwin = generateCity({ ...hybridConfig, source: 'geographic' });
const importedRoadSignature = model => [...model.roads, ...model.bridges].map(entry => {
  const e = model.graph.edges[entry.edge];
  return [entry.a, entry.b, entry.angle, entry.width, entry.len, entry.bridge,
    e.sourceIndex, e.sourceId, e.sourcePart, e.roadId];
});
const shorelineSignature = model => model.water.map(water =>
  [water.type, water.sourceIndex, water.sourceId, water.sourcePart, water.polygon, water.holes]);
assert.deepEqual(importedRoadSignature(hybridModel), importedRoadSignature(hybridGeographicTwin),
  'hybrid imported road axes/provenance match the geographic fixture');
assert.deepEqual(shorelineSignature(hybridModel), shorelineSignature(hybridGeographicTwin),
  'hybrid shoreline rings match the geographic fixture');
assert.deepEqual(
  hybridModel.buildings.filter(building => building.imported).map(building =>
    [building.sourceIndex, building.sourceId, building.sourcePart, building.h, building.footprint]),
  hybridGeographicTwin.buildings.filter(building => building.imported).map(building =>
    [building.sourceIndex, building.sourceId, building.sourcePart, building.h, building.footprint]),
  'hybrid keeps authoritative imported building claims');
assert.notEqual(JSON.stringify(hybridModel), JSON.stringify(hybridGeographicTwin),
  'hybrid :hybrid stream must not reproduce the geographic :city serialization');

const hybridClaims = [
  ...hybridModel.buildings.filter(building => building.imported).map(building => building.footprint),
  ...hybridModel.parks.filter(park => park.imported).map(park => park.polygon),
];
const hybridImportedBuildings = hybridModel.buildings.filter(building => building.imported).map(building => building.footprint);
const hybridGenerated = hybridModel.buildings.filter(building => !building.imported);
assert.ok(hybridGenerated.length > 0, 'hybrid retains procedural massing on unclaimed land');
for (const [buildingIndex, building] of hybridGenerated.entries()) {
  const footprint = building.footprint || orientedRect(building.cx, building.cz, building.w, building.d, building.angle || 0);
  for (const [claimIndex, claim] of hybridClaims.entries()) {
    assert.equal(polygonsOverlap(footprint, claim), false,
      `hybrid generated building ${buildingIndex} overlaps imported claim ${claimIndex}`);
  }
  assert.equal(hybridModel.reserved.some(rect => polyIntersectsRect(footprint, rect)), false,
    `hybrid generated building ${buildingIndex} intersects reserved infrastructure`);
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i], b = footprint[(i + 1) % footprint.length];
    const samples = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      assert.ok(hybridModel.fields.water.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) > .5,
        `hybrid generated building ${buildingIndex} enters water`);
    }
  }
}

const hybridProceduralParks = hybridModel.parks.filter(park => !park.imported);
assert.ok(hybridProceduralParks.length > 0, 'hybrid retains procedural parks on valid land');
assert.ok(hybridModel.faces.some(face => hybridModel.water.some(water => polygonsOverlap(face.polygon, water.polygon))),
  'hybrid water fixture cuts a source road face');
for (const [parkIndex, park] of hybridProceduralParks.entries()) {
  assert.equal(hybridClaims.some(claim => polygonsOverlap(park.polygon, claim)), false,
    `hybrid procedural park ${parkIndex} overlaps an imported claim`);
  assert.equal(hybridModel.reserved.some(rect => polyIntersectsRect(park.polygon, rect)), false,
    `hybrid procedural park ${parkIndex} intersects reserved infrastructure`);
  assert.equal(hybridModel.water.some(water => polygonsOverlap(park.polygon, water.polygon)), false,
    `hybrid procedural park ${parkIndex} enters authoritative water`);
}

assert.ok(hybridModel.trees.length > 0, 'hybrid life places procedural trees');
const treeHosts = [...hybridModel.parks, ...hybridModel.plazas];
for (const [treeIndex, tree] of hybridModel.trees.entries()) {
  assert.ok(treeHosts.some(host => host.polygon && pointInPolygon(tree.x, tree.z, host.polygon)),
    `hybrid tree ${treeIndex} is outside park/plaza polygons`);
  assert.equal(hybridModel.fields.water.sdf(tree.x, tree.z) > .5, true,
    `hybrid tree ${treeIndex} enters authoritative water`);
  assert.equal(hybridModel.reserved.some(rect =>
    tree.x >= rect.x && tree.x <= rect.x + rect.w && tree.z >= rect.z && tree.z <= rect.z + rect.d), false,
  `hybrid tree ${treeIndex} intersects reserved infrastructure`);
  assert.equal(hybridImportedBuildings.some(claim => pointInPolygon(tree.x, tree.z, claim)), false,
    `hybrid tree ${treeIndex} enters an imported building claim`);
}

// Adding a source building around a tree that the same seed would otherwise
// place makes the park/tree claim checks non-vacuous without changing RNG input.
const claimBaselineConfig = { ...geoConfig, seed: 'claim-0', source: 'hybrid', life: 'high' };
const claimBaseline = generateCity(claimBaselineConfig);
const claimedParkCandidate = claimBaseline.parks.find(park => !park.imported);
assert.ok(claimedParkCandidate, 'claim probe has a procedural park candidate');
const claimedTreeCandidate = claimBaseline.trees.find(tree =>
  pointInPolygon(tree.x, tree.z, claimedParkCandidate.polygon));
assert.ok(claimedTreeCandidate, 'claim probe has a procedural tree candidate');
const treeClaim = closedRect(
  claimedTreeCandidate.x - 1, claimedTreeCandidate.z - 1,
  claimedTreeCandidate.x + 1, claimedTreeCandidate.z + 1,
);
assert.ok(polygonsOverlap(claimedParkCandidate.polygon, treeClaim)
  && pointInPolygon(claimedTreeCandidate.x, claimedTreeCandidate.z, treeClaim),
  'source-building probe covers a park and tree that would otherwise be placed');
const treeClaimRecord = geoPolygon(geoRecords.length, 'hybrid-tree-claim', { building: 'yes' }, [[treeClaim]]);
const claimedHybrid = generateCity({
  ...claimBaselineConfig, geography: { records: [...geoRecords, treeClaimRecord] },
});
const acceptedTreeClaim = claimedHybrid.buildings.find(building => building.sourceId === 'hybrid-tree-claim');
assert.ok(acceptedTreeClaim?.imported, 'hybrid accepts the probe building claim');
assert.equal(claimedHybrid.parks.some(park => !park.imported && polygonsOverlap(park.polygon, acceptedTreeClaim.footprint)), false,
  'hybrid procedural parks exclude imported building claims');
assert.equal(claimedHybrid.trees.some(tree => pointInPolygon(tree.x, tree.z, acceptedTreeClaim.footprint)), false,
  'hybrid procedural trees exclude imported building claims');

// Adding imported water around a tree that the same seed would otherwise
// place makes park/tree water checks non-vacuous without changing RNG input.
const waterBaselineConfig = { ...geoConfig, seed: 'water-0', source: 'hybrid', life: 'high' };
const waterBaseline = generateCity(waterBaselineConfig);
const waterParkCandidate = waterBaseline.parks.find(park => !park.imported);
assert.ok(waterParkCandidate, 'water probe has a procedural park candidate');
const waterTreeCandidate = waterBaseline.trees.find(tree =>
  pointInPolygon(tree.x, tree.z, waterParkCandidate.polygon));
assert.ok(waterTreeCandidate, 'water probe has a procedural tree candidate');
const probePond = closedRect(
  waterTreeCandidate.x - 1, waterTreeCandidate.z - 1,
  waterTreeCandidate.x + 1, waterTreeCandidate.z + 1,
);
assert.ok(polygonsOverlap(waterParkCandidate.polygon, probePond)
  && pointInPolygon(waterTreeCandidate.x, waterTreeCandidate.z, probePond),
  'imported-water probe covers a park and tree that would otherwise be placed');
const probePondRecord = geoPolygon(geoRecords.length, 'hybrid-water-probe', { natural: 'water' }, [[probePond]]);
const wateredHybrid = generateCity({
  ...waterBaselineConfig, geography: { records: [...geoRecords, probePondRecord] },
});
assert.ok(wateredHybrid.water.some(water => water.sourceId === 'hybrid-water-probe'),
  'hybrid accepts the probe water polygon');
assert.equal(
  wateredHybrid.parks.some(park => !park.imported && polygonsOverlap(park.polygon, waterParkCandidate.polygon)),
  false,
  'hybrid omits the water-overlapping procedural park candidate',
);
assert.equal(
  wateredHybrid.parks.some(park => !park.imported
    && wateredHybrid.water.some(water => polygonsOverlap(park.polygon, water.polygon))),
  false,
  'hybrid procedural parks exclude imported water',
);
assert.equal(wateredHybrid.trees.some(tree => pointInPolygon(tree.x, tree.z, probePond)), false,
  'hybrid omits trees from the water-overlapping park candidate');
assert.equal(wateredHybrid.trees.some(tree => !(wateredHybrid.fields.water.sdf(tree.x, tree.z) > .5)), false,
  'hybrid procedural trees stay on land');

// A tiny face keeps the RNG grammar bounded: rail consumes two draws, medieval
// fabric consumes CBD x/z plus one direction draw, and short roads consume one
// legacy life draw each. Two unsafe imported parks then reject 30 x/z probes
// apiece before the safe park's first tree, allowing direct stream replay.
const streamSeed = 'hybrid-stream-proof';
const streamRng = new RNG(streamSeed + ':hybrid');
const expectedRailVertical = streamRng.bool();
const expectedRailOffset = streamRng.float(-100, 100);
const railParkRing = expectedRailVertical
  ? closedRect(expectedRailOffset - 2, -2, expectedRailOffset + 2, 2)
  : closedRect(-2, expectedRailOffset - 2, 2, expectedRailOffset + 2);
const railBuildingRing = expectedRailVertical
  ? closedRect(expectedRailOffset - 1, -1, expectedRailOffset + 1, 1)
  : closedRect(-1, expectedRailOffset - 1, 1, expectedRailOffset + 1);
const tinyRoads = [
  geoLine(0, [[-5, -5], [5, -5]]), geoLine(1, [[5, -5], [5, 5]]),
  geoLine(2, [[5, 5], [-5, 5]]), geoLine(3, [[-5, 5], [-5, -5]]),
];
const safeParkRing = closedRect(-120, -120, -100, -100);
const streamRecords = [
  ...tinyRoads,
  geoPolygon(4, 'stream-water', { natural: 'water' }, [[closedRect(100, 100, 120, 120)]]),
  geoPolygon(5, 'rail-park', { kind: 'park' }, [[railParkRing]]),
  geoPolygon(6, 'water-park', { kind: 'park' }, [[closedRect(104, 104, 108, 108)]]),
  geoPolygon(7, 'safe-park', { kind: 'park' }, [[safeParkRing]]),
  geoPolygon(8, 'reserved-building', { building: 'yes' }, [[railBuildingRing]]),
];
const streamConfig = {
  ...geoConfig, seed: streamSeed, source: 'hybrid', pattern: 'medieval', rail: 'elevated', life: 'high',
  geography: { records: streamRecords },
};
const streamModel = generateCity(streamConfig);
assert.deepEqual([streamModel.rail.vertical, streamModel.rail.offset], [expectedRailVertical, expectedRailOffset],
  'hybrid rail uses seed + :hybrid');
const expectedCbd = [streamRng.float(-80, 80), streamRng.float(-80, 80)];
assert.deepEqual([streamModel.centers[0].x, streamModel.centers[0].z], expectedCbd,
  'hybrid fabric uses the rail-advanced seed + :hybrid stream');
streamRng.float(0, Math.PI);
const streamRoadPool = [...streamModel.roads, ...streamModel.bridges];
assert.equal(streamModel.blocks.length, 0, 'stream probe face is too small for procedural fabric draws');
assert.ok(streamRoadPool.length === 4 && streamRoadPool.every(road => road.len < 14),
  'stream probe bounds legacy life consumption to one draw per short road pick');
for (let i = 0; i < 120; i++) streamRng.pick(streamRoadPool);
for (let i = 0; i < 30 * 2 * 2; i++) streamRng.next();
const expectedFirstLifeTree = {
  x: streamRng.float(-120, -100), z: streamRng.float(-120, -100), s: streamRng.float(.65, 1.2),
};
assert.deepEqual(streamModel.trees[0], expectedFirstLifeTree,
  'hybrid life continues the seed + :hybrid stream after rejected unsafe tree probes');
const cityStream = new RNG(streamSeed + ':city');
assert.notDeepEqual([streamModel.rail.vertical, streamModel.rail.offset], [cityStream.bool(), cityStream.float(-100, 100)],
  'hybrid rail does not use seed + :city');
assert.equal(streamModel.trees.length, 5, 'only the safe imported park receives hybrid life trees');
for (const tree of streamModel.trees) {
  assert.ok(pointInPolygon(tree.x, tree.z, safeParkRing) && streamModel.fields.water.sdf(tree.x, tree.z) > .5);
  assert.equal(streamModel.reserved.some(rect =>
    tree.x >= rect.x && tree.x <= rect.x + rect.w && tree.z >= rect.z && tree.z <= rect.z + rect.d), false);
}
assert.deepEqual(
  streamModel.geography.diagnostics.filter(diagnostic => diagnostic.code === 'imported-building-reserved'),
  [{ index: 8, sourceId: 'reserved-building', sourcePart: 0, code: 'imported-building-reserved',
    message: 'imported building footprint intersects reserved infrastructure' }],
  'hybrid deterministically rejects an imported building reserved by rail');
assert.equal(JSON.stringify(generateCity(streamConfig)), JSON.stringify(streamModel),
  'hybrid reserved-building and tree-safety probe is deterministic');

// A same-seed hybrid control without rail places a procedural park on the
// corridor that elevated rail later reserves, making park/tree exclusion
// non-vacuous before asserting the constrained output.
const railSafetyConfig = { ...hybridConfig, seed: 'rail-2', life: 'high' };
const railControl = generateCity({ ...railSafetyConfig, rail: 'none' });
assert.ok(railControl.parks.some(park => !park.imported), 'rail control has a procedural park');
const railSafetyModel = generateCity({ ...railSafetyConfig, rail: 'elevated' });
assert.ok(railSafetyModel.parks.some(park => !park.imported),
  'hybrid rail fixture retains a procedural park');
assert.ok(railSafetyModel.reserved.length > 0, 'hybrid rail fixture reserves a corridor');
const reservedParkCandidate = railControl.parks.find(park =>
  !park.imported && railSafetyModel.reserved.some(rect => polyIntersectsRect(park.polygon, rect)));
assert.ok(reservedParkCandidate, 'rail control park candidate intersects the reservation');
const reservedTreeCandidates = railControl.trees.filter(tree =>
  pointInPolygon(tree.x, tree.z, reservedParkCandidate.polygon));
assert.ok(reservedTreeCandidates.length > 0, 'rail control has trees on the reserved park candidate');
assert.equal(
  railSafetyModel.parks.some(park => !park.imported
    && polygonsOverlap(park.polygon, reservedParkCandidate.polygon)),
  false,
  'hybrid omits the reserved-corridor procedural park candidate',
);
assert.equal(
  reservedTreeCandidates.some(tree =>
    railSafetyModel.trees.some(other => other.x === tree.x && other.z === tree.z)),
  false,
  'hybrid omits trees from the reserved-corridor park candidate',
);
assert.ok(railSafetyModel.blocks.some(block => railSafetyModel.reserved.some(rect => polyIntersectsRect(block.polygon, rect))),
  'hybrid rail probe crosses procedural source faces');
for (const park of railSafetyModel.parks.filter(entry => !entry.imported)) {
  assert.equal(railSafetyModel.reserved.some(rect => polyIntersectsRect(park.polygon, rect)), false,
    'hybrid procedural park excludes rail reservations');
}
for (const tree of railSafetyModel.trees) {
  assert.equal(railSafetyModel.reserved.some(rect =>
    tree.x >= rect.x && tree.x <= rect.x + rect.w && tree.z >= rect.z && tree.z <= rect.z + rect.d), false,
  'hybrid tree excludes rail reservations');
}

assert.ok(hybridModel.cars.length > 0, 'hybrid life places routed cars');
const hybridEdgeCount = hybridModel.graph.edges.length;
for (const [carIndex, car] of hybridModel.cars.entries()) {
  assert.ok(Array.isArray(car.path) && car.path.length > 1, `hybrid car ${carIndex} has no route`);
  for (const edgeId of car.path) {
    const edge = hybridModel.graph.edges[edgeId];
    assert.ok(Number.isInteger(edgeId) && edgeId >= 0 && edgeId < hybridEdgeCount && edge && !edge.removed,
      `hybrid car ${carIndex} uses a missing imported-graph edge`);
    assert.ok(Number.isInteger(edge.sourceIndex) && typeof edge.roadId === 'string',
      `hybrid car ${carIndex} leaves the imported graph`);
  }
}

assert.equal(JSON.stringify(generateCity(hybridConfig)), JSON.stringify(hybridModel),
  'hybrid generation serializes identically on repeat');

const hybridMapCalls = [];
const hybridMapCtx = new Proxy({
  beginPath() { hybridMapCalls.push(['begin']); }, moveTo(x, y) { hybridMapCalls.push(['move', x, y]); },
  lineTo(x, y) { hybridMapCalls.push(['line', x, y]); }, closePath() { hybridMapCalls.push(['close']); },
  fill(rule) { hybridMapCalls.push(['fill', rule ?? null]); },
  setLineDash() {}, save() {}, restore() {}, fillRect() {}, stroke() {}, arc() {}, translate() {}, rotate() {}, fillText() {},
}, { set(target, key, value) { target[key] = value; return true; } });
drawMap(hybridMapCtx, hybridModel, 200, 200, waterOnly);
assert.ok(hybridMapCalls.some(call => call[0] === 'fill' && call[1] === 'evenodd'),
  'hybrid imported water reaches the shared map adapter');

assert.throws(() => generateCity({ ...hybridConfig, geography: { records: [] } }), geoErr);
assert.throws(() => generateCity({ ...hybridConfig, geography: { records: [geoRecords.at(-1)] } }), geoErr);
assert.throws(() => generateCity({ ...hybridConfig, geography: { records: [geoLine(0, [[0, 0], [100, 0]])] } }), geoErr);
assert.throws(() => generateCity({ ...hybridConfig, geography: null }), TypeError);
assert.throws(() => generateCity({ ...hybridConfig, engine: 'bsp' }), /graph engine/);

assert.equal(JSON.stringify(generateCity(geoConfig)), geographicBeforeHybrid, 'geographic output changed after hybrid');
assert.equal(JSON.stringify(generateCity(proceduralGraphConfig)), proceduralGraphBeforeHybrid, 'procedural graph output changed after hybrid');
assert.equal(JSON.stringify(generateCity(bspCompatConfig)), bspBeforeHybrid, 'BSP output changed after hybrid');
assert.equal(JSON.stringify(generateCity(proceduralConfig)), JSON.stringify(proceduralAfter),
  'source-omitted procedural output changed after hybrid');

console.log(JSON.stringify({
  tests: 'geography',
  projectedEastAtEquatorM: equator.project([1, 0])[0],
  fixturePoints: projectedFixture.length,
  clippedPieces: reentry.length,
  geojsonRecords: normalized.records.length,
  geojsonDiagnostics: mixedResult.diagnostics.length,
}));
