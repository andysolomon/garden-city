import { CITY_SIZE } from './common.js';

// WGS84's semi-major radius. This adapter intentionally uses a local
// equirectangular approximation rather than introducing a datum or provider
// dependency into the procedural city model.
export const EARTH_RADIUS_M = 6378137;
export const VIEWPORT_SIZE = CITY_SIZE;
export const VIEWPORT_HALF = VIEWPORT_SIZE / 2;

const DEG_TO_RAD = Math.PI / 180;
const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const ORIGIN_POLE_EPSILON = Number.EPSILON * 4;

const DEFAULT_BOUNDS = Object.freeze({
  minX: -VIEWPORT_HALF,
  maxX: VIEWPORT_HALF,
  minZ: -VIEWPORT_HALF,
  maxZ: VIEWPORT_HALF,
});

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function longitude(value, label = 'longitude') {
  value = finite(value, label);
  if (value < -180 || value > 180) throw new RangeError(`${label} must be between -180 and 180 degrees`);
  return value;
}

function latitude(value, label = 'latitude') {
  value = finite(value, label);
  if (value < MIN_LATITUDE || value > MAX_LATITUDE) {
    throw new RangeError(`${label} must be between -90 and 90 degrees`);
  }
  return value;
}

function geographicCoordinate(value, label = 'coordinate') {
  let lon, lat;
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new TypeError(`${label} must contain [longitude, latitude]`);
    [lon, lat] = value;
  } else if (value && typeof value === 'object') {
    ({ lon, lat } = value);
  } else {
    throw new TypeError(`${label} must be [longitude, latitude] or { lon, lat }`);
  }
  return [longitude(lon, `${label} longitude`), latitude(lat, `${label} latitude`)];
}

function localCoordinate(value, label = 'point') {
  let x, z;
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new TypeError(`${label} must contain [x, z]`);
    [x, z] = value;
  } else if (value && typeof value === 'object') {
    ({ x, z } = value);
  } else {
    throw new TypeError(`${label} must be [x, z] or { x, z }`);
  }
  return [finite(x, `${label} x`), finite(z, `${label} z`)];
}

function localSequence(value, label = 'polyline') {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of [x, z] points`);
  return value.map((point, index) => localCoordinate(point, `${label}[${index}]`));
}

function positive(value, label) {
  value = finite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function positiveScale(value, label) {
  value = finite(value, label);
  if (value < Number.EPSILON) throw new RangeError(`${label} must be at least Number.EPSILON`);
  return value;
}

function optionsFor(options) {
  if (options === undefined) return { metresPerUnit: 1, viewportSize: VIEWPORT_SIZE };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('projection options must be an object');
  }

  const hasMetres = options.metresPerUnit !== undefined;
  const hasMeters = options.metersPerUnit !== undefined;
  if (hasMetres && hasMeters && options.metresPerUnit !== options.metersPerUnit) {
    throw new RangeError('metresPerUnit and metersPerUnit must match when both are provided');
  }
  const metresPerUnit = positiveScale(
    hasMetres ? options.metresPerUnit : hasMeters ? options.metersPerUnit : 1,
    'metresPerUnit',
  );
  const viewportSize = positive(
    options.viewportSize === undefined ? VIEWPORT_SIZE : options.viewportSize,
    'viewportSize',
  );
  return { metresPerUnit, viewportSize };
}

function boundsFor(value = DEFAULT_BOUNDS) {
  if (value === DEFAULT_BOUNDS) return value;
  if (typeof value === 'number') {
    const size = positive(value, 'viewport size');
    const half = size / 2;
    return { minX: -half, maxX: half, minZ: -half, maxZ: half };
  }
  if (value && typeof value === 'object' && value.bounds) return boundsFor(value.bounds);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('viewport bounds must be an object or positive size');
  }

  const { minX, maxX, minZ, maxZ } = value;
  finite(minX, 'bounds minX');
  finite(maxX, 'bounds maxX');
  finite(minZ, 'bounds minZ');
  finite(maxZ, 'bounds maxZ');
  if (minX > maxX || minZ > maxZ) throw new RangeError('viewport bounds must be ordered');
  return { minX, maxX, minZ, maxZ };
}

function wrapLongitude(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  // Keep a positive 180-degree tie positive, while preserving -180 for a
  // negative tie. Both values describe the same meridian.
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

function longitudeDelta(lon, originLon) {
  return wrapLongitude(lon - originLon);
}

function inBounds(point, bounds) {
  const [x, z] = point;
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

const CLIP_LEFT = 1;
const CLIP_RIGHT = 2;
const CLIP_TOP = 4;
const CLIP_BOTTOM = 8;

function clipCode(point, bounds) {
  let code = 0;
  if (point[0] < bounds.minX) code |= CLIP_LEFT;
  if (point[0] > bounds.maxX) code |= CLIP_RIGHT;
  if (point[1] < bounds.minZ) code |= CLIP_TOP;
  if (point[1] > bounds.maxZ) code |= CLIP_BOTTOM;
  return code;
}

const FLOAT_BUFFER = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BUFFER);
const FLOAT_FRACTION_MASK = (1n << 52n) - 1n;

function dyadic(value) {
  FLOAT_VIEW.setFloat64(0, value);
  const bits = FLOAT_VIEW.getBigUint64(0);
  const fraction = bits & FLOAT_FRACTION_MASK;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const negative = (bits >> 63n) !== 0n;

  if (exponentBits === 0) {
    return { coefficient: negative ? -fraction : fraction, exponent: -1074 };
  }

  const coefficient = (1n << 52n) | fraction;
  return {
    coefficient: negative ? -coefficient : coefficient,
    exponent: exponentBits - 1023 - 52,
  };
}

function dyadicDifference(left, right) {
  const a = dyadic(left);
  const b = dyadic(right);
  if (a.exponent >= b.exponent) {
    return {
      coefficient: (a.coefficient << BigInt(a.exponent - b.exponent)) - b.coefficient,
      exponent: b.exponent,
    };
  }
  return {
    coefficient: a.coefficient - (b.coefficient << BigInt(b.exponent - a.exponent)),
    exponent: a.exponent,
  };
}

function bigintBitLength(value) {
  return value === 0n ? 0 : value.toString(2).length;
}

function boundedBigintRatio(numerator, denominator) {
  const shift = Math.max(0, Math.max(bigintBitLength(numerator), bigintBitLength(denominator)) - 1020);
  const scaledNumerator = shift === 0 ? numerator : numerator >> BigInt(shift);
  const scaledDenominator = shift === 0 ? denominator : denominator >> BigInt(shift);
  return Number(scaledNumerator) / Number(scaledDenominator);
}

function rationalToNumber(numerator, denominator, exponent) {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n;
  const absoluteNumerator = negative ? -numerator : numerator;
  const numeratorBits = bigintBitLength(absoluteNumerator);
  const denominatorBits = bigintBitLength(denominator);
  let ratioExponent = numeratorBits - denominatorBits;

  // The bit-length difference is only an estimate of floor(log2(n / d)).
  // Correct it before scaling so a finite value just below 2 ** 1024 does
  // not become Infinity through `mantissa * (2 ** 1024)`.
  const belowPower = ratioExponent >= 0
    ? absoluteNumerator < (denominator << BigInt(ratioExponent))
    : (absoluteNumerator << BigInt(-ratioExponent)) < denominator;
  if (belowPower) ratioExponent--;

  let scaledNumerator = absoluteNumerator;
  let scaledDenominator = denominator;
  if (ratioExponent >= 0) {
    scaledDenominator <<= BigInt(ratioExponent);
  } else {
    scaledNumerator <<= BigInt(-ratioExponent);
  }

  const mantissa = boundedBigintRatio(scaledNumerator, scaledDenominator);
  const power = ratioExponent + exponent;
  // Avoid evaluating a subnormal power first: 2 ** -1075 underflows to zero
  // even when multiplying the mantissa would round to Number.MIN_VALUE.
  const value = power < -1022
    ? mantissa * 2 ** (power + 1074) * Number.MIN_VALUE
    : mantissa * 2 ** power;
  return negative ? -value : value;
}

function lineCoordinateAtBoundary(start, end, boundary, otherStart, otherEnd) {
  const offset = dyadicDifference(boundary, start);
  const direction = dyadicDifference(end, start);
  const otherOrigin = dyadic(otherStart);
  const otherDirection = dyadicDifference(otherEnd, otherStart);

  let numerator = otherDirection.coefficient * offset.coefficient;
  let denominator = direction.coefficient;
  let exponent = otherDirection.exponent + offset.exponent - direction.exponent;
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }

  const commonExponent = Math.min(exponent, otherOrigin.exponent);
  numerator = (numerator << BigInt(exponent - commonExponent))
    + (otherOrigin.coefficient * denominator << BigInt(otherOrigin.exponent - commonExponent));
  return rationalToNumber(numerator, denominator, commonExponent);
}

function intersection(point, other, code, bounds) {
  let axis;
  let boundary;
  if (code & CLIP_TOP) {
    axis = 1;
    boundary = bounds.minZ;
  } else if (code & CLIP_BOTTOM) {
    axis = 1;
    boundary = bounds.maxZ;
  } else if (code & CLIP_RIGHT) {
    axis = 0;
    boundary = bounds.maxX;
  } else {
    axis = 0;
    boundary = bounds.minX;
  }

  const result = point.slice();
  result[axis] = boundary;
  result[1 - axis] = lineCoordinateAtBoundary(
    point[axis],
    other[axis],
    boundary,
    point[1 - axis],
    other[1 - axis],
  );
  return result;
}

function clippedSegment(a, b, bounds) {
  let first = a.slice();
  let second = b.slice();
  let firstCode = clipCode(first, bounds);
  let secondCode = clipCode(second, bounds);

  // Cohen-Sutherland's shared-outcode rejection explicitly handles segments
  // whose endpoints are both strictly beyond one viewport side. It also
  // keeps each boundary calculation anchored to the endpoint currently
  // outside, which preserves the public endpoint order.
  for (let iterations = 0; iterations < 8; iterations++) {
    if ((firstCode | secondCode) === 0) return [first, second];
    if ((firstCode & secondCode) !== 0) return null;

    if (firstCode !== 0) {
      first = intersection(first, second, firstCode, bounds);
      firstCode = clipCode(first, bounds);
    } else {
      second = intersection(second, first, secondCode, bounds);
      secondCode = clipCode(second, bounds);
    }
  }
  return null;
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function clippedPieces(polyline, bounds) {
  if (polyline.length === 0) return [];
  if (polyline.length === 1) return inBounds(polyline[0], bounds) ? [[polyline[0].slice()]] : [];

  const pieces = [];
  let current = null;
  for (let i = 0; i < polyline.length - 1; i++) {
    const clipped = clippedSegment(polyline[i], polyline[i + 1], bounds);
    if (!clipped) {
      current = null;
      continue;
    }

    const [start, end] = clipped;
    const joins = current && inBounds(polyline[i], bounds) && samePoint(current[current.length - 1], start);
    if (joins) {
      if (!samePoint(current[current.length - 1], end)) current.push(end);
    } else {
      current = [start];
      if (!samePoint(start, end)) current.push(end);
      pieces.push(current);
    }
  }
  return pieces;
}

/**
 * Return whether a local [x, z] point lies in an inclusive square/rectangle.
 * The optional bounds value is either { minX, maxX, minZ, maxZ } or a size.
 */
export function isInViewport(point, bounds = DEFAULT_BOUNDS) {
  return inBounds(localCoordinate(point), boundsFor(bounds));
}

export const inViewport = isInViewport;
export const pointInViewport = isInViewport;

/** Return a fresh local point when it is in bounds, otherwise null. */
export function cropPoint(point, bounds = DEFAULT_BOUNDS) {
  const local = localCoordinate(point);
  return inBounds(local, boundsFor(bounds)) ? local : null;
}

/** Keep only local points that lie in the inclusive viewport. */
export function cropPoints(points, bounds = DEFAULT_BOUNDS) {
  const local = localSequence(points, 'points');
  const viewport = boundsFor(bounds);
  return local.filter(point => inBounds(point, viewport));
}

/** Clip a local segment to an inclusive viewport; returns null when disjoint. */
export function clipSegment(a, b, bounds = DEFAULT_BOUNDS) {
  const first = localCoordinate(a, 'segment start');
  const second = localCoordinate(b, 'segment end');
  return clippedSegment(first, second, boundsFor(bounds));
}

/**
 * Clip a local polyline and return separate contiguous in-viewport pieces.
 * A line which leaves and later re-enters the viewport is never joined across
 * the out-of-bounds gap.
 */
export function clipPolyline(points, bounds = DEFAULT_BOUNDS) {
  return clippedPieces(localSequence(points), boundsFor(bounds));
}

export const clipLine = clipPolyline;
export const cropPolyline = clipPolyline;

/**
 * Build a deterministic local equirectangular projection. Geographic input
 * and output are [longitude, latitude] in degrees; local input and output are
 * [x, z] in units of metresPerUnit. Positive x is east and geographic north
 * is negative z.
 */
export function makeProjection(origin, options) {
  const [originLon, originLat] = geographicCoordinate(origin, 'origin');
  if (Math.abs(originLat) >= 90 - ORIGIN_POLE_EPSILON) {
    throw new RangeError('origin latitude must be strictly between -90 and 90 degrees');
  }
  const { metresPerUnit, viewportSize } = optionsFor(options);
  const viewportHalf = viewportSize / 2;
  const bounds = Object.freeze({
    minX: -viewportHalf,
    maxX: viewportHalf,
    minZ: -viewportHalf,
    maxZ: viewportHalf,
  });
  const latitudeScale = Math.cos(originLat * DEG_TO_RAD);
  const eastMetresPerDegree = EARTH_RADIUS_M * latitudeScale * DEG_TO_RAD;
  const northMetresPerDegree = EARTH_RADIUS_M * DEG_TO_RAD;

  function projectCoordinate(coordinate, lat, label = 'coordinate') {
    const geographic = lat === undefined
      ? geographicCoordinate(coordinate, label)
      : geographicCoordinate([coordinate, lat], label);
    const [lon, latitude] = geographic;
    const x = longitudeDelta(lon, originLon) * eastMetresPerDegree / metresPerUnit;
    const z = -(latitude - originLat) * northMetresPerDegree / metresPerUnit;
    return [x === 0 ? 0 : x, z === 0 ? 0 : z];
  }

  function inverseCoordinate(point, z) {
    const local = z === undefined ? localCoordinate(point) : localCoordinate([point, z]);
    const inverseLatitude = originLat - local[1] * metresPerUnit / northMetresPerDegree;
    latitude(inverseLatitude, 'inverse latitude');
    const lon = wrapLongitude(originLon + local[0] * metresPerUnit / eastMetresPerDegree);
    return [lon, inverseLatitude];
  }

  function projectSequence(coordinates) {
    if (!Array.isArray(coordinates)) throw new TypeError('coordinates must be an array');
    return coordinates.map((coordinate, index) => projectCoordinate(coordinate, undefined, `coordinates[${index}]`));
  }

  function inverseSequence(points) {
    const local = localSequence(points, 'points');
    return local.map(point => inverseCoordinate(point));
  }

  // Keep the public methods as closures so they do not depend on a mutable
  // receiver and can be safely passed as callbacks.
  const projection = {
    origin: Object.freeze({ lon: originLon, lat: originLat }),
    originCoordinate: Object.freeze([originLon, originLat]),
    metresPerUnit,
    metersPerUnit: metresPerUnit,
    viewportSize,
    viewportHalf,
    bounds,
    viewport: bounds,
    project: projectCoordinate,
    forward: projectCoordinate,
    projectPoint: projectCoordinate,
    inverse: inverseCoordinate,
    unproject: inverseCoordinate,
    inversePoint: inverseCoordinate,
    projectSequence,
    projectCoordinates: projectSequence,
    projectLine: projectSequence,
    inverseSequence,
    isInViewport: point => inBounds(localCoordinate(point), bounds),
    inViewport: point => inBounds(localCoordinate(point), bounds),
    pointInViewport: point => inBounds(localCoordinate(point), bounds),
    contains: point => inBounds(localCoordinate(point), bounds),
    cropPoint: point => {
      const local = localCoordinate(point);
      return inBounds(local, bounds) ? local : null;
    },
    cropPoints: points => cropPoints(points, bounds),
    clipSegment: (a, b) => clippedSegment(localCoordinate(a, 'segment start'), localCoordinate(b, 'segment end'), bounds),
    clipPolyline: points => clippedPieces(localSequence(points), bounds),
    clipLine: points => clippedPieces(localSequence(points), bounds),
    cropPolyline: points => clippedPieces(localSequence(points), bounds),
  };
  return Object.freeze(projection);
}

export const createProjection = makeProjection;

export const DEFAULT_VIEWPORT_BOUNDS = DEFAULT_BOUNDS;
