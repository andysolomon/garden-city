// Faces → buildable area → parcels (docs/V2-ROAD-GRAPH.md §6).
//
// A face polygon is offset inward per edge (road half-width + zone setback),
// the buildable polygon is split recursively along its oriented bounding box,
// and every parcel records its frontage — the block-boundary edge it touches.
// Parcels without frontage are landlocked and become courtyards.

import {
  area, obb, clipHalfPlaneMulti, offsetPolygon, pointSegDist, distToBoundary,
  pointInPolygon, orientedRect, centroid,
} from './geom.js';

export const SETBACK = {
  // zone → per road class setback beyond the road's half width
  residential: { arterial: 6, collector: 4, local: 3, boundary: 1, shore: 4, bridge: 6 },
  commercial:  { arterial: 4, collector: 3, local: 2.5, boundary: 1, shore: 4, bridge: 6 },
  industrial:  { arterial: 7, collector: 5, local: 4, boundary: 1, shore: 3, bridge: 7 },
  civic:       { arterial: 8, collector: 6, local: 5, boundary: 1, shore: 5, bridge: 7 },
  mixed:       { arterial: 5, collector: 3.5, local: 3, boundary: 1, shore: 4, bridge: 6 },
};

export function buildableArea(face, g, zone, detail) {
  const dists = face.edges.map(eid => {
    const e = g.edges[eid];
    const sb = (SETBACK[zone] || SETBACK.mixed)[e.bridge ? 'bridge' : e.cls] ?? 3;
    const scale = detail === 'high' ? .85 : 1;
    return e.width / 2 + sb * scale;
  });
  let poly = offsetPolygon(face.polygon, dists);
  if (!poly) {
    // Retry with a uniform, slightly smaller inset before giving up.
    const avg = dists.reduce((s, d) => s + d, 0) / dists.length * .85;
    poly = offsetPolygon(face.polygon, dists.map(() => avg));
  }
  return poly;
}

// Recursive OBB split. Returns { parcels, slivers }.
export function subdivideParcels(poly, { targetArea, minWidth, rng, maxDepth = 9 }) {
  const out = [];
  let slivers = 0;
  rec(poly, 0);
  const parcels = out.filter(p => {
    const b = obb(p);
    const ok = area(p) >= minWidth * minWidth * .8 && Math.min(b.w, b.d) >= minWidth * .7;
    if (!ok) slivers++;
    return ok;
  });
  return { parcels, slivers };

  function rec(p, depth) {
    const a = area(p);
    if (a < 4) return;
    const box = obb(p);
    const minDim = Math.min(box.w, box.d);
    if (a < targetArea || depth >= maxDepth || minDim < minWidth * 2) { out.push(p); return; }
    const c = Math.cos(box.angle), s = Math.sin(box.angle);
    const long = box.w >= box.d;
    const nx = long ? c : -s, nz = long ? s : c;
    const mid = long ? (box.u0 + box.u1) / 2 : (box.v0 + box.v1) / 2;
    const len = long ? box.w : box.d;
    const cut = mid + rng.float(-.12, .12) * len;
    const pieces = [...clipHalfPlaneMulti(p, nx, nz, cut), ...clipHalfPlaneMulti(p, -nx, -nz, -cut)];
    if (pieces.length < 2) { out.push(p); return; }
    for (const piece of pieces) rec(piece, depth + 1);
  }
}

// Frontage: the longest parcel edge lying on the buildable-block boundary.
// Returns { a, b, angle, length, cls } or null (landlocked).
export function findFrontage(parcel, buildable, face, g, tol = .6) {
  let best = null;
  const n = parcel.length;
  for (let i = 0; i < n; i++) {
    const a = parcel[i], b = parcel[(i + 1) % n];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (distToBoundary(a[0], a[1], buildable) > tol || distToBoundary(b[0], b[1], buildable) > tol || distToBoundary(mx, mz, buildable) > tol) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 4) continue;
    if (!best || length > best.length) {
      // Class of the original face edge nearest this frontage.
      let cls = 'local', bd = Infinity;
      const fp = face.polygon;
      for (let k = 0; k < fp.length; k++) {
        const p = fp[k], q = fp[(k + 1) % fp.length];
        const d = pointSegDist(mx, mz, p[0], p[1], q[0], q[1]).d;
        if (d < bd) { bd = d; cls = g.edges[face.edges[k]].cls; }
      }
      best = { a, b, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), length, cls };
    }
  }
  return best;
}

// Largest oriented rectangle (at `angle`) that fits inside the parcel after
// an inset. Iteratively shrinks until all four corners are inside.
export function fitRect(parcel, angle, inset) {
  const box = obb(parcel, angle);
  let w = box.w - inset * 2, d = box.d - inset * 2;
  const [cx, cz] = centroid(parcel);
  for (let k = 0; k < 16; k++) {
    if (w < 4 || d < 4) return null;
    const corners = orientedRect(cx, cz, w, d, angle);
    if (corners.every(([x, z]) => pointInPolygon(x, z, parcel))) return { cx, cz, w, d, angle };
    w *= .9; d *= .9;
  }
  return null;
}
