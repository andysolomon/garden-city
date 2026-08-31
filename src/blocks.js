// Faces → buildable area → parcels (docs/V2-ROAD-GRAPH.md §6).
//
// A face polygon is offset inward per edge (road half-width + zone setback),
// the buildable polygon is split recursively along its oriented bounding box,
// and every parcel records its frontage — the block-boundary edge it touches.
// Parcels without frontage are landlocked and become courtyards.

import {
  area, obb, clipHalfPlaneMulti, offsetPolygon, shrinkPolygonMulti, pointSegDist, distToBoundary,
  pointInPolygon, orientedRect, centroid, segmentsTouch, mergeAdjacentPolygons, sharedBoundaryLength,
} from './geom.js';

export const SETBACK = {
  // zone → per road class setback beyond the road's half width
  residential: { arterial: 6, collector: 4, local: 3, boundary: 1, shore: 4, bridge: 6 },
  commercial:  { arterial: 4, collector: 3, local: 2.5, boundary: 1, shore: 4, bridge: 6 },
  industrial:  { arterial: 7, collector: 5, local: 4, boundary: 1, shore: 3, bridge: 7 },
  civic:       { arterial: 8, collector: 6, local: 5, boundary: 1, shore: 5, bridge: 7 },
  mixed:       { arterial: 5, collector: 3.5, local: 3, boundary: 1, shore: 4, bridge: 6 },
};

export function buildableAreas(face, g, zone, detail) {
  const dists = face.edges.map(eid => {
    const e = g.edges[eid];
    const sb = (SETBACK[zone] || SETBACK.mixed)[e.bridge ? 'bridge' : e.cls] ?? 3;
    const scale = detail === 'high' ? .85 : 1;
    return e.width / 2 + sb * scale;
  });
  // Miter offset first (cheap, exact for the common convex block); when a
  // short edge collapses under the inset the miter self-intersects, so fall
  // back to the stepped shrink that handles edge events.
  const poly = offsetPolygon(face.polygon, dists);
  if (poly) return [poly];
  let pieces = shrinkPolygonMulti(face.polygon, dists);
  if (!pieces.length) {
    const avg = dists.reduce((s, d) => s + d, 0) / dists.length * .85;
    pieces = shrinkPolygonMulti(face.polygon, dists.map(() => avg));
  }
  return pieces;
}

// Preserve the established single-ring API for callers that cannot represent
// split events. The graph fabric uses buildableAreas to retain every piece.
export function buildableArea(face, g, zone, detail) {
  return buildableAreas(face, g, zone, detail)[0] || null;
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

// Deterministically fold landlocked lots into the neighbour with which they
// share the longest boundary. Only components that already contain frontage
// are processed: an isolated interior component remains available to the
// courtyard fallback instead of collapsing into one oversized parcel.
export function mergeLandlockedParcels(polygons, frontageFor, tol = 1e-6) {
  const lots = polygons.map((polygon, id) => ({ polygon, id, frontage: frontageFor(polygon), pending: false }));
  const adjacent = lots.map(() => []);
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    if (sharedBoundaryLength(lots[i].polygon, lots[j].polygon, tol) <= tol) continue;
    adjacent[i].push(j); adjacent[j].push(i);
  }

  const seen = new Uint8Array(lots.length);
  for (let start = 0; start < lots.length; start++) {
    if (seen[start]) continue;
    const component = [], queue = [start];
    seen[start] = 1;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]; component.push(i);
      for (const j of adjacent[i]) if (!seen[j]) { seen[j] = 1; queue.push(j); }
    }
    if (component.some(i => lots[i].frontage)) {
      for (const i of component) lots[i].pending = !lots[i].frontage;
    }
  }

  let merged = 0;
  while (true) {
    const source = lots.find(lot => lot.pending);
    if (!source) break;
    source.pending = false;
    let best = null;
    for (const target of lots) {
      if (target === source) continue;
      const shared = sharedBoundaryLength(source.polygon, target.polygon, tol);
      if (shared <= tol) continue;
      const polygon = mergeAdjacentPolygons(source.polygon, target.polygon, tol);
      if (!polygon) continue;
      if (!best || shared > best.shared + tol || (Math.abs(shared - best.shared) <= tol && target.id < best.target.id)) {
        best = { target, polygon, shared };
      }
    }
    if (!best) continue;
    best.target.polygon = best.polygon;
    best.target.frontage = frontageFor(best.polygon);
    best.target.pending = !best.target.frontage;
    lots.splice(lots.indexOf(source), 1);
    merged++;
  }

  return { parcels: lots.map(({ polygon, frontage }) => ({ polygon, frontage })), merged };
}

// Largest oriented rectangle (at `angle`) that fits inside the parcel after
// an inset. Iteratively shrinks until the complete rectangle is inside; corner
// checks alone can bridge an exterior notch in a concave parcel.
export function fitRect(parcel, angle, inset) {
  const box = obb(parcel, angle);
  const w0 = box.w - inset * 2, d0 = box.d - inset * 2;
  if (w0 < 4 || d0 < 4) return null;

  // The area centroid is the legacy first choice and remains the only choice
  // for the usual convex parcel. A concave union can put it in a notch, so
  // continue with a fixed OBB lattice of interior centers when that choice
  // cannot contain a complete rectangle.
  for (const [cx, cz] of interiorCandidates(parcel, angle, box)) {
    let w = w0, d = d0;
    for (let k = 0; k < 16; k++) {
      if (w < 4 || d < 4) break;
      const corners = orientedRect(cx, cz, w, d, angle);
      if (rectContained(corners, parcel)) return { cx, cz, w, d, angle };
      w *= .9; d *= .9;
    }
  }
  return null;
}

function interiorCandidates(parcel, angle, box) {
  const candidates = [], seen = new Set();
  const add = (x, z) => {
    if (!pointInPolygon(x, z, parcel)) return;
    const key = `${x.toFixed(9)},${z.toFixed(9)}`;
    if (seen.has(key)) return;
    seen.add(key); candidates.push([x, z]);
  };

  const [cx, cz] = centroid(parcel);
  add(cx, cz);
  add(box.cx, box.cz);

  const c = Math.cos(angle), s = Math.sin(angle);
  const nu = Math.min(24, Math.max(4, Math.ceil(box.w / 8)));
  const nv = Math.min(24, Math.max(4, Math.ceil(box.d / 8)));
  for (let iv = 1; iv <= nv; iv++) {
    const v = box.v0 + box.d * iv / (nv + 1);
    for (let iu = 1; iu <= nu; iu++) {
      const u = box.u0 + box.w * iu / (nu + 1);
      add(u * c - v * s, u * s + v * c);
    }
  }
  return candidates;
}

// For a simple polygon, a convex rectangle with all corners inside is
// contained unless one of its edges crosses the polygon boundary. Checking
// those crossings catches concave notches without changing convex placement.
function rectContained(corners, parcel) {
  if (!corners.every(([x, z]) => pointInPolygon(x, z, parcel))) return false;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    for (let j = 0; j < parcel.length; j++) {
      const p = parcel[j], q = parcel[(j + 1) % parcel.length];
      if (segmentsTouch(a[0], a[1], b[0], b[1], p[0], p[1], q[0], q[1])) return false;
    }
  }
  return true;
}
