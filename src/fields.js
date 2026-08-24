// Fields: everything the growth algorithm decides, it decides by sampling one
// of these at a point (docs/V2-ROAD-GRAPH.md §3). They are plain functions so
// they can later be swapped for painted masks or GIS data.
//
//   water(x, z)       → signed distance, < 0 is water     (from shore polylines)
//   population(x, z)  → 0..1 development pressure         (sum of Gaussians)
//   direction(x, z)   → major street angle in [0, π)      (blended angle field)
//   exclusion(x, z)   → true inside no-build footprints   (station, etc.)
//   elevation(x, z)   → 0 (stub; V2.1)

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
// Direction: blended *angle* field (shippable first cut of the tensor field).
// Each source contributes a line direction with a radial-basis weight; the
// blend happens on doubled angles so that θ and θ+π agree, and the result is
// perturbed by value noise for organic fabric. Returns the major angle in
// [0, π); the minor is major + π/2.
//
// sources: [{ type: 'grid', angle, x, z, sigma, weight }
//           { type: 'radial', x, z, sigma, weight }]
// sigma = Infinity gives a global source.
// ---------------------------------------------------------------------------
export function makeDirection(sources, noise, opts = {}) {
  const amp = opts.noiseAmp || 0, scale = opts.noiseScale || 1 / 150;
  return (x, z) => {
    let cx = 0, cz = 0;
    for (const s of sources) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      const w = s.weight * (isFinite(s.sigma) ? Math.exp(-d2 / (2 * s.sigma * s.sigma)) : 1);
      if (w < 1e-6) continue;
      const a = s.type === 'radial' ? Math.atan2(dz, dx) : s.angle;
      cx += Math.cos(2 * a) * w; cz += Math.sin(2 * a) * w;
    }
    let a = (cx === 0 && cz === 0) ? 0 : Math.atan2(cz, cx) / 2;
    if (amp) a += noise(x * scale + 17.3, z * scale - 4.1) * amp;
    a %= Math.PI;
    if (a < 0) a += Math.PI;
    return a;
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
