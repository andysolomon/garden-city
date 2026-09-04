import { makeProjection, VIEWPORT_HALF, VIEWPORT_SIZE } from './geography.js';
import { normalizeGeoJSON } from './geojson.js';

// The provider boundary deliberately owns all I/O. The city model continues
// to receive the same normalized records it receives from offline fixtures.
export const MAPBOX_GEOCODING_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const DEFAULT_CROP_RADIUS = VIEWPORT_HALF;
export const MIN_CROP_RADIUS = 25;
export const MAX_CROP_RADIUS = VIEWPORT_HALF;
export const MAPBOX_ATTRIBUTION = '© Mapbox';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors · Overpass API';

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const COORDINATE_TEXT = new RegExp(`^\\s*(${NUMBER})\\s*(?:,|;)\\s*(${NUMBER})\\s*$`);
const DISABLED_TAGS = new Set(['', '0', 'false', 'no', 'off']);
const WATER_TAGS = new Set(['water', 'wetland']);
const WATER_LANDUSES = new Set(['reservoir', 'basin', 'salt_pond']);
const PARK_LANDUSES = new Set([
  'allotments', 'cemetery', 'churchyard', 'forest', 'garden', 'grass', 'meadow',
  'orchard', 'park', 'recreation_ground', 'village_green', 'wood',
]);
const PARK_LEISURES = new Set(['garden', 'golf_course', 'park', 'pitch', 'recreation_ground']);

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function activeTag(value) {
  if (value === undefined || value === null) return false;
  return !DISABLED_TAGS.has(String(value).trim().toLowerCase());
}

function coordinatePair(value, label = 'location') {
  let lon, lat;
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new ProviderError('invalid-location', `${label} must contain [longitude, latitude].`);
    [lon, lat] = value;
  } else if (plain(value)) {
    ({ lon, lat } = value);
  } else {
    throw new ProviderError('invalid-location', `${label} must be a place name or [longitude, latitude].`);
  }
  lon = numeric(lon); lat = numeric(lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new ProviderError('invalid-location', `${label} coordinates must be finite numbers.`);
  }
  if (lon < -180 || lon > 180) throw new ProviderError('invalid-location', 'Longitude must be between -180 and 180 degrees.');
  if (lat < -90 || lat > 90) throw new ProviderError('invalid-location', 'Latitude must be between -90 and 90 degrees.');
  return { lon, lat };
}

/** Parse the explicit `longitude, latitude` form, or return null for a place name. */
export function parseCoordinateLocation(value) {
  if (Array.isArray(value) || plain(value)) return coordinatePair(value);
  if (typeof value !== 'string') {
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new ProviderError('invalid-location', 'Enter a place name or longitude, latitude coordinates.');
    }
    return null;
  }
  const text = value.trim();
  if (!text) throw new ProviderError('invalid-location', 'Enter a place name or longitude, latitude coordinates.');
  const match = text.match(COORDINATE_TEXT);
  if (!match) return null;
  return coordinatePair([match[1], match[2]]);
}

export function validateCropRadius(value = DEFAULT_CROP_RADIUS) {
  const radius = numeric(value);
  if (!Number.isFinite(radius) || radius < MIN_CROP_RADIUS || radius > MAX_CROP_RADIUS) {
    throw new ProviderError(
      'invalid-radius',
      `Crop radius must be between ${MIN_CROP_RADIUS} and ${MAX_CROP_RADIUS} metres.`,
    );
  }
  return radius;
}

export class ProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.service !== undefined) this.service = options.service;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function errorFromResponse(response, service) {
  const status = Number(response?.status) || 0;
  if (status === 401 || status === 403) {
    return new ProviderError(
      'missing-token',
      'The map provider rejected the credentials. Enter a valid runtime Mapbox public token.',
      { status, service },
    );
  }
  if (status === 429) {
    return new ProviderError(
      'rate-limit',
      'The map provider is rate-limiting requests. Wait a moment and try again.',
      { status, service },
    );
  }
  return new ProviderError(
    'http',
    `The ${service} request failed${status ? ` (HTTP ${status})` : ''}. Try again or choose another location.`,
    { status, service },
  );
}

/** Fetch JSON with stable, user-facing error categories and an injectable fetch seam. */
export async function requestProviderJson(fetchImpl, url, init, service) {
  if (typeof fetchImpl !== 'function') {
    throw new ProviderError('network', 'This browser does not provide a fetch API.', { service });
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ProviderError('aborted', 'The location request was cancelled.', { service, cause: error });
    }
    throw new ProviderError(
      'network',
      `Unable to reach the ${service} provider. Check the network connection and try again.`,
      { service, cause: error },
    );
  }

  const ok = response?.ok ?? (Number(response?.status) >= 200 && Number(response?.status) < 300);
  if (!ok) throw errorFromResponse(response, service);
  if (typeof response.json !== 'function') {
    throw new ProviderError('invalid-response', `The ${service} provider returned no JSON data.`, { service });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError('invalid-response', `The ${service} provider returned invalid JSON data.`, { service, cause: error });
  }
}

function geocodingUrl(endpoint, query, token) {
  const encoded = encodeURIComponent(query);
  const raw = endpoint.includes('{query}')
    ? endpoint.replace('{query}', encoded)
    : `${endpoint.replace(/\/+$/, '')}/${encoded}.json`;
  const url = new URL(raw);
  url.searchParams.set('limit', '1');
  url.searchParams.set('access_token', token);
  return url.toString();
}

/** Build the Overpass query used by the default compatible OSM data source. */
export function buildOverpassQuery(location, radius = DEFAULT_CROP_RADIUS) {
  const { lon, lat } = coordinatePair(location);
  const cropRadius = validateCropRadius(radius);
  const around = `(around:${cropRadius},${lat},${lon})`;
  return `[out:json][timeout:25];\n(\n` +
    `  way${around}["highway"];\n` +
    `  way${around}["building"];\n` +
    `  way${around}["natural"~"^(water|wetland|wood)$"];\n` +
    `  way${around}["waterway"="riverbank"];\n` +
    `  way${around}["water"="yes"];\n` +
    `  way${around}["landuse"~"^(allotments|basin|cemetery|churchyard|forest|garden|grass|meadow|orchard|park|recreation_ground|reservoir|village_green|wood)$"];\n` +
    `  way${around}["leisure"~"^(garden|golf_course|park|pitch|recreation_ground)$"];\n` +
    `);\n` +
    'out tags geom;';
}

function samePosition(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function osmCoordinates(element) {
  if (!Array.isArray(element.geometry)) return null;
  const coordinates = element.geometry.map(point => [numeric(point?.lon), numeric(point?.lat)]);
  if (coordinates.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return null;
  return coordinates;
}

function osmFeature(id, properties, type, coordinates) {
  return {
    type: 'Feature',
    id,
    properties: { ...properties },
    geometry: { type, coordinates },
  };
}

function waterWay(tags) {
  const natural = typeof tags.natural === 'string' ? tags.natural.toLowerCase() : '';
  const landuse = typeof tags.landuse === 'string' ? tags.landuse.toLowerCase() : '';
  return WATER_TAGS.has(natural) || tags.waterway === 'riverbank' || activeTag(tags.water) || WATER_LANDUSES.has(landuse);
}

function parkWay(tags) {
  const landuse = typeof tags.landuse === 'string' ? tags.landuse.toLowerCase() : '';
  const leisure = typeof tags.leisure === 'string' ? tags.leisure.toLowerCase() : '';
  return PARK_LANDUSES.has(landuse) || PARK_LEISURES.has(leisure);
}

function closedRing(coordinates) {
  if (coordinates.length < 3) return null;
  const ring = coordinates.slice();
  if (!samePosition(ring[0], ring[ring.length - 1])) ring.push(ring[0].slice());
  return ring.length >= 4 ? ring : null;
}

/** Convert Overpass JSON (or an already GeoJSON-compatible response) to GeoJSON. */
export function osmToGeoJSON(payload) {
  if (payload?.type === 'Feature' || payload?.type === 'FeatureCollection') return payload;
  if (!plain(payload) || !Array.isArray(payload.elements)) {
    throw new ProviderError('invalid-response', 'The map provider returned no usable feature collection.', { service: 'map data' });
  }

  const features = [];
  for (const element of payload.elements) {
    if (!plain(element) || element.type !== 'way') continue;
    const tags = plain(element.tags) ? element.tags : {};
    const coordinates = osmCoordinates(element);
    if (!coordinates || coordinates.length < 2) continue;
    const id = element.id ?? null;
    if (activeTag(tags.highway)) features.push(osmFeature(id, tags, 'LineString', coordinates));

    const ring = closedRing(coordinates);
    if (!ring) continue;
    if (activeTag(tags.building)) {
      features.push(osmFeature(id, { ...tags, kind: 'building' }, 'Polygon', [ring]));
    } else if (waterWay(tags)) {
      features.push(osmFeature(id, tags, 'Polygon', [ring]));
    } else if (parkWay(tags)) {
      features.push(osmFeature(id, tags, 'Polygon', [ring]));
    }
  }
  return { type: 'FeatureCollection', features };
}

function resolvedGeocoderLocation(payload, query) {
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  const coordinates = feature?.center || feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new ProviderError('location-not-found', `No map location was found for “${query}”.`);
  }
  const { lon, lat } = coordinatePair(coordinates, 'provider location');
  return {
    lon,
    lat,
    label: typeof feature.place_name === 'string' && feature.place_name.trim()
      ? feature.place_name
      : query,
    bbox: Array.isArray(feature.bbox) ? feature.bbox.slice() : undefined,
    geocoded: true,
  };
}

function defaultFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
}

/** Create a Mapbox-geocoding + Overpass-compatible provider client. */
export function createMapProvider(options = {}) {
  if (!plain(options)) throw new TypeError('provider options must be an object');
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const geocoderEndpoint = options.geocoderEndpoint || MAPBOX_GEOCODING_URL;
  const dataEndpoint = options.dataEndpoint || OVERPASS_URL;

  async function resolveLocation(location, { token = '', signal } = {}) {
    const coordinates = parseCoordinateLocation(location);
    if (coordinates) return { ...coordinates, label: `${coordinates.lon}, ${coordinates.lat}`, geocoded: false };
    const query = typeof location === 'string' ? location.trim() : '';
    if (!query) throw new ProviderError('invalid-location', 'Enter a place name or longitude, latitude coordinates.');
    if (typeof token !== 'string' || !token.trim()) {
      throw new ProviderError('missing-token', 'Enter a Mapbox public token to search for a place, or enter coordinates.');
    }
    const payload = await requestProviderJson(
      fetchImpl,
      geocodingUrl(geocoderEndpoint, query, token.trim()),
      { method: 'GET', signal, headers: { Accept: 'application/json' } },
      'geocoding',
    );
    return resolvedGeocoderLocation(payload, query);
  }

  async function load({ location, radius = DEFAULT_CROP_RADIUS, token = '', signal } = {}) {
    const cropRadius = validateCropRadius(radius);
    const resolved = await resolveLocation(location, { token, signal });
    const query = buildOverpassQuery(resolved, cropRadius);
    const dataHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Browsers supply an ordinary user agent automatically; the explicit
    // header is only needed for non-browser fetch implementations such as
    // Node's undici, which some Overpass mirrors reject with HTTP 406.
    if (typeof window === 'undefined') dataHeaders['User-Agent'] = 'garden-city/0.2 (+https://github.com/andysolomon/garden-city)';
    const payload = await requestProviderJson(
      fetchImpl,
      dataEndpoint,
      {
        method: 'POST', signal, headers: dataHeaders,
        body: `data=${encodeURIComponent(query)}`,
      },
      'map data',
    );
    let normalized;
    try {
      const geojson = osmToGeoJSON(payload);
      const projection = makeProjection([resolved.lon, resolved.lat], { viewportSize: VIEWPORT_SIZE });
      normalized = normalizeGeoJSON(geojson, projection);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('invalid-response', 'The map provider returned unusable geographic data.', { service: 'map data', cause: error });
    }
    if (!normalized.records.some(record => record.geometry?.type === 'line')) {
      throw new ProviderError('no-road-data', 'No roads were found in that crop. Try a larger radius or another location.', { service: 'map data' });
    }
    return {
      records: normalized.records,
      diagnostics: normalized.diagnostics,
      location: resolved,
      radius: cropRadius,
      attribution: resolved.geocoded ? `${OSM_ATTRIBUTION} · ${MAPBOX_ATTRIBUTION}` : OSM_ATTRIBUTION,
    };
  }

  return Object.freeze({ resolveLocation, load });
}

export async function loadProviderGeography(options = {}) {
  const { provider, fetchImpl, geocoderEndpoint, dataEndpoint, ...request } = options;
  const client = provider || createMapProvider({ fetchImpl, geocoderEndpoint, dataEndpoint });
  return client.load(request);
}

export function providerErrorMessage(error) {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'The location could not be loaded. Try again.';
}

export default createMapProvider;
