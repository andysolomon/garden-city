// Fields: everything the growth algorithm decides, it decides by sampling one
// of these at a point (docs/V2-ROAD-GRAPH.md §3). They are plain functions so
// they can later be swapped for painted masks or GIS data.
//
//   water(x, z)       → signed distance, < 0 is water     (from shore polylines)
//   population(x, z)  → 0..1 development pressure         (sum of Gaussians)
//   direction(x, z)   → major street angle in [0, π)      (blended angle field)
//   exclusion(x, z)   → true inside no-build footprints   (station, etc.)
//   elevation(x, z)   → metres, bounded to a small city-scale land range

import { hashSeed } from './rng.js';
import { pointInPolygon, pointSegDist, angleDiff, signedArea } from './geom.js';
import { clipSegment } from './geography.js';

// ---------------------------------------------------------------------------
// Seeded 2D value noise, smooth and cheap. Returns -1..1.
// ---------------------------------------------------------------------------
export function makeNoise(seed) {
  const base = hashSeed(seed);
  const lattice = (ix, iz) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ base;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1;
  };
  const fade = t => t * t * (3 - 2 * t);
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = fade(x - ix), fz = fade(z - iz);
    const a = lattice(ix, iz), b = lattice(ix + 1, iz), c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
}

// ---------------------------------------------------------------------------
// Elevation: a deterministic, metre-scale terrain field. The factory owns a
// namespaced noise stream and never consumes a city's geometry RNG, so adding
// terrain cannot reshuffle roads, parcels, or life placement.
// ---------------------------------------------------------------------------
export const ELEVATION_MAX = 72;

export function makeElevation(seed, size = 900) {
  const extent = Number.isFinite(size) && size > 0 ? size : 900;
  const macro = makeNoise(`${seed}:elevation:macro`);
  const detail = makeNoise(`${seed}:elevation:detail`);
  const macroScale = extent / 3.75;
  const detailScale = extent / 9.375;

  return (x, z) => {
    const px = Number.isFinite(x) ? x : 0;
    const pz = Number.isFinite(z) ? z : 0;
    const n = macro(px / macroScale, pz / macroScale) * .72
      + detail(px / detailScale + 13.7, pz / detailScale - 8.2) * .28;
    return Math.max(0, Math.min(ELEVATION_MAX, (n + 1) * .5 * ELEVATION_MAX));
  };
}

// ---------------------------------------------------------------------------
// Water: shorelines are polylines (open or closed). The signed distance is
// the distance to the nearest shore segment, negative when isLand() is false.
// The same polylines are inserted into the road graph as `shore` edges, so
// the geometry the growth sees and the geometry the faces see are identical.
// ---------------------------------------------------------------------------
function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

// Segment interpolation can reproduce a shared source vertex with a few ULPs
// of error. Use tolerance only while assembling graph-facing shorelines; the
// authoritative polygon and mask paths retain exact source coordinates.
function sameShorePoint(a, b) {
  const scale = Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  const epsilon = Math.max(1e-9, Number.EPSILON * scale * 32);
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

// Face extraction retains the graph component with the most edges. Imported
// rings are graph hints rather than the authoritative water geometry, so cap
// their vertex count below a normal road fabric's size. Ordered decimation is
// deterministic, retains open-piece endpoints, and never changes polygons or
// the segments used by isLand/SDF.
const MAX_IMPORTED_SHORE_POINTS = 24;

function chordCutsLand(a, b, sdf) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(length > 0)) return false;
  const n = Math.max(2, Math.ceil(length / 2));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) > 0.5) return true;
  }
  return false;
}

function indicesBetween(count, from, to, closed) {
  const idx = [];
  if (count < 1) return idx;
  let i = closed ? (from + 1) % count : from + 1;
  let steps = 0;
  while (i !== to && i < count && steps++ <= count) {
    idx.push(i);
    i = closed ? (i + 1) % count : i + 1;
  }
  return idx;
}

function farthestFromChord(points, from, to, closed) {
  const a = points[from], b = points[to];
  let best = null, bestD = 0;
  for (const i of indicesBetween(points.length, from, to, closed)) {
    const d = pointSegDist(points[i][0], points[i][1], a[0], a[1], b[0], b[1]).d;
    if (d > bestD + 1e-12 || (Math.abs(d - bestD) <= 1e-12 && (best === null || i < best))) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Uniform decimation can chord a concave bay through land. Repair by inserting
// the farthest original vertex, then split rather than emit a land-cutting chord.
function boundShorePieces(points, closed, sdf) {
  if (points.length <= MAX_IMPORTED_SHORE_POINTS) return [{ pts: points, closed }];
  const idxs = [];
  for (let i = 0; i < MAX_IMPORTED_SHORE_POINTS; i++) {
    const index = closed
      ? Math.floor(i * points.length / MAX_IMPORTED_SHORE_POINTS)
      : Math.round(i * (points.length - 1) / (MAX_IMPORTED_SHORE_POINTS - 1));
    if (!idxs.length || idxs[idxs.length - 1] !== index) idxs.push(index);
  }
  let changed = true;
  while (changed && idxs.length < MAX_IMPORTED_SHORE_POINTS) {
    changed = false;
    const pairs = closed ? idxs.length : idxs.length - 1;
    for (let i = 0; i < pairs; i++) {
      const aIdx = idxs[i], bIdx = idxs[(i + 1) % idxs.length];
      if (!chordCutsLand(points[aIdx], points[bIdx], sdf)) continue;
      const insert = farthestFromChord(points, aIdx, bIdx, closed);
      if (insert === null || idxs.includes(insert)) continue;
      idxs.splice(i + 1, 0, insert);
      changed = true;
      break;
    }
  }
  const pieces = [];
  let current = [points[idxs[0]]];
  const pairs = closed ? idxs.length : idxs.length - 1;
  let split = false;
  for (let i = 0; i < pairs; i++) {
    const aIdx = idxs[i], bIdx = idxs[(i + 1) % idxs.length];
    const next = points[bIdx];
    if (chordCutsLand(points[aIdx], next, sdf)) {
      split = true;
      if (current.length >= 2) pieces.push({ pts: current, closed: false });
      current = [next];
      continue;
    }
    if (!samePoint(current[current.length - 1], next)) current.push(next);
  }
  if (!split && closed && current.length > 2 && sameShorePoint(current[0], current[current.length - 1])) {
    current.pop();
    return [{ pts: current, closed: true }];
  }
  if (!split && closed) return [{ pts: current, closed: current.length > 2 }];
  if (current.length >= 2) pieces.push({ pts: current, closed: false });
  return pieces.filter(piece => piece.pts.length >= 2);
}

/**
 * Convert normalized polygon records into the fields water boundary. Returned
 * polygon coordinates are owned copies; clipping affects only `shores`.
 */
export function makeImportedWater(records, size = 900) {
  if (!Array.isArray(records)) throw new TypeError('imported water records must be an array');
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('imported water size must be a positive finite number');

  const polygons = [];
  const rings = [];
  for (const record of records) {
    if (!record || record.geometry?.type !== 'polygon') continue;
    if (!Array.isArray(record.geometry.polygons)) throw new TypeError('polygon geometry polygons must be an array');
    for (const sourcePolygon of record.geometry.polygons) {
      if (!Array.isArray(sourcePolygon) || sourcePolygon.length === 0) {
        throw new TypeError('each polygon must contain at least one ring');
      }
      const polygon = sourcePolygon.map(sourceRing => {
        if (!Array.isArray(sourceRing)) throw new TypeError('polygon rings must be arrays');
        const copied = sourceRing.map(point => {
          if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
            throw new TypeError('polygon coordinates must be finite [x, z] points');
          }
          return [point[0], point[1]];
        });
        const sample = copied.length > 1 && samePoint(copied[0], copied[copied.length - 1])
          ? copied.slice(0, -1) : copied.slice();
        const unique = new Set(sample.map(point => `${point[0]},${point[1]}`));
        if (unique.size < 3) throw new TypeError('polygon rings must contain at least three distinct sampling points');
        if (Math.abs(signedArea(sample)) <= 1e-8) {
          throw new TypeError('polygon rings must enclose a non-zero area');
        }
        rings.push(sample);
        return copied;
      });
      polygons.push(polygon);
    }
  }

  const waterAt = (x, z) => {
    for (const polygon of polygons) {
      const outer = polygon[0].length > 1 && samePoint(polygon[0][0], polygon[0][polygon[0].length - 1])
        ? polygon[0].slice(0, -1) : polygon[0];
      if (!pointInPolygon(x, z, outer)) continue;
      let inHole = false;
      for (let i = 1; i < polygon.length; i++) {
        const ring = polygon[i].length > 1 && samePoint(polygon[i][0], polygon[i][polygon[i].length - 1])
          ? polygon[i].slice(0, -1) : polygon[i];
        if (pointInPolygon(x, z, ring)) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
    return false;
  };
  const isLand = (x, z) => !waterAt(x, z);

  // Split source edges wherever boundaries meet. An atomic edge is retained
  // only when samples on its opposite sides differ in the union mask; hidden
  // overlap edges therefore cannot become false zero-distance shorelines.
  const sourceSegments = [];
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (!samePoint(a, b)) sourceSegments.push({ a, b, ringIndex, order: i, cuts: [0, 1] });
    }
  }
  for (let i = 0; i < sourceSegments.length; i++) for (let j = i + 1; j < sourceSegments.length; j++) {
    const first = sourceSegments[i], second = sourceSegments[j];
    for (const endpoint of [second.a, second.b]) {
      const nearest = pointSegDist(endpoint[0], endpoint[1], first.a[0], first.a[1], first.b[0], first.b[1]);
      if (nearest.d <= 1e-9 && nearest.t > 0 && nearest.t < 1) first.cuts.push(nearest.t);
    }
    for (const endpoint of [first.a, first.b]) {
      const nearest = pointSegDist(endpoint[0], endpoint[1], second.a[0], second.a[1], second.b[0], second.b[1]);
      if (nearest.d <= 1e-9 && nearest.t > 0 && nearest.t < 1) second.cuts.push(nearest.t);
    }
    // Non-collinear crossings have no endpoint on the other segment.
    const ax = first.a[0], az = first.a[1], arx = first.b[0] - ax, arz = first.b[1] - az;
    const bx = second.a[0], bz = second.a[1], brx = second.b[0] - bx, brz = second.b[1] - bz;
    const cross = arx * brz - arz * brx;
    if (Math.abs(cross) > 1e-12) {
      const t = ((bx - ax) * brz - (bz - az) * brx) / cross;
      const u = ((bx - ax) * arz - (bz - az) * arx) / cross;
      if (t > 0 && t < 1 && u > 0 && u < 1) { first.cuts.push(t); second.cuts.push(u); }
    }
  }

  const activeByRing = rings.map(() => []);
  const activeSegments = [];
  const seen = new Set();
  for (const segment of sourceSegments) {
    const cuts = [...new Set(segment.cuts)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const t0 = cuts[i], t1 = cuts[i + 1];
      if (t1 - t0 <= 1e-12) continue;
      const point = t => [segment.a[0] + (segment.b[0] - segment.a[0]) * t,
        segment.a[1] + (segment.b[1] - segment.a[1]) * t];
      const a = point(t0), b = point(t1), mid = point((t0 + t1) / 2);
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      const epsilon = Math.max(1e-7, length * 1e-9);
      const nx = -dz / length * epsilon, nz = dx / length * epsilon;
      if (waterAt(mid[0] + nx, mid[1] + nz) === waterAt(mid[0] - nx, mid[1] - nz)) continue;
      const keyA = `${a[0]},${a[1]}`, keyB = `${b[0]},${b[1]}`;
      const key = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const atom = { a, b, order: segment.order + t0 };
      activeSegments.push([a, b]);
      activeByRing[segment.ringIndex].push(atom);
    }
  }

  const sdf = (x, z) => {
    if (!activeSegments.length) return 1e9;
    let best = Infinity;
    for (const [a, b] of activeSegments) {
      best = Math.min(best, pointSegDist(x, z, a[0], a[1], b[0], b[1]).d);
    }
    if (best === 0) return 0;
    return isLand(x, z) ? best : -best;
  };

  const shores = [];
  const bounds = { minX: -size / 2, maxX: size / 2, minZ: -size / 2, maxZ: size / 2 };
  for (const atoms of activeByRing) {
    atoms.sort((a, b) => a.order - b.order);
    const pieces = [];
    let current = null;
    for (const atom of atoms) {
      const clipped = clipSegment(atom.a, atom.b, bounds);
      const onViewportEdge = clipped && (
        (clipped[0][0] === bounds.minX && clipped[1][0] === bounds.minX)
        || (clipped[0][0] === bounds.maxX && clipped[1][0] === bounds.maxX)
        || (clipped[0][1] === bounds.minZ && clipped[1][1] === bounds.minZ)
        || (clipped[0][1] === bounds.maxZ && clipped[1][1] === bounds.maxZ)
      );
      if (!clipped || samePoint(clipped[0], clipped[1]) || onViewportEdge) { current = null; continue; }
      if (current && sameShorePoint(current[current.length - 1], clipped[0])) {
        if (!sameShorePoint(current[current.length - 1], clipped[1])) current.push(clipped[1]);
      } else {
        current = [clipped[0], clipped[1]];
        pieces.push(current);
      }
    }
    if (pieces.length > 1 && sameShorePoint(pieces[pieces.length - 1].at(-1), pieces[0][0])) {
      const last = pieces.pop();
      pieces[0] = last.slice(0, -1).concat(pieces[0]);
    }
    for (const pts of pieces) {
      const closed = pts.length > 2 && sameShorePoint(pts[0], pts[pts.length - 1]);
      if (closed) pts.pop();
      for (const shore of boundShorePieces(pts, closed, sdf)) {
        if (shore.pts.length >= 2) shores.push(shore);
      }
    }
  }

  return { kind: 'imported', polygons, shores, isLand, sdf };
}

export function makeWater(land, size) {
  if (land.kind === 'imported') return makeImportedWater(land.records, size);
  const S = size, H = S / 2;
  const shores = []; // [{ pts: [[x,z],…], closed }]
  let isLand;
  if (land.kind === 'river') {
    const { x0, x1 } = land;
    shores.push({ pts: [[x0, -H], [x0, H]], closed: false });
    shores.push({ pts: [[x1, -H], [x1, H]], closed: false });
    isLand = (x) => x <= x0 || x >= x1;
  } else if (land.kind === 'coast') {
    const e = land.edge;
    shores.push({ pts: [[e, -H], [e, H]], closed: false });
    isLand = (x) => x >= e;
  } else if (land.kind === 'island') {
    const n = 56, pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2;
      pts.push([Math.cos(t) * land.rx, Math.sin(t) * land.rz]);
    }
    shores.push({ pts, closed: true });
    isLand = (x, z) => pointInPolygon(x, z, pts);
  } else {
    isLand = () => true;
  }
  const segs = [];
  for (const s of shores) {
    const n = s.pts.length;
    for (let i = 0; i < (s.closed ? n : n - 1); i++) segs.push([s.pts[i], s.pts[(i + 1) % n]]);
  }
  const sdf = (x, z) => {
    if (!segs.length) return 1e9;
    let best = Infinity;
    for (const [a, b] of segs) {
      const d = pointSegDist(x, z, a[0], a[1], b[0], b[1]).d;
      if (d < best) best = d;
    }
    return isLand(x, z) ? best : -best;
  };
  return { kind: land.kind, shores, isLand, sdf };
}

// ---------------------------------------------------------------------------
// Population: Gaussian blobs at urban centers, normalized so the strongest
// point in the city is 1. Polycentric by construction.
// ---------------------------------------------------------------------------
export function makePopulation(centers, size) {
  const raw = (x, z) => {
    let p = 0;
    for (const c of centers) {
      const d2 = (x - c.x) ** 2 + (z - c.z) ** 2;
      p += c.w * Math.exp(-d2 / (2 * c.sigma * c.sigma));
    }
    return p;
  };
  let max = 1e-6;
  const H = size / 2;
  for (let i = 0; i <= 30; i++) for (let j = 0; j <= 30; j++) {
    const v = raw(-H + i * size / 30, -H + j * size / 30);
    if (v > max) max = v;
  }
  for (const c of centers) { const v = raw(c.x, c.z); if (v > max) max = v; }
  return (x, z) => Math.min(1, raw(x, z) / max);
}

// ---------------------------------------------------------------------------
// Direction: a blended symmetric-traceless tensor field. A line direction θ
// is represented by [[cos(2θ), sin(2θ)], [sin(2θ), -cos(2θ)]], so opposite
// headings describe the same basis. The major eigenvector is returned as an
// angle in [0, π); the minor is major + π/2.
//
// sources: [{ type: 'grid', angle, x, z, sigma, weight }
//           { type: 'radial', x, z, sigma, weight }]
// sigma = Infinity gives a global source. opts.shores accepts the shoreline
// array returned by makeWater(); each valid segment contributes its tangent
// basis using a point-to-segment RBF falloff.
// ---------------------------------------------------------------------------
function finiteOr(value, fallback) { return Number.isFinite(value) ? value : fallback; }

function sigmaOr(value, fallback) {
  if (value === Infinity || value === -Infinity) return Infinity;
  return Number.isFinite(value) ? Math.abs(value) : fallback;
}

function sourceWeight(source, d2) {
  const weight = source.weight === undefined ? 1 : finiteOr(source.weight, 0);
  if (!weight) return 0;
  const rawSigma = source.sigma;
  const sigma = rawSigma === undefined || rawSigma === null ? Infinity : sigmaOr(rawSigma, Infinity);
  return weight * rbfWeight(d2, sigma);
}

function rbfWeight(d2, sigma) {
  if (!Number.isFinite(d2) || d2 < 0) return 0;
  if (sigma === Infinity) return 1;
  if (d2 === 0) return 1;
  if (sigma <= 0) return d2 === 0 ? 1 : 0;
  return Math.exp(-d2 / (sigma * sigma));
}

function shorePoint(point, index, name) {
  if (Array.isArray(point)) return finiteOr(point[index], null);
  if (point && typeof point === 'object') return finiteOr(point[name], null);
  return null;
}

function boundaryBases(data, defaultSigma, defaultWeight) {
  const shores = Array.isArray(data) ? data : data?.shores;
  if (!Array.isArray(shores)) return [];
  const bases = [];
  for (const shore of shores) {
    const points = Array.isArray(shore) ? shore : shore?.pts;
    if (!Array.isArray(points) || points.length < 2) continue;
    const closed = !Array.isArray(shore) && shore?.closed === true;
    const weight = shore?.weight === undefined ? defaultWeight : finiteOr(shore.weight, 0);
    const sigma = shore?.sigma === undefined ? defaultSigma : sigmaOr(shore.sigma, defaultSigma);
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const ax = shorePoint(a, 0, 'x'), az = shorePoint(a, 1, 'z');
      const bx = shorePoint(b, 0, 'x'), bz = shorePoint(b, 1, 'z');
      if (![ax, az, bx, bz].every(Number.isFinite)) continue;
      if (ax === bx && az === bz) continue;
      bases.push({ ax, az, bx, bz, angle: Math.atan2(bz - az, bx - ax), weight, sigma });
    }
  }
  return bases;
}

function optionNumber(options, names, fallback) {
  for (const name of names) if (options[name] !== undefined) return finiteOr(options[name], fallback);
  return fallback;
}

export function makeDirection(sources = [], noise, opts = {}, shorelines = null) {
  // Accept the shoreline array as the third argument as well as through the
  // options object. The latter keeps the existing options call shape intact.
  const options = Array.isArray(opts) ? (shorelines && !Array.isArray(shorelines) ? shorelines : {})
    : (opts && typeof opts === 'object' ? opts : {});
  const shorelineData = Array.isArray(opts) ? opts
    : shorelines || options.shores || options.shorelines || options.water?.shores || options.boundaries || options.boundary;
  const amp = optionNumber(options, ['noiseAmp'], 0);
  const scale = optionNumber(options, ['noiseScale'], 1 / 150);
  const fallbackAngle = optionNumber(options, ['defaultAngle'], 0);
  const boundarySigma = sigmaOr(optionNumber(options, ['boundarySigma', 'shoreSigma', 'shorelineSigma'], 120), 120);
  const boundaryWeight = optionNumber(options, ['boundaryWeight', 'shoreWeight', 'shorelineWeight'], 2);
  const boundaries = boundaryBases(shorelineData, boundarySigma, boundaryWeight);
  const basisSources = Array.isArray(sources) ? sources : [];
  return (x, z) => {
    const px = finiteOr(x, 0), pz = finiteOr(z, 0);
    let tensorXX = 0, tensorXZ = 0;
    const addBasis = (angle, weight) => {
      if (!Number.isFinite(angle) || !Number.isFinite(weight) || weight <= 0) return;
      tensorXX += Math.cos(2 * angle) * weight;
      tensorXZ += Math.sin(2 * angle) * weight;
    };
    for (const source of basisSources) {
      if (!source || typeof source !== 'object') continue;
      const sx = finiteOr(source.x, 0), sz = finiteOr(source.z, 0);
      const dx = px - sx, dz = pz - sz;
      const w = sourceWeight(source, dx * dx + dz * dz);
      if (!w) continue;
      let angle = finiteOr(source.angle, 0);
      if (source.type === 'radial') angle = (dx === 0 && dz === 0) ? 0 : Math.atan2(dz, dx);
      addBasis(angle, w);
    }
    const sourceMagnitude = Math.hypot(tensorXX, tensorXZ);
    let boundaryMass = 0;
    for (const boundary of boundaries) {
      const nearest = pointSegDist(px, pz, boundary.ax, boundary.az, boundary.bx, boundary.bz);
      const w = boundary.weight * rbfWeight(nearest.d * nearest.d, boundary.sigma);
      if (w > 0 && Number.isFinite(w)) boundaryMass += w;
      addBasis(boundary.angle, w);
    }
    let angle = Math.hypot(tensorXX, tensorXZ) > 1e-12 ? Math.atan2(tensorXZ, tensorXX) / 2 : fallbackAngle;
    if (amp && typeof noise === 'function') {
      const n = noise(px * scale + 17.3, pz * scale - 4.1);
      if (Number.isFinite(n)) {
        // Keep organic variation in the interior, but let a nearby shoreline
        // remain visibly tangent-aligned. This factor is exactly 1 when no
        // boundary data is supplied, preserving the flat-city path.
        const boundaryInfluence = boundaryMass / (boundaryMass + sourceMagnitude || 1);
        angle += n * amp * (1 - Math.min(1, boundaryInfluence));
      }
    }
    angle %= Math.PI;
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle = 0;
    return Number.isFinite(angle) ? angle : 0;
  };
}

// Of the four field-aligned headings at a point, the one closest to `heading`.
export function nearestAligned(major, heading) {
  let best = major, bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = major + k * Math.PI / 2;
    const d = Math.abs(angleDiff(a, heading));
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

export function makeExclusion(rects) {
  return (x, z) => {
    for (const r of rects) if (x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d) return true;
    return false;
  };
}
