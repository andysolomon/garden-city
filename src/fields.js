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
import { pointInPolygon, pointSegDist, angleDiff } from './geom.js';

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
export function makeWater(land, size) {
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
