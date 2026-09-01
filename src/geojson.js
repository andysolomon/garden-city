// Provider-neutral GeoJSON boundary adapter. This module converts fixture
// features into deterministic local [x, z] records using an existing
// projection from src/geography.js. It performs no network or filesystem
// access, no clipping, and no semantic classification: a record is one source
// feature expressed in local coordinates, nothing more.

/** Geometry types this slice normalizes, in contract order. */
export const SUPPORTED_GEOMETRY_TYPES = Object.freeze([
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

/** Stable diagnostic codes emitted for skipped features. */
export const DIAGNOSTIC_CODES = Object.freeze({
  INVALID_FEATURE: 'invalid-feature',
  MISSING_GEOMETRY: 'missing-geometry',
  UNSUPPORTED_GEOMETRY: 'unsupported-geometry',
  EMPTY_GEOMETRY: 'empty-geometry',
  INVALID_COORDINATE: 'invalid-coordinate',
});

// Coordinate nesting depth below `geometry.coordinates` for each supported
// type: 1 is a list of positions, 2 a list of those, and so on.
const COORDINATE_DEPTH = {
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

class FeatureSkipped extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeatureSkipped';
    this.code = code;
  }
}

function skip(code, message) {
  return new FeatureSkipped(code, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function featuresOf(input) {
  if (!plainObject(input)) {
    throw new TypeError('input must be a GeoJSON Feature or FeatureCollection object');
  }
  if (input.type === 'FeatureCollection') {
    if (!Array.isArray(input.features)) {
      throw new TypeError('FeatureCollection features must be an array');
    }
    return input.features;
  }
  if (input.type === 'Feature') return [input];
  throw new TypeError('input type must be "Feature" or "FeatureCollection"');
}

function projectorOf(projection) {
  if (!plainObject(projection) || typeof projection.project !== 'function') {
    throw new TypeError('projection must expose a project(coordinate) method');
  }
  return coordinate => projection.project(coordinate);
}

const UNFORMATTABLE_PROJECTION_THROW = '[unformattable throw value]';
const UNFORMATTABLE_VALUE = '[unformattable value]';

function projectionFailureMessage(thrown) {
  try {
    if (thrown === null) return 'null';
    if (thrown === undefined) return 'undefined';

    const type = typeof thrown;
    if (type === 'string') return thrown;
    if (type === 'number' || type === 'boolean') return String(thrown);
    if (type === 'bigint') {
      try {
        return String(thrown);
      } catch {
        return UNFORMATTABLE_PROJECTION_THROW;
      }
    }
    if (type === 'symbol') {
      try {
        return thrown.toString();
      } catch {
        return UNFORMATTABLE_PROJECTION_THROW;
      }
    }
    if (type === 'object' || type === 'function') {
      try {
        const message = thrown.message;
        if (typeof message === 'string') return message;
      } catch {
        // Hostile Error.message accessors must not escape normalization.
      }
    }
    return UNFORMATTABLE_PROJECTION_THROW;
  } catch {
    return UNFORMATTABLE_PROJECTION_THROW;
  }
}

function formatDiagnosticValue(value) {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const type = typeof value;
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'bigint') {
      try {
        return `${value}n`;
      } catch {
        return UNFORMATTABLE_VALUE;
      }
    }
    if (type === 'symbol') {
      try {
        return String(value);
      } catch {
        return UNFORMATTABLE_VALUE;
      }
    }
    if (type === 'object' || type === 'function') {
      try {
        return JSON.stringify(value);
      } catch {
        return UNFORMATTABLE_VALUE;
      }
    }
    return UNFORMATTABLE_VALUE;
  } catch {
    return UNFORMATTABLE_VALUE;
  }
}

// Ring closure compares longitude and latitude only; elevation is ignored.
function positionsEqualLonLat(first, last) {
  return first[0] === last[0] && first[1] === last[1];
}

function validateLineStringCoordinates(coordinates, label) {
  if (!Array.isArray(coordinates)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (coordinates.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  if (coordinates.length < 2) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must contain at least two positions`);
  }
}

function validateMultiLineStringCoordinates(coordinates, label) {
  if (!Array.isArray(coordinates)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (coordinates.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  coordinates.forEach((part, index) => {
    validateLineStringCoordinates(part, `${label}[${index}]`);
  });
}

function validateRing(ring, label) {
  if (!Array.isArray(ring)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (ring.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  if (ring.length < 4) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must contain at least four positions`);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!Array.isArray(first) || first.length < 2 || !Array.isArray(last) || last.length < 2) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must contain [longitude, latitude] positions`);
  }
  if (!positionsEqualLonLat(first, last)) {
    throw skip(
      DIAGNOSTIC_CODES.INVALID_COORDINATE,
      `${label} must be closed with matching first and last longitude and latitude`,
    );
  }
}

function validatePolygonCoordinates(coordinates, label) {
  if (!Array.isArray(coordinates)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (coordinates.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  coordinates.forEach((ring, index) => validateRing(ring, `${label}[${index}]`));
}

function validateMultiPolygonCoordinates(coordinates, label) {
  if (!Array.isArray(coordinates)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (coordinates.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  coordinates.forEach((polygon, index) => validatePolygonCoordinates(polygon, `${label}[${index}]`));
}

function validateGeometryStructure(geometry) {
  const { type, coordinates } = geometry;
  if (type === 'LineString') {
    validateLineStringCoordinates(coordinates, 'coordinates');
    return;
  }
  if (type === 'MultiLineString') {
    validateMultiLineStringCoordinates(coordinates, 'coordinates');
    return;
  }
  if (type === 'Polygon') {
    validatePolygonCoordinates(coordinates, 'coordinates');
    return;
  }
  validateMultiPolygonCoordinates(coordinates, 'coordinates');
}

// GeoJSON positions carry an optional third elevation element (RFC 7946); the
// local model is planar, so elevation is read past and dropped.
function projectPosition(position, project, label) {
  if (!Array.isArray(position) || position.length < 2) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be a [longitude, latitude] position`);
  }
  const [lon, lat] = position;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (!finite(lon) || !finite(lat)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must contain finite longitude and latitude numbers`);
  }

  let projected;
  try {
    projected = project([lon, lat]);
  } catch (thrown) {
    throw skip(
      DIAGNOSTIC_CODES.INVALID_COORDINATE,
      `${label} could not be projected: ${projectionFailureMessage(thrown)}`,
    );
  }
  if (!Array.isArray(projected) || projected.length < 2 || !finite(projected[0]) || !finite(projected[1])) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} did not project to a finite [x, z] point`);
  }
  return [projected[0], projected[1]];
}

function projectNested(value, depth, project, label) {
  if (!Array.isArray(value)) {
    throw skip(DIAGNOSTIC_CODES.INVALID_COORDINATE, `${label} must be an array`);
  }
  if (value.length === 0) {
    throw skip(DIAGNOSTIC_CODES.EMPTY_GEOMETRY, `${label} must not be empty`);
  }
  if (depth === 1) {
    return value.map((position, index) => projectPosition(position, project, `${label}[${index}]`));
  }
  return value.map((child, index) => projectNested(child, depth - 1, project, `${label}[${index}]`));
}

function sourceIdOf(feature) {
  if (!plainObject(feature)) return null;
  const { id } = feature;
  // `0` and `''` are valid GeoJSON identifiers and must survive normalization.
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function propertiesOf(feature) {
  return plainObject(feature.properties) ? { ...feature.properties } : {};
}

function geometryOf(feature, project) {
  const { geometry } = feature;
  if (!plainObject(geometry)) {
    throw skip(DIAGNOSTIC_CODES.MISSING_GEOMETRY, 'feature geometry must be a GeoJSON geometry object');
  }
  const { type } = geometry;
  if (!SUPPORTED_GEOMETRY_TYPES.includes(type)) {
    throw skip(
      DIAGNOSTIC_CODES.UNSUPPORTED_GEOMETRY,
      `geometry type ${formatDiagnosticValue(type)} is not one of ${SUPPORTED_GEOMETRY_TYPES.join(', ')}`,
    );
  }

  validateGeometryStructure(geometry);
  const nested = projectNested(geometry.coordinates, COORDINATE_DEPTH[type], project, 'coordinates');
  if (type === 'LineString') return { type: 'line', parts: [nested] };
  if (type === 'MultiLineString') return { type: 'line', parts: nested };
  if (type === 'Polygon') return { type: 'polygon', polygons: [nested] };
  return { type: 'polygon', polygons: nested };
}

/**
 * Normalize a GeoJSON Feature or FeatureCollection into deterministic local
 * records. Returns `{ records, diagnostics }` where every valid supported
 * feature yields exactly one record, in source order, and every skipped
 * feature yields exactly one diagnostic, also in source order.
 *
 * Line geometry is `{ type: 'line', parts }` and polygon geometry is
 * `{ type: 'polygon', polygons }`, where each polygon is its outer ring
 * followed by its hole rings. Coordinates are projected local `[x, z]` pairs.
 * Only invalid API-level arguments throw; per-feature problems are reported as
 * diagnostics so valid siblings still normalize.
 */
export function normalizeGeoJSON(input, projection) {
  const features = featuresOf(input);
  const project = projectorOf(projection);
  const records = [];
  const diagnostics = [];

  features.forEach((feature, index) => {
    const sourceId = sourceIdOf(feature);
    try {
      if (!plainObject(feature) || feature.type !== 'Feature') {
        throw skip(DIAGNOSTIC_CODES.INVALID_FEATURE, 'entry must be a GeoJSON Feature object');
      }
      records.push({
        index,
        sourceId,
        properties: propertiesOf(feature),
        geometry: geometryOf(feature, project),
      });
    } catch (error) {
      if (!(error instanceof FeatureSkipped)) throw error;
      const geometryType = plainObject(feature) && plainObject(feature.geometry)
        && typeof feature.geometry.type === 'string'
        ? feature.geometry.type
        : null;
      diagnostics.push({ index, sourceId, geometryType, code: error.code, message: error.message });
    }
  });

  return { records, diagnostics };
}

export default normalizeGeoJSON;
