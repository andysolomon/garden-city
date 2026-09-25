import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EARTH_RADIUS_M,
  VIEWPORT_HALF,
  makeProjection,
  createProjection,
  isInViewport,
  cropPoint,
  cropPoints,
  clipSegment,
} from '../src/geography.js';
import { normalizeGeoJSON } from '../src/geojson.js';
import { makeImportedWater, makeWater } from '../src/fields.js';
import { generateCity } from '../src/model.js';
import { drawMap, LAYERS } from '../src/map.js';
import { positionOnRoute, routeCarPlacement } from '../src/routing.js';
import { RNG, hashSeed } from '../src/rng.js';
import { area, bbox, isSimple, orientedRect, pointInPolygon, polyIntersectsRect, segIntersect } from '../src/geom.js';

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

const equator = createProjection({ lon: 0, lat: 0 });

const latitude60 = makeProjection([0, 60]);
close(latitude60.project([1, 60])[0], metresPerDegree * Math.cos(60 * DEG_TO_RAD));
close(latitude60.project([0, 61])[1], -metresPerDegree);

const scaled = makeProjection([0, 0], { metresPerUnit: 2, viewportSize: 100 });
closePoint(scaled.project([1, 0]), [metresPerDegree / 2, 0]);
assert.equal(scaled.cropPoint([51, 0]), null);

const antimeridian = makeProjection([179.9, 0]);
const acrossDateLine = antimeridian.project([-179.9, 0]);
closePoint(acrossDateLine, [metresPerDegree * 0.2, 0]);
closePoint(antimeridian.inverse(acrossDateLine), [-179.9, 0]);

const fixture = [
  [-0.001, 0.001],
  [0.002, 0.0015],
  [0.002, -0.002],
  [-0.001, -0.0015],
];
const projectedFixture = equator.projectSequence(fixture);
assert.deepEqual(equator.inverseSequence(projectedFixture).map(([lon, lat]) => [Number(lon.toFixed(12)), Number(lat.toFixed(12))]), fixture);

for (const edge of [
  [-VIEWPORT_HALF, -VIEWPORT_HALF], [VIEWPORT_HALF, -VIEWPORT_HALF],
  [VIEWPORT_HALF, VIEWPORT_HALF], [-VIEWPORT_HALF, VIEWPORT_HALF],
]) {
  assert.ok(isInViewport(edge));
  assert.deepEqual(cropPoint(edge), edge);
}
assert.deepEqual(cropPoints([[-1, 0], [451, 0], [0, 450]]), [[-1, 0], [0, 450]]);

assert.deepEqual(clipSegment([-900, 0], [900, 0]), [[-450, 0], [450, 0]]);
assert.deepEqual(clipSegment([0, -1e6], [0, 1e6]), [[0, -450], [0, 450]]);

// Subnormal interpolation must retain the source line's signed minimum value;
// evaluating a power below Number.MIN_VALUE before applying the mantissa would
// incorrectly turn this boundary intersection into zero.
const subnormalSegment = [[-Number.MAX_VALUE, -Number.MIN_VALUE], [-Number.EPSILON / 2, Number.MIN_VALUE]];
const subnormalExpected = [[-VIEWPORT_HALF, Number.MIN_VALUE], [-Number.EPSILON / 2, Number.MIN_VALUE]];
assert.deepEqual(clipSegment(...subnormalSegment), subnormalExpected);

assert.throws(() => makeProjection({ lon: 0, lat: 90 }), RangeError);

// --- GeoJSON normalization -------------------------------------------------

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
assert.deepEqual(
  normalizeGeoJSON({ ...polygonFeature, properties: null }, equator).records[0].properties,
  {},
  'missing properties normalize to an empty object',
);

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
assert.deepEqual(normalizeGeoJSON({ type: 'FeatureCollection', features: [] }, equator), { records: [], diagnostics: [] });

// Only API-level arguments throw.
assert.throws(() => normalizeGeoJSON({ type: 'FeatureCollection' }, equator), TypeError);
assert.throws(() => normalizeGeoJSON({ type: 'LineString', coordinates: [] }, equator), TypeError);
assert.throws(() => normalizeGeoJSON(supported, {}), TypeError);

// Structural geometry validation: too few positions and unclosed rings.
// Valid siblings still normalize.
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

// --- Imported water boundary -----------------------------------------------

const closedRect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const polygonWaterRecord = polygons => ({
  index: 0, sourceId: null, properties: {}, geometry: { type: 'polygon', polygons },
});

const lakeRecords = [
  { index: 0, geometry: { type: 'line', parts: [[[0, 0], [1, 1]]] } },
  polygonWaterRecord([[closedRect(-20, -10, 20, 10)]]),
];
const lake = makeImportedWater(lakeRecords, 100);
assert.deepEqual(lake.polygons, [[closedRect(-20, -10, 20, 10)]]);
assert.notEqual(lake.polygons[0][0], lakeRecords[1].geometry.polygons[0][0]);
assert.deepEqual(lake.shores, [{ pts: [[-20, -10], [20, -10], [20, 10], [-20, 10]], closed: true }]);

const holeRing = closedRect(-5, -5, 5, 5);
const holed = makeWater({ kind: 'imported', records: [
  polygonWaterRecord([[closedRect(-20, -20, 20, 20), holeRing]]),
] }, 100);
assert.equal(holed.isLand(0, 0), true, 'a polygon hole must remain land');
assert.equal(holed.sdf(0, 0), 5);

const overlapping = makeImportedWater([
  polygonWaterRecord([
    [closedRect(-20, -10, 5, 10)],
    [closedRect(0, -10, 20, 10)],
  ]),
], 100);
assert.equal(overlapping.sdf(5, 0), -10, 'a hidden overlap edge is not union shoreline');

const crossing = makeImportedWater([
  polygonWaterRecord([[closedRect(-80, -20, 80, 20)]]),
], 100);
assert.deepEqual(crossing.shores, [
  { pts: [[-50, -20], [50, -20]], closed: false },
  { pts: [[50, 20], [-50, 20]], closed: false },
]);
assert.throws(() => makeImportedWater([polygonWaterRecord([[[[0, 0], [1, 0], [NaN, 1], [0, 0]]]])], 100), TypeError);
assert.throws(
  () => makeImportedWater([polygonWaterRecord([[[ [0, 0], [10, 0], [20, 0], [0, 0] ]]])], 100),
  /non-zero area/,
);

// Existing procedural samples retain their contract when the imported branch
// is unused.
assert.ok(makeWater({ kind: 'coast', edge: 0 }, 100).sdf(-10, 0) < 0);

// Closed imported lakes are disconnected graph components until a road reaches
// them. A 30-point ring previously disappeared during face extraction, leaving
// a land-centred block around water; a 500-point ring could instead become the
// largest component and discard every procedural road. Keep graph-only shores
// bounded.
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
  assert.equal(first.shores.length, 1, `${vertexCount}-point in-viewport circle must be one shore`);
  assert.ok(first.shores[0].pts.length >= 3 && first.shores[0].pts.length <= 24,
    `${vertexCount}-point circle must respect the graph-only point bound`);
}

assertClosedCircleShore(30);
assertClosedCircleShore(500);

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

console.log('geography: all tests passed');
