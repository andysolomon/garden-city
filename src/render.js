// Shared three.js viewer: scene, orthographic camera, controls, render loop.
// Renderers (solid.js, ink.js) only populate viewer.world from a CityModel.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { orientedRect, pointInPolygon, pointSegDist } from './geom.js';

export class Viewer {
  constructor(viewport) {
    this.viewport = viewport;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 4000);
    this.camera.position.set(720, 720, 720);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .055;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 35, 0);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = .75;
    this.controls.minZoom = .45;
    this.controls.maxZoom = 4.5;
    this.controls.saveState();

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x59606a, 2.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sun.position.set(420, 700, 240);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -650; this.sun.shadow.camera.right = 650;
    this.sun.shadow.camera.top = 650; this.sun.shadow.camera.bottom = -650;
    this.scene.add(this.sun);

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.timer = new THREE.Timer();
    this.animation = null;
    this.animationElapsed = 0;
    this.animationLastTime = null;
    const loop = time => {
      requestAnimationFrame(loop);
      this.timer.update();
      if (this.animation) {
        const now = (Number.isFinite(time) ? time : performance.now()) / 1000;
        if (this.animationLastTime === null) this.animationLastTime = now;
        else {
          this.animationElapsed += Math.max(0, now - this.animationLastTime);
          this.animationLastTime = now;
        }
        this.animation(this.animationElapsed);
      }
      this.controls.update(this.timer.getDelta());
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  clearWorld() {
    this.setAnimation(null);
    while (this.world.children.length) {
      const o = this.world.children.pop();
      o.traverse?.(n => {
        if (n.geometry) n.geometry.dispose?.();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m.dispose?.());
      });
    }
  }

  // Install one renderer-owned per-frame update. The callback receives time
  // since installation, so rerendering restarts motion without mutating the
  // deterministic CityModel.
  setAnimation(update) {
    this.animation = typeof update === 'function' ? update : null;
    this.animationElapsed = 0;
    this.animationLastTime = null;
  }

  setFrustum(aspect) {
    const view = 920;
    this.camera.left = -view * aspect / 2;
    this.camera.right = view * aspect / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.setFrustum(w / h);
  }

  fit() {
    this.camera.zoom = window.innerWidth < 720 ? .72 : 1.0;
    this.camera.position.set(720, 720, 720);
    this.controls.target.set(0, 45, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // Render the current scene once at an explicit pixel size (for exports),
  // then restore the on-screen setup.
  renderToSize(w, h) {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.setFrustum(w / h);
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    const restore = () => this.resize();
    return { canvas, restore };
  }
}

export function mat(color, rough = .86) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: .04 });
}

export function addBox(group, spec, material, y = 0) {
  const geo = new THREE.BoxGeometry(spec.w, spec.h ?? 1, spec.d);
  const m = new THREE.Mesh(geo, material);
  m.position.set(spec.x + spec.w / 2, y + (spec.h ?? 1) / 2, spec.z + spec.d / 2);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// Terrain drape (E3). Every ground polygon is triangulated with earcut, then
// each triangle is recursively midpoint-split DRAPE_LEVELS times (4^levels
// sub-triangles) and every generated vertex is displaced by the model's
// elevation field. Shared edges are split identically on both sides so
// neighbouring polygons stay crack-free. Without a sampler the original flat
// single-triangle path runs unchanged.
// ---------------------------------------------------------------------------
export const DRAPE_LEVELS = 2;
export const DRAPE_EDGE_SEGMENTS = 1 << DRAPE_LEVELS; // pieces per polygon edge
// Recursive subdivision always keeps the two baseline levels above, then
// adds levels until the longest triangulation span is reasonably short.
// Applying the resulting depth to the complete geometry (rather than to one
// triangle at a time) keeps every shared edge conforming.
export const DRAPE_TARGET_EDGE = 32;
export const DRAPE_MAX_LEVELS = 6;

// Land within this distance of a shoreline eases down to sea level, so the
// drape meets the water without a cliff and never lifts the water itself.
export const SHORE_BLEND = 36;
// Bridge decks clear the higher bank surface by this much; elevated rail
// clears the highest surface along its alignment by RAIL_CLEARANCE (and never
// drops below its flat datum).
export const BRIDGE_CLEARANCE = 2.8;
export const BRIDGE_FLAT_Y = 3.4;
export const RAIL_CLEARANCE = 8;
export const RAIL_FLAT_Y = 15;
// Spacing of the leaf-triangle edge samples used for shoreline rejection.
export const ANCHOR_STEP = 10;
// Fine spacing of the interior/edge samples used to anchor a footprint, so
// interior extrema between coarse samples cannot float a base or sink a roof.
export const ANCHOR_FINE_STEP = 2;
// Fine sampling of complete bridge spans (axis × deck width) and complete
// elevated-rail alignments (axis × occupied width), plus a small safety margin
// covering the residual between fine samples and the continuous surface.
export const CLEARANCE_SAMPLE_STEP = 2;
export const CLEARANCE_MARGIN = .25;
// Half of the width an elevated line occupies around its axis (rails at ±6,
// sleepers/cross ties at ±8, supports at ±4).
export const RAIL_HALF_WIDTH = 9;
// Both renderers use this exact terrain datum. Sea models retain the island
// lift used by the solid renderer; other terrain sits just above the plate.
export const LAND_DATUM = .6;
export const SEA_LAND_LIFT = 1.2;
export const WATER_GAP = .15;

// The surface sampler for a model: (x, z) → ground lift in metres, or null
// when the model carries no elevation field (legacy engine, tests, flat).
// Water-safe: over water the lift is exactly 0 (sea level), and land within
// SHORE_BLEND of a shore eases smoothly to 0 using the water field's signed
// distance (negative in water), so banks stay continuous with the water.
export function elevationSampler(model) {
  const f = model?.fields?.elevation;
  if (typeof f !== 'function') return null;
  const sdf = typeof model.fields?.water?.sdf === 'function' ? model.fields.water.sdf : null;
  const sample = (x, z) => {
    const v = f(x, z);
    if (!Number.isFinite(v)) return 0;
    if (!sdf) return v;
    const d = sdf(x, z);
    if (!(d > 0)) return 0;
    if (d >= SHORE_BLEND) return v;
    const t = d / SHORE_BLEND;
    return v * t * t * (3 - 2 * t);
  };
  // Geometry consumers can use the same mask that produced the lift. Keeping
  // it on the function preserves the simple (x,z) sampler API.
  sample.sdf = sdf;
  sample.isLand = sdf ? (x, z) => sdf(x, z) >= 0 : () => true;
  return sample;
}

// Ground height at a point: base datum plus the sampled lift (0 when flat).
export function groundY(sample, x, z, y = 0) {
  return y + (sample ? sample(x, z) : 0);
}

// The one land datum every renderer object stands on: `offset` (the island
// lift plus the terrain plate thickness) plus the masked lift. Null when the
// model is flat so callers keep their original constant datums.
export function landSurface(sample, offset = 0) {
  if (!sample) return null;
  const surface = (x, z) => offset + sample(x, z);
  surface.sdf = sample.sdf;
  surface.isLand = sample.isLand;
  return surface;
}

export function landDatum(model) {
  return LAND_DATUM + ((model?.water || []).some(w => w.type === 'sea') ? SEA_LAND_LIFT : 0);
}

// One renderer-neutral terrain frame. `lift` and `surface` stay null for
// legacy flat models, preserving their historic constant object datums.
export function terrainFrame(model) {
  const lift = elevationSampler(model);
  const datum = landDatum(model);
  return { datum, lift, surface: landSurface(lift, datum), waterTop: datum - WATER_GAP };
}

export function drapeDepthForSpan(span, levels = DRAPE_LEVELS, target = DRAPE_TARGET_EDGE) {
  const base = Math.max(DRAPE_LEVELS, Number.isFinite(levels) ? Math.floor(levels) : DRAPE_LEVELS);
  if (!(span > 0) || !(target > 0)) return Math.min(DRAPE_MAX_LEVELS, base);
  return Math.min(DRAPE_MAX_LEVELS, Math.max(base, Math.ceil(Math.log2(span / target))));
}

export function drapeSegmentsForSpan(span, levels = DRAPE_LEVELS) {
  return 1 << drapeDepthForSpan(span, levels);
}

// Sample points covering a footprint: its corners, its edges at ≤ `step`
// spacing, and an interior grid at `step` spacing (plus the centroid). The
// grid is centred on the footprint's bounding box and inset half a step from
// its rim so interior extrema of small footprints are still visited.
export function footprintSamples(corners, step = ANCHOR_FINE_STEP) {
  const pts = [];
  const n = corners.length;
  const spacing = step > 0 ? step : ANCHOR_FINE_STEP;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n];
    cx += a[0] / n; cz += a[1] / n;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let k = 0; k < pieces; k++) {
      const t = k / pieces;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  pts.push([cx, cz]);
  if (n >= 3) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of corners) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const nx = Math.max(1, Math.ceil((x1 - x0) / spacing)), nz = Math.max(1, Math.ceil((z1 - z0) / spacing));
    const sx = (x1 - x0) / nx, sz = (z1 - z0) / nz;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x = x0 + sx * (i + .5), z = z0 + sz * (j + .5);
      if (pointInPolygon(x, z, corners)) pts.push([x, z]);
    }
  }
  return pts;
}

// Anchor a footprint (list of [x, z] corners) on the surface: the base sits at
// the lowest sampled point so nothing floats, and the height is stretched by
// the sampled relief so the roof keeps its intended level above the highest
// ground under it (nothing sinks).
export function anchorFootprint(sample, corners, y, h, step = ANCHOR_FINE_STEP) {
  if (!sample || !corners?.length) return { y, h };
  let min = Infinity, max = -Infinity;
  for (const [x, z] of footprintSamples(corners, step)) {
    const v = sample(x, z);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { y: y + min, h: h + Math.max(0, max - min) };
}

// A support standing on the surface with its top pinned at `top`: base at the
// lowest sampled point of its footprint, height reaching `top` (never less
// than `minH` so it stays readable where the ground nearly meets the deck).
export function pillar(sample, spec, top, minH = 1.5) {
  const corners = [[spec.x, spec.z], [spec.x + spec.w, spec.z], [spec.x + spec.w, spec.z + spec.d], [spec.x, spec.z + spec.d]];
  const base = sample ? anchorFootprint(sample, corners, 0, 0).y : (spec.y || 0);
  const y = Math.min(base, top - minH);
  return { ...spec, y, h: top - y };
}

// Bridge deck datum: at least the flat datum, and at least the highest sampled
// surface under the complete span plus BRIDGE_CLEARANCE (+ CLEARANCE_MARGIN).
// A fine grid over both the axis and the deck width catches interior ridges
// and shoreline ramps as well as high banks. Legacy {x, z, w, d} bridges are
// treated as axis-aligned spans along their longer side.
// A bridge with an explicit axis: {a, b, cx, cz, len, width, angle}. Legacy
// {x, z, w, d} bridges become axis-aligned spans along their longer side, so
// deck height and deck lookup agree on the same geometry.
export function normalizeBridge(b) {
  if (!b) return null;
  let n = b;
  if (b.cx === undefined && b.x !== undefined) {
    const alongX = (b.w || 0) >= (b.d || 0);
    n = { ...b, cx: b.x + b.w / 2, cz: b.z + b.d / 2, len: alongX ? b.w : b.d, width: alongX ? b.d : b.w, angle: alongX ? 0 : Math.PI / 2 };
  }
  const angle = n.angle || 0, len = n.len || 0;
  const a = n.a || [n.cx - Math.cos(angle) * len / 2, n.cz - Math.sin(angle) * len / 2];
  const end = n.b || [n.cx + Math.cos(angle) * len / 2, n.cz + Math.sin(angle) * len / 2];
  return (n.a && n.b && n === b) ? b : { ...n, a, b: end, angle, len };
}

export function bridgeDeckY(sample, b, flatY = BRIDGE_FLAT_Y, clearance = BRIDGE_CLEARANCE, step = CLEARANCE_SAMPLE_STEP, margin = CLEARANCE_MARGIN) {
  if (!sample || !b) return flatY;
  b = normalizeBridge(b);
  const spacing = step > 0 ? step : CLEARANCE_SAMPLE_STEP;
  const angle = b.angle || 0;
  const a = b.a, end = b.b;
  const dx = end[0] - a[0], dz = end[1] - a[1], len = Math.hypot(dx, dz);
  const ux = len ? dx / len : Math.cos(angle), uz = len ? dz / len : Math.sin(angle);
  const nx = -uz, nz = ux, width = Math.max(0, b.width || 0);
  const along = Math.max(1, Math.ceil(len / spacing));
  const across = Math.max(1, Math.ceil(width / spacing));
  let hi = -Infinity;
  for (let i = 0; i <= along; i++) {
    const t = i / along, cx = a[0] + dx * t, cz = a[1] + dz * t;
    for (let j = 0; j <= across; j++) {
      const offset = width * (j / across - .5);
      hi = Math.max(hi, sample(cx + nx * offset, cz + nz * offset));
    }
  }
  return Math.max(flatY, hi + clearance + Math.max(0, margin || 0));
}

// (x, z) → deck datum of the nearest bridge axis, for cars flagged `bridge`.
export function bridgeDeckLookup(model, sample, flatY = BRIDGE_FLAT_Y, clearance = BRIDGE_CLEARANCE) {
  const decks = (model.bridges || []).map(b => ({ b: normalizeBridge(b), y: bridgeDeckY(sample, b, flatY, clearance) }));
  if (!decks.length || !sample) return () => flatY;
  return (x, z) => {
    let best = null, bd = Infinity;
    for (const d of decks) {
      const dist = pointSegDist(x, z, d.b.a[0], d.b.a[1], d.b.b[0], d.b.b[1]).d;
      if (dist < bd) { bd = dist; best = d; }
    }
    return best ? best.y : flatY;
  };
}

// Elevated rail datum: max(flat datum, highest surface sampled over the
// complete alignment × occupied width + RAIL_CLEARANCE + CLEARANCE_MARGIN).
// `step` is the sample spacing along and across the axis; `halfWidth` is the
// lateral half-extent of the sampled strip (rails, sleepers and supports).
export function elevatedRailY(sample, r, flatY = RAIL_FLAT_Y, clearance = RAIL_CLEARANCE, step = CLEARANCE_SAMPLE_STEP, halfWidth = RAIL_HALF_WIDTH, margin = CLEARANCE_MARGIN) {
  if (!sample || !r?.extent) return flatY;
  const spacing = step > 0 ? step : CLEARANCE_SAMPLE_STEP;
  const half = Math.max(0, halfWidth || 0);
  const P = (q, o) => (r.vertical ? [r.offset + o, q] : [q, r.offset + o]);
  let hi = -Infinity;
  const { from, to } = r.extent;
  const n = Math.max(1, Math.ceil(Math.abs(to - from) / spacing));
  const m = Math.max(1, Math.ceil(2 * half / spacing));
  for (let i = 0; i <= n; i++) {
    const q = from + (to - from) * i / n;
    for (let j = 0; j <= m; j++) {
      const [x, z] = P(q, half * (2 * j / m - 1));
      hi = Math.max(hi, sample(x, z));
    }
  }
  return Math.max(flatY, hi + clearance + Math.max(0, margin || 0));
}

// Many axis-aligned boxes ({x, z, w, d, h, y}) merged into one mesh, so a
// draped rail run chopped into short pieces still costs one draw call.
export function addBoxes(group, specs, material) {
  if (!specs.length) return null;
  const geometries = specs.map(s => new THREE.BoxGeometry(s.w, s.h ?? 1, s.d)
    .translate(s.x + s.w / 2, (s.y || 0) + (s.h ?? 1) / 2, s.z + s.d / 2));
  const geo = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  if (geometries.length > 1) geometries.forEach(g => g.dispose());
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

// One BufferGeometry for many polygons (roads, parks, blocks…) lying on the
// XZ plane at height y, optionally draped over `sample`. Keeps ground fills
// to one draw call per layer.
export function flatPolygonsGeometry(polys, y = 0, sample = null, levels = DRAPE_LEVELS) {
  const pos = [], idx = [];
  const key = new Map(); // dedups split vertices along shared edges
  const vertex = (x, z) => {
    const k = x.toFixed(4) + ',' + z.toFixed(4);
    let i = key.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      key.set(k, i);
      pos.push(x, groundY(sample, x, z, y), z);
    }
    return i;
  };
  const split = (a, b, c, depth) => {
    if (depth === 0) {
      // The sampler owns the authoritative land/water mask. Leaf rejection
      // checks vertices, edge samples, and centroid so a triangle cannot span
      // water merely because its centre is on land. Geometry subdivision is
      // unchanged, retaining adaptive shared-edge vertices and continuity.
      const land = sample.isLand;
      const edgeSafe = (p, q) => {
        const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / ANCHOR_STEP));
        for (let i = 1; i < n; i++) {
          const t = i / n;
          if (!land(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)) return false;
        }
        return true;
      };
      const safe = !land || (
        land(a[0], a[1]) && land(b[0], b[1]) && land(c[0], c[1]) &&
        edgeSafe(a, b) && edgeSafe(b, c) && edgeSafe(c, a) &&
        land((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)
      );
      if (safe) {
        idx.push(a[2], c[2], b[2]);
      }
      return;
    }
    const mid = (p, q) => { const x = (p[0] + q[0]) / 2, z = (p[1] + q[1]) / 2; return [x, z, vertex(x, z)]; };
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    split(a, ab, ca, depth - 1); split(ab, b, bc, depth - 1);
    split(ca, bc, c, depth - 1); split(ab, bc, ca, depth - 1);
  };
  let base = 0, maxSpan = 0;
  const draped = [];
  for (const poly of polys) {
    if (!poly || poly.length < 3) continue;
    const contour = poly.map(p => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!sample) {
      for (const [x, z] of poly) pos.push(x, y, z);
      for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
      base += poly.length;
      continue;
    }
    const pts = poly.map(([x, z]) => [x, z, vertex(x, z)]);
    for (const t of tris) {
      const tri = [pts[t[0]], pts[t[1]], pts[t[2]]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        maxSpan = Math.max(maxSpan, Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      draped.push(tri);
    }
  }
  if (sample) {
    const depth = drapeDepthForSpan(maxSpan, levels);
    for (const [a, b, c] of draped) split(a, b, c, depth);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function polygonMesh(polys, material, y = 0, sample = null) {
  const m = new THREE.Mesh(flatPolygonsGeometry(polys, y, sample), material);
  m.receiveShadow = true;
  return m;
}

// The terrain base as a grid of quads over the plate {x, z, w, d}, so the
// two-level drape gives the plate the same vertex spacing as the grounds.
export function terrainCells(plate, n = 16) {
  const cells = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x0 = plate.x + plate.w * i / n, x1 = plate.x + plate.w * (i + 1) / n;
    const z0 = plate.z + plate.d * j / n, z1 = plate.z + plate.d * (j + 1) / n;
    cells.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
  }
  return cells;
}

// Vertical skirt around the plate perimeter, from the flat datum `y0` up to
// the draped surface, so raised ground never shows an open underside.
export function terrainSkirtGeometry(plate, y0, sample, n = 16 * DRAPE_EDGE_SEGMENTS) {
  const pos = [], idx = [];
  const corners = [[plate.x, plate.z], [plate.x + plate.w, plate.z], [plate.x + plate.w, plate.z + plate.d], [plate.x, plate.z + plate.d]];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const k = pos.length / 3;
      pos.push(x, y0, z, x, groundY(sample, x, z), z);
      if (i > 0) idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Polygon prism in world XZ, optionally with a courtyard hole. Shape-space Y
// is negated before rotating so positive extrusion depth becomes world +Y.
export function polygonPrismGeometry(footprint, courtyard, height) {
  const ring = pts => pts.map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(ring(footprint));
  if (courtyard?.length >= 3) shape.holes.push(new THREE.Path(ring(courtyard)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: false, curveSegments: 1, steps: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// Merge arbitrarily shaped building prisms into one geometry/material bucket.
// Baking each building's elevation into its vertices keeps ink fill draw calls
// bounded by palette size instead of perimeter-building count.
export function polygonPrismsGeometry(specs) {
  const geometries = specs.map(spec => {
    const geo = polygonPrismGeometry(spec.footprint, spec.courtyard, spec.h);
    geo.translate(0, spec.y || 0, 0);
    return geo;
  });
  if (geometries.length === 1) return geometries[0];
  const merged = mergeGeometries(geometries, false);
  geometries.forEach(geo => geo.dispose());
  return merged;
}
