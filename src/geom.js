// Shared 2D geometry for the road graph and everything derived from it.
//
// Robustness policy (see docs/V2-ROAD-GRAPH.md §8):
//   - every committed coordinate is quantized to QUANTUM, so cross products
//     of committed points are exact in float64 and `orient` never wobbles;
//   - there is exactly one orientation predicate and one segment-intersection
//     routine, used by growth, face extraction and the test harness alike.
//
// Points are [x, z] arrays; polygons are arrays of points, implicitly closed.

export const QUANTUM = 0.25;
export const EPS = 1e-9;

export function quantize(v) { return Math.round(v / QUANTUM) * QUANTUM; }

// Sign of the cross product (b - a) × (c - a): +1 left turn, -1 right, 0 collinear.
export function orient(ax, az, bx, bz, cx, cz) {
  const v = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
}

export function dist(ax, az, bx, bz) { return Math.hypot(bx - ax, bz - az); }

// Smallest signed difference between two angles, in (-π, π].
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

// Unsigned angle between two directions (0..π).
export function angleBetween(a, b) { return Math.abs(angleDiff(a, b)); }

// Parametric intersection of segments p→p2 and q→q2. Returns {t, u, x, z}
// with t along p→p2 and u along q→q2, both in [0,1] (with tolerance), or
// null when parallel / not intersecting. Collinear overlaps return null;
// `segmentsTouch` handles those for the invariant checker.
export function segIntersect(px, pz, p2x, p2z, qx, qz, q2x, q2z, tol = 1e-7) {
  const rx = p2x - px, rz = p2z - pz, sx = q2x - qx, sz = q2z - qz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < EPS) return null;
  const wx = qx - px, wz = qz - pz;
  const t = (wx * sz - wz * sx) / den;
  const u = (wx * rz - wz * rx) / den;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return { t, u, x: px + rx * t, z: pz + rz * t };
}

// True when two segments share any point other than exactly-equal endpoints.
// Exact for quantized inputs (all products are exact). Used by the planarity
// invariant; growth uses segIntersect + explicit node exclusions instead.
export function segmentsTouch(ax, az, bx, bz, cx, cz, dx, dz) {
  const shared = (ax === cx && az === cz) + (ax === dx && az === dz) + (bx === cx && bz === cz) + (bx === dx && bz === dz);
  if (shared === 2) return true; // duplicate edge
  const o1 = orient(ax, az, bx, bz, cx, cz), o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az), o4 = orient(cx, cz, dx, dz, bx, bz);
  if (shared === 1) {
    // Sharing one endpoint: only a problem if collinear and overlapping.
    if (o1 !== 0 || o2 !== 0) return false;
    return onSegmentCollinear(ax, az, bx, bz, cx, cz, dx, dz);
  }
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && inBox(ax, az, bx, bz, cx, cz)) return true;
  if (o2 === 0 && inBox(ax, az, bx, bz, dx, dz)) return true;
  if (o3 === 0 && inBox(cx, cz, dx, dz, ax, az)) return true;
  if (o4 === 0 && inBox(cx, cz, dx, dz, bx, bz)) return true;
  return false;
}
function inBox(ax, az, bx, bz, px, pz) {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && pz >= Math.min(az, bz) && pz <= Math.max(az, bz);
}
function onSegmentCollinear(ax, az, bx, bz, cx, cz, dx, dz) {
  // Collinear segments sharing an endpoint overlap iff the other endpoints
  // lie on the same side of the shared point.
  const sx = ax === cx && az === cz ? ax : ax === dx && az === dz ? ax : bx;
  const sz = ax === cx && az === cz ? az : ax === dx && az === dz ? az : bz;
  const o1x = (ax === sx && az === sz) ? bx : ax, o1z = (ax === sx && az === sz) ? bz : az;
  const o2x = (cx === sx && cz === sz) ? dx : cx, o2z = (cx === sx && cz === sz) ? dz : cz;
  return (o1x - sx) * (o2x - sx) + (o1z - sz) * (o2z - sz) > 0;
}

// Distance from point to segment, plus the parameter of the closest point.
export function pointSegDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + vx * t, z = az + vz * t;
  return { d: Math.hypot(px - x, pz - z), t, x, z };
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------
export function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
export function area(poly) { return Math.abs(signedArea(poly)); }

export function centroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f; a += f;
  }
  if (Math.abs(a) < EPS) {
    // Degenerate: fall back to the vertex mean.
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function bbox(poly) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
}

export function rectPoly(r) {
  return [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
}

export function pointInPolygon(px, pz, poly) {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Ensure counter-clockwise (positive signed area) winding.
export function ccw(poly) { return signedArea(poly) < 0 ? poly.slice().reverse() : poly; }

// Simple-polygon check: no two non-adjacent edges touch. O(n²), n is small.
export function isSimple(poly) {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j], d = poly[(j + 1) % n];
      if (segmentsTouch(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return false;
    }
  }
  return true;
}

// Length of the boundary shared by two adjacent simple polygons. Collinear
// overlaps are measured rather than relying on identical vertex layouts: a
// split edge on one parcel may correspond to several edges on its neighbour.
export function sharedBoundaryLength(a, b, tol = 1e-6) {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length];
      const overlap = collinearOverlap(p, q, r, s, tol);
      if (overlap) total += overlap.length;
    }
  }
  return total;
}

// Union two non-overlapping simple polygons that share boundary. Boundary
// edges are split at overlap endpoints, the opposed shared pieces are
// removed, and the remaining directed pieces are stitched into one ring.
// Returns null for point contacts, disjoint polygons, holes, or an invalid
// union, allowing callers to retain their courtyard fallback.
export function mergeAdjacentPolygons(a, b, tol = 1e-6) {
  if (!a?.length || !b?.length) return null;
  const left = ccw(a), right = ccw(b);
  const as = splitBoundaryAtOverlaps(left, right, tol);
  const bs = splitBoundaryAtOverlaps(right, left, tol);
  const dropA = new Uint8Array(as.length), dropB = new Uint8Array(bs.length);
  let shared = 0;

  for (let i = 0; i < as.length; i++) {
    for (let j = 0; j < bs.length; j++) {
      if (dropB[j]) continue;
      if (!samePoint(as[i].a, bs[j].b, tol) || !samePoint(as[i].b, bs[j].a, tol)) continue;
      dropA[i] = 1; dropB[j] = 1;
      shared += Math.hypot(as[i].b[0] - as[i].a[0], as[i].b[1] - as[i].a[1]);
      break;
    }
  }
  if (shared <= tol) return null;

  const boundary = [];
  for (let i = 0; i < as.length; i++) if (!dropA[i]) boundary.push(as[i]);
  for (let i = 0; i < bs.length; i++) if (!dropB[i]) boundary.push(bs[i]);
  if (boundary.length < 3) return null;

  const used = new Uint8Array(boundary.length);
  const ring = [boundary[0].a];
  let current = boundary[0].b;
  used[0] = 1;
  ring.push(current);
  for (let k = 1; k < boundary.length; k++) {
    let next = -1;
    for (let i = 0; i < boundary.length; i++) {
      if (!used[i] && samePoint(boundary[i].a, current, tol)) { next = i; break; }
    }
    if (next < 0) return null;
    used[next] = 1;
    current = boundary[next].b;
    ring.push(current);
  }
  if (!samePoint(ring[ring.length - 1], ring[0], tol)) return null;
  ring.pop();

  let merged = simplifyRing(ring, tol);
  if (signedArea(merged) < 0) merged = merged.reverse();
  const expected = area(left) + area(right);
  if (merged.length < 3 || !isSimple(merged) || area(merged) <= EPS) return null;
  if (Math.abs(area(merged) - expected) > Math.max(1e-5, expected * 1e-8)) return null;
  return merged;
}

function collinearOverlap(a, b, c, d, tol) {
  const vx = b[0] - a[0], vz = b[1] - a[1], len = Math.hypot(vx, vz);
  if (len <= tol) return null;
  const crossC = vx * (c[1] - a[1]) - vz * (c[0] - a[0]);
  const crossD = vx * (d[1] - a[1]) - vz * (d[0] - a[0]);
  if (Math.abs(crossC) > tol * len || Math.abs(crossD) > tol * len) return null;
  const l2 = len * len;
  const tc = ((c[0] - a[0]) * vx + (c[1] - a[1]) * vz) / l2;
  const td = ((d[0] - a[0]) * vx + (d[1] - a[1]) * vz) / l2;
  const t0 = Math.max(0, Math.min(tc, td)), t1 = Math.min(1, Math.max(tc, td));
  if ((t1 - t0) * len <= tol) return null;
  return { t0, t1, length: (t1 - t0) * len };
}

function splitBoundaryAtOverlaps(poly, other, tol) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ts = [0, 1];
    for (let j = 0; j < other.length; j++) {
      const c = other[j], d = other[(j + 1) % other.length];
      const overlap = collinearOverlap(a, b, c, d, tol);
      if (overlap) ts.push(overlap.t0, overlap.t1);
    }
    ts.sort((x, y) => x - y);
    const unique = ts.filter((t, k) => !k || Math.abs(t - ts[k - 1]) > tol);
    for (let k = 0; k + 1 < unique.length; k++) {
      const t0 = unique[k], t1 = unique[k + 1];
      if (t1 - t0 <= tol) continue;
      out.push({
        a: [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
        b: [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
      });
    }
  }
  return out;
}

function samePoint(a, b, tol) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}

function simplifyRing(poly, tol) {
  const out = poly.slice();
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (ab <= tol || bc <= tol || Math.abs(cross) <= tol * (ab + bc)) {
        out.splice(i, 1); changed = true; break;
      }
    }
  }
  return out;
}

// Sutherland–Hodgman clip against the half-plane  nx*x + nz*z <= c.
export function clipHalfPlane(poly, nx, nz, c) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const fp = nx * p[0] + nz * p[1] - c, fq = nx * q[0] + nz * q[1] - c;
    const pin = fp <= 0, qin = fq <= 0;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return dedupe(out);
}

// Half-plane split of a simple polygon into possibly several pieces. Unlike
// Sutherland–Hodgman this never stitches disjoint pieces together across a
// concavity: inside chains are paired along the cut line by parity.
export function clipHalfPlaneMulti(poly, nx, nz, c) {
  const n = poly.length;
  const f = poly.map(p => nx * p[0] + nz * p[1] - c);
  let start = f.findIndex(v => v > 0);
  if (start < 0) return [poly.slice()];
  if (!f.some(v => v <= 0)) return [];
  const along = p => -nz * p[0] + nx * p[1];
  const chains = [];
  let cur = null;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n, j = (i + 1) % n;
    const p = poly[i], q = poly[j], fp = f[i], fq = f[j];
    const pin = fp <= 0, qin = fq <= 0;
    if (pin && cur) cur.pts.push(p);
    if (pin !== qin) {
      const t = fp / (fp - fq);
      const x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (qin) { cur = { pts: [x], entry: along(x) }; }
      else { cur.pts.push(x); cur.exit = along(x); chains.push(cur); cur = null; }
    }
  }
  if (cur) { chains.push(cur); }
  if (!chains.length) return [];
  // Sort all crossings along the line; consecutive pairs bound interior spans.
  const cross = [];
  chains.forEach((ch, ci) => { cross.push({ s: ch.entry, ci, kind: 'entry' }); cross.push({ s: ch.exit, ci, kind: 'exit' }); });
  cross.sort((a, b) => a.s - b.s || (a.kind === 'exit' ? -1 : 1));
  const partner = new Map(); // "ci:exit" → chain index whose entry follows
  for (let k = 0; k + 1 < cross.length; k += 2) {
    const a = cross[k], b = cross[k + 1];
    if (a.kind === 'exit' && b.kind === 'entry') partner.set(a.ci, b.ci);
    else if (b.kind === 'exit' && a.kind === 'entry') partner.set(b.ci, a.ci);
    else partner.set(a.kind === 'exit' ? a.ci : b.ci, a.kind === 'entry' ? a.ci : b.ci);
  }
  const used = new Uint8Array(chains.length), out = [];
  for (let ci = 0; ci < chains.length; ci++) {
    if (used[ci]) continue;
    const pts = [];
    let k = ci, guard = 0;
    while (!used[k] && guard++ <= chains.length) {
      used[k] = 1;
      pts.push(...chains[k].pts);
      const nxt = partner.get(k);
      if (nxt === undefined) break;
      k = nxt;
    }
    const clean = dedupe(pts);
    if (clean.length >= 3) out.push(clean);
  }
  return out;
}

function dedupe(poly, eps = 1e-6) {
  const out = [];
  for (const p of poly) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[0] - p[0]) < eps && Math.abs(l[1] - p[1]) < eps) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < eps && Math.abs(f[1] - l[1]) < eps) out.pop();
  }
  return out;
}

// Oriented bounding box using the longest edge's direction (blocks are
// street-aligned, so this matches rotating calipers nearly always).
export function obb(poly, angle = null) {
  if (angle === null) {
    let best = -1;
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const l = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (l > best) { best = l; angle = Math.atan2(q[1] - p[1], q[0] - p[0]); }
    }
  }
  const c = Math.cos(angle), s = Math.sin(angle);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of poly) {
    const u = x * c + z * s, v = -x * s + z * c;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const w = u1 - u0, d = v1 - v0;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { angle, w, d, cx: cu * c - cv * s, cz: cu * s + cv * c, u0, u1, v0, v1 };
}

// Corners of an oriented rectangle centred at (cx, cz) with its w-axis at `angle`.
export function orientedRect(cx, cz, w, d, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const hw = w / 2, hd = d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [cx + u * c - v * s, cz + u * s + v * c]);
}

// Inward offset with per-edge distances (miter joins with a limit). Returns
// the offset polygon or null when it degenerates. Input must be CCW.
export function offsetPolygon(poly, dists, miterLimit = 3) {
  const n = poly.length;
  if (n < 3) return null;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz);
    if (l < EPS) return null;
    dx /= l; dz /= l;
    // Inward normal of a CCW polygon is the left normal (-dz, dx).
    const nx = -dz, nz = dx, d = dists[i];
    lines.push({ px: p[0] + nx * d, pz: p[1] + nz * d, dx, dz });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n], b = lines[i];
    const den = a.dx * b.dz - a.dz * b.dx;
    const orig = poly[i];
    if (Math.abs(den) < 1e-6) { out.push([b.px, b.pz]); continue; }
    const t = ((b.px - a.px) * b.dz - (b.pz - a.pz) * b.dx) / den;
    let x = a.px + a.dx * t, z = a.pz + a.dz * t;
    const limit = Math.max(dists[i], dists[(i - 1 + n) % n]) * miterLimit + 1;
    const far = Math.hypot(x - orig[0], z - orig[1]);
    if (far > limit) {
      // Bevel: pull the miter back toward the corner along the bisector.
      const k = limit / far;
      x = orig[0] + (x - orig[0]) * k; z = orig[1] + (z - orig[1]) * k;
    }
    out.push([x, z]);
  }
  const clean = dedupe(out);
  if (clean.length < 3) return null;
  if (signedArea(clean) <= 0) return null;
  if (!isSimple(clean)) return null;
  return clean;
}

// Inward offset that survives edge events: the polygon is shrunk in small
// steps and any edge that collapses (length → 0 or direction flips) is
// removed before the next step, which is exactly what a straight skeleton
// does for edge events, discretized. The single-ring entry point deliberately
// retains its old contract; shrinkPolygonMulti additionally polygonizes the
// bounded split-event case where the final wavefront pinches into components.
export function shrinkPolygon(poly, dists, step = 1.5) {
  const clean = shrinkWavefront(poly, dists, step);
  if (!clean || signedArea(clean) <= 0 || !isSimple(clean)) return null;
  return clean;
}

export function shrinkPolygonMulti(poly, dists, step = 1.5) {
  const wavefront = shrinkWavefront(poly, dists, step);
  if (!wavefront) return [];
  if (signedArea(wavefront) > 0 && isSimple(wavefront)) return [wavefront];
  return polygonizeSplitWavefront(wavefront, poly, dists);
}

function shrinkWavefront(poly, dists, step) {
  const n0 = poly.length;
  if (n0 < 3) return null;
  // Each edge: origin point on the (moving) line, unit direction, inward normal, remaining distance.
  let E = [];
  for (let i = 0; i < n0; i++) {
    const p = poly[i], q = poly[(i + 1) % n0];
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz);
    if (l < EPS) continue;
    dx /= l; dz /= l;
    E.push({ px: p[0], pz: p[1], dx, dz, nx: -dz, nz: dx, rem: dists[i] });
  }
  const vertex = (a, b) => { // intersection of lines a and b (b follows a)
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-9) return [b.px, b.pz];
    const t = ((b.px - a.px) * b.dz - (b.pz - a.pz) * b.dx) / den;
    return [a.px + a.dx * t, a.pz + a.dz * t];
  };
  let guard = 0;
  while (E.length >= 3 && E.some(e => e.rem > 1e-9) && guard++ < 400) {
    const s = Math.min(step, Math.max(...E.map(e => e.rem)));
    for (const e of E) { const m = Math.min(s, e.rem); e.px += e.nx * m; e.pz += e.nz * m; e.rem -= m; }
    // Remove collapsed edges, repeatedly (one collapse can trigger the next).
    let changed = true;
    while (changed && E.length >= 3) {
      changed = false;
      const n = E.length;
      for (let i = 0; i < n; i++) {
        const a = E[(i - 1 + n) % n], b = E[i], c = E[(i + 1) % n];
        const v0 = vertex(a, b), v1 = vertex(b, c);
        const ex = v1[0] - v0[0], ez = v1[1] - v0[1];
        const len = Math.hypot(ex, ez);
        if (len < 0.3 || ex * b.dx + ez * b.dz < 0) { E.splice(i, 1); changed = true; break; }
      }
    }
  }
  if (E.length < 3) return null;
  const out = [];
  for (let i = 0; i < E.length; i++) out.push(vertex(E[(i - 1 + E.length) % E.length], E[i]));
  const clean = dedupe(out);
  if (clean.length < 3) return null;
  return clean;
}

// A split event leaves the discretized wavefront as a self-crossing walk.
// Recursively cut that walk at proper segment intersections, then retain the
// positive simple lobes that remain inside the source face. This is purposely
// bounded to split events; holes and general polygon booleans stay out of the
// offset contract.
function polygonizeSplitWavefront(wavefront, source, dists) {
  const pending = [wavefront], out = [];
  let guard = 0;
  while (pending.length && guard++ < 64) {
    const ring = dedupe(pending.pop());
    if (ring.length < 3) continue;
    const hit = firstSelfIntersection(ring);
    if (hit) {
      const a = [hit.point];
      for (let k = hit.i + 1; k <= hit.j; k++) a.push(ring[k]);
      const b = [hit.point];
      for (let k = hit.j + 1; k < ring.length; k++) b.push(ring[k]);
      for (let k = 0; k <= hit.i; k++) b.push(ring[k]);
      pending.push(dedupe(a), dedupe(b));
      continue;
    }
    let clean = simplifyRing(ring, 1e-6);
    if (clean.length < 3 || area(clean) <= EPS || !isSimple(clean)) continue;
    if (signedArea(clean) < 0) clean = clean.reverse();
    if (!ringInsideSource(clean, source) || !ringClearsSourceEdges(clean, source, dists)) continue;
    out.push(clean);
  }
  return out.sort((a, b) => area(b) - area(a));
}

function ringClearsSourceEdges(ring, source, dists, tol = .35) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const samples = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k <= samples; k++) {
      const t = k / samples, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      for (let j = 0; j < source.length; j++) {
        const p = source[j], q = source[(j + 1) % source.length];
        if (pointSegDist(x, z, p[0], p[1], q[0], q[1]).d < dists[j] - tol) return false;
      }
    }
  }
  return true;
}

function firstSelfIntersection(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j], d = poly[(j + 1) % n];
      const hit = segIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1], 1e-8);
      if (!hit) continue;
      const endpointOnly = (hit.t <= 1e-8 || hit.t >= 1 - 1e-8) && (hit.u <= 1e-8 || hit.u >= 1 - 1e-8);
      if (!endpointOnly) return { i, j, point: [hit.x, hit.z] };
    }
  }
  return null;
}

function ringInsideSource(ring, source, tol = 1e-5) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (const p of [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]) {
      if (!pointInPolygon(p[0], p[1], source) && distToBoundary(p[0], p[1], source) > tol) return false;
    }
  }
  return true;
}

export function polyIntersectsRect(poly, r) {
  const b = bbox(poly);
  if (!(b.x < r.x + r.w && b.x + b.w > r.x && b.z < r.z + r.d && b.z + b.d > r.z)) return false;
  const rp = rectPoly(r);
  for (const p of poly) if (p[0] > r.x && p[0] < r.x + r.w && p[1] > r.z && p[1] < r.z + r.d) return true;
  for (const p of rp) if (pointInPolygon(p[0], p[1], poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], q = poly[(i + 1) % poly.length];
    for (let j = 0; j < 4; j++) {
      const c = rp[j], d = rp[(j + 1) % 4];
      if (segIntersect(a[0], a[1], q[0], q[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  return false;
}

// Keep the largest piece of `poly` outside rect `r` (expanded by pad), by
// clipping against one of the four half-planes. Mirrors trimAgainst() for
// rectangles: a corridor consumes its right-of-way, not the whole lot.
export function trimPolyAgainstRect(poly, r, pad = 2, minArea = 100) {
  if (!polyIntersectsRect(poly, { x: r.x - pad, z: r.z - pad, w: r.w + pad * 2, d: r.d + pad * 2 })) return poly;
  const opts = [
    ...clipHalfPlaneMulti(poly, 1, 0, r.x - pad),
    ...clipHalfPlaneMulti(poly, -1, 0, -(r.x + r.w + pad)),
    ...clipHalfPlaneMulti(poly, 0, 1, r.z - pad),
    ...clipHalfPlaneMulti(poly, 0, -1, -(r.z + r.d + pad)),
  ];
  let best = null, bestA = minArea;
  for (const o of opts) {
    if (o.length < 3) continue;
    const a = area(o);
    if (a > bestA) { bestA = a; best = o; }
  }
  return best;
}

// Point-to-polygon-boundary distance.
export function distToBoundary(px, pz, poly) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const d = pointSegDist(px, pz, a[0], a[1], b[0], b[1]).d;
    if (d < best) best = d;
  }
  return best;
}
