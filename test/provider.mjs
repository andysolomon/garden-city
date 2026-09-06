import assert from 'node:assert/strict';
import {
  createMapProvider,
  buildOverpassQuery,
  loadProviderGeography,
  osmToGeoJSON,
  parseCoordinateLocation,
  ProviderError,
  validateCropRadius,
} from '../src/provider.js';

const jsonResponse = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const road = (id, highway, geometry) => ({ type: 'way', id, tags: { highway }, geometry });
const square = (id, tags, lon, lat, size = .001) => ({
  type: 'way', id, tags,
  geometry: [
    { lon, lat }, { lon: lon + size, lat },
    { lon: lon + size, lat: lat + size }, { lon, lat: lat + size }, { lon, lat },
  ],
});

const payload = {
  version: 0.6,
  elements: [
    road(1, 'primary', [{ lon: -73.99, lat: 40.74 }, { lon: -73.98, lat: 40.74 }]),
    road(2, 'residential', [{ lon: -73.99, lat: 40.74 }, { lon: -73.99, lat: 40.75 }]),
    square(3, { building: 'yes', height: '18' }, -73.987, 40.744),
    square(4, { natural: 'water' }, -73.986, 40.746),
    square(5, { leisure: 'park' }, -73.985, 40.747),
    { type: 'node', id: 6, lat: 40.74, lon: -73.99 },
  ],
};

// The local adapter supports both explicit coordinates and the documented
// longitude, latitude text form.
assert.deepEqual(parseCoordinateLocation('-73.9857,40.7484'), { lon: -73.9857, lat: 40.7484 });
assert.deepEqual(parseCoordinateLocation([-73.9857, 40.7484]), { lon: -73.9857, lat: 40.7484 });
assert.equal(parseCoordinateLocation('Central Park'), null);
assert.throws(() => parseCoordinateLocation('181, 0'), error => error.code === 'invalid-location');
assert.equal(validateCropRadius('450'), 450);
assert.throws(() => validateCropRadius(0), error => error.code === 'invalid-radius');

const query = buildOverpassQuery({ lon: -73.9857, lat: 40.7484 }, 250);
assert.match(query, /way\(around:250,40\.7484,-73\.9857\)\["highway"\]/);
assert.match(query, /out tags geom;/);

const normalized = osmToGeoJSON(payload);
assert.equal(normalized.type, 'FeatureCollection');
assert.equal(normalized.features.filter(feature => feature.geometry.type === 'LineString').length, 2);
assert.equal(normalized.features.filter(feature => feature.geometry.type === 'Polygon').length, 3);
assert.equal(normalized.features.find(feature => feature.id === 3).properties.kind, 'building');
assert.equal(normalized.features.find(feature => feature.id === 4).properties.natural, 'water');

// Direct-coordinate loading needs only the compatible OSM data source; no
// credentials are retained in the returned data.
const calls = [];
const provider = createMapProvider({
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload);
  },
});
const direct = await provider.load({ location: '-73.9857, 40.7484', radius: 450 });
assert.ok(direct.records.some(record => record.geometry.type === 'line'));
assert.ok(direct.records.some(record => record.geometry.type === 'polygon'));
assert.equal(direct.location.geocoded, false);
assert.equal(direct.attribution, '© OpenStreetMap contributors · Overpass API');
assert.equal(calls.length, 1);
assert.equal(calls[0].init.method, 'POST');
assert.match(decodeURIComponent(calls[0].init.body), /around:450,40\.7484,-73\.9857/);
assert.equal('token' in direct, false);

// Place-name lookup uses Mapbox only for geocoding, then loads the same
// provider-neutral geographic data shape.
const geocoderCalls = [];
const geocodedProvider = createMapProvider({
  geocoderEndpoint: 'https://geocode.example.test/places',
  fetchImpl: async (url, init) => {
    geocoderCalls.push({ url: String(url), init });
    return geocoderCalls.length === 1
      ? jsonResponse({ features: [{ place_name: 'Example Place', center: [-73.9857, 40.7484] }] })
      : jsonResponse(payload);
  },
});
const geocoded = await geocodedProvider.load({ location: 'Example Place', radius: 300, token: 'runtime-token' });
assert.equal(geocoded.location.label, 'Example Place');
assert.equal(geocoded.location.geocoded, true);
assert.match(geocoderCalls[0].url, /access_token=runtime-token/);
assert.match(decodeURIComponent(geocoderCalls[1].init.body), /around:300,40\.7484,-73\.9857/);
assert.match(geocoded.attribution, /Mapbox/);

await assert.rejects(
  () => geocodedProvider.load({ location: 'Example Place', radius: 300 }),
  error => error instanceof ProviderError && error.code === 'missing-token',
);

for (const [status, code] of [[401, 'missing-token'], [429, 'rate-limit'], [500, 'http']]) {
  const failing = createMapProvider({ fetchImpl: async () => jsonResponse({}, status) });
  await assert.rejects(
    () => failing.load({ location: '0, 0', radius: 450 }),
    error => error instanceof ProviderError && error.code === code,
  );
}

const networkFailure = createMapProvider({ fetchImpl: async () => { throw new TypeError('offline'); } });
await assert.rejects(
  () => networkFailure.load({ location: '0, 0', radius: 450 }),
  error => error instanceof ProviderError && error.code === 'network',
);

const emptyProvider = createMapProvider({ fetchImpl: async () => jsonResponse({ elements: [] }) });
await assert.rejects(
  () => emptyProvider.load({ location: '0, 0', radius: 450 }),
  error => error instanceof ProviderError && error.code === 'no-road-data',
);

const geojson = await loadProviderGeography({
  fetchImpl: async () => jsonResponse({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'road', properties: { highway: 'residential' }, geometry: {
      type: 'LineString', coordinates: [[-1, 0], [1, 0]],
    } }],
  }),
  location: '0, 0',
  radius: 450,
});
assert.equal(geojson.records[0].sourceId, 'road');

console.log(JSON.stringify({
  tests: 'provider',
  records: direct.records.length,
  diagnostics: direct.diagnostics.length,
  calls: calls.length + geocoderCalls.length,
}));
