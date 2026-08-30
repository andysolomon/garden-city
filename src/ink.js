// Ink renderer: the antitecture drafting look, driven by the CityModel.
//
// Technique: every volume is drawn twice —
//   1. a paper-colored MeshBasicMaterial fill (pushed back with polygonOffset)
//      that acts as a hidden-line occluder, and
//   2. jittered line segments for its edges, merged into a handful of big
//      LineSegments objects so the whole city costs a few draw calls.
// A subset of masses gets a translucent tinted fill (depthWrite off) for the
// x-ray poster feel; everything behind them stays visible.
//
// V2: grounds are polygons (block faces of the road graph), roads are ribbons
// with round junction caps, and buildings carry a yaw (`angle`) aligned to
// their street frontage.

import * as THREE from 'three';
import { RNG } from './rng.js';
import { CITY_SIZE, railRuns } from './model.js';
import { flatPolygonsGeometry, polygonPrismsGeometry, groundY, terrainFrame, drapeSegmentsForSpan, anchorFootprint, pillar, bridgeDeckY, bridgeDeckLookup, elevatedRailY, terrainCells, terrainSkirtGeometry, BRIDGE_FLAT_Y, DRAPE_EDGE_SEGMENTS, RAIL_FLAT_Y } from './render.js';
import { orientedRect } from './geom.js';
import { positionOnRoute } from './routing.js';

export const INK_THEMES = {
  day:   { paper: 0xeae6dd, ink: 0x1c1a18, road: 0xded7c7, park: 0xdcd6c2, plaza: 0xe4dfd2, water: 0xaabfc5, accent: 0xe8501e, dark: false },
  dusk:  { paper: 0xe6d8c3, ink: 0x33241d, road: 0xd8c7ab, park: 0xcfc2a1, plaza: 0xdfd2ba, water: 0xb3a6ad, accent: 0xd8451a, dark: false },
  night: { paper: 0x101014, ink: 0xd8d4c8, road: 0x1a1a20, park: 0x171d18, plaza: 0x18181d, water: 0x1e3e50, accent: 0xf06632, dark: true },
};

export function themeFor(config) {
  return INK_THEMES[config.sky] || INK_THEMES.day;
}

const TINTS = [0xe8724a, 0x8aa07a, 0xc8a060, 0xb05540];

export class InkLines {
  // `sample` (optional) is the terrain sampler used by the ground* methods;
  // when absent they degrade to the flat seg/poly calls.
  constructor(rng, jitter, sample = null) { this.pos = []; this.rng = rng; this.j = jitter; this.sample = sample; }
  r(scale) { return (this.rng.next() - .5) * scale * 2; }
  // A segment lying on the ground: split into `n` pieces sampled at the same
  // fractions the draped fills use, so lines and fills share vertices. Pieces
  // that touch water (either end or the midpoint) are masked out, matching the
  // leaf rejection of the draped fills, so outlines never run over water.
  groundSeg(ax, az, bx, bz, y, n = null) {
    if (!this.sample) { this.seg(ax, y, az, bx, y, bz); return; }
    n = n ?? drapeSegmentsForSpan(Math.hypot(bx - ax, bz - az));
    const land = this.sample.isLand || null;
    let px = ax, pz = az, py = groundY(this.sample, ax, az, y);
    for (let i = 1; i <= n; i++) {
      const t = i / n, qx = ax + (bx - ax) * t, qz = az + (bz - az) * t;
      const qy = groundY(this.sample, qx, qz, y);
      const dry = !land || (land(px, pz) && land(qx, qz) && land((px + qx) / 2, (pz + qz) / 2));
      if (dry) this.seg(px, py, pz, qx, qy, qz);
      px = qx; pz = qz; py = qy;
    }
  }
  groundPoly(pts, y, n = null) {
    for (let i = 0, m = pts.length; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      this.groundSeg(a[0], a[1], b[0], b[1], y, n);
    }
  }
  seg(ax, ay, az, bx, by, bz) {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const jj = Math.min(this.j, len * .08);
    const n = Math.max(1, Math.min(6, Math.round(len / 24)));
    let px = ax + this.r(jj * .5), py = ay + this.r(jj * .5), pz = az + this.r(jj * .5);
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = i === n ? .5 : 1;
      const qx = ax + (bx - ax) * t + this.r(jj * e);
      const qy = ay + (by - ay) * t + this.r(jj * e);
      const qz = az + (bz - az) * t + this.r(jj * e);
      this.pos.push(px, py, pz, qx, qy, qz);
      px = qx; py = qy; pz = qz;
    }
  }
  // 12 edges of a box, slightly outset so jittered lines clear the fill faces.
  box(x, y, z, w, h, d, out = .18) {
    const x0 = x - out, x1 = x + w + out, y0 = y, y1 = y + h + out, z0 = z - out, z1 = z + d + out;
    this.seg(x0, y0, z0, x1, y0, z0); this.seg(x1, y0, z0, x1, y0, z1);
    this.seg(x1, y0, z1, x0, y0, z1); this.seg(x0, y0, z1, x0, y0, z0);
    this.seg(x0, y1, z0, x1, y1, z0); this.seg(x1, y1, z0, x1, y1, z1);
    this.seg(x1, y1, z1, x0, y1, z1); this.seg(x0, y1, z1, x0, y1, z0);
    this.seg(x0, y0, z0, x0, y1, z0); this.seg(x1, y0, z0, x1, y1, z0);
    this.seg(x1, y0, z1, x1, y1, z1); this.seg(x0, y0, z1, x0, y1, z1);
  }
  // Oriented box: centre (cx, cz), footprint w×d rotated by `angle`.
  obox(cx, y, cz, w, h, d, angle, out = .18) {
    const c = orientedRect(cx, cz, w + out * 2, d + out * 2, angle);
    const y1 = y + h + out;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      this.seg(a[0], y, a[1], b[0], y, b[1]);
      this.seg(a[0], y1, a[1], b[0], y1, b[1]);
      this.seg(a[0], y, a[1], a[0], y1, a[1]);
    }
  }
  rect(x, y, z, w, d) {
    this.seg(x, y, z, x + w, y, z); this.seg(x + w, y, z, x + w, y, z + d);
    this.seg(x + w, y, z + d, x, y, z + d); this.seg(x, y, z + d, x, y, z);
  }
  poly(pts, y) {
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      this.seg(a[0], y, a[1], b[0], y, b[1]);
    }
  }
  // Supports the issue's prism(footprint, y, h) API and the courtyard-aware
  // form used by the model: prism(footprint, courtyard, y, h).
  prism(footprint, courtyard, y, h) {
    if (typeof courtyard === 'number') {
      h = y;
      y = courtyard;
      courtyard = null;
    }
    const rings = courtyard?.length >= 3 ? [footprint, courtyard] : [footprint];
    for (const ring of rings) {
      this.poly(ring, y);
      this.poly(ring, y + h + .18);
      for (const [x, z] of ring) this.seg(x, y, z, x, y + h + .18, z);
    }
  }
  ring(cx, y, cz, r, n = 8, r2 = r) {
    let px = cx + r, pz = cz;
    for (let i = 1; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const qx = cx + Math.cos(a) * r, qz = cz + Math.sin(a) * r2;
      this.seg(px, y, pz, qx, y, qz);
      px = qx; pz = qz;
    }
  }
  build(color, opacity = 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color, transparent: opacity < 1, opacity,
    }));
  }
}

function fillMat(color, opts = {}) {
  return new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    ...opts,
  });
}

// Instanced boxes. Specs may be rects {x,z,w,d,h,y} or oriented
// {cx,cz,w,d,h,y,angle}; `angle` is the world yaw of the w-axis.
function instancedBoxes(specs, material) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const im = new THREE.InstancedMesh(geo, material, specs.length);
  const d = new THREE.Object3D();
  specs.forEach((b, i) => {
    const cx = b.cx ?? b.x + b.w / 2, cz = b.cz ?? b.z + b.d / 2;
    d.position.set(cx, (b.y || 0) + b.h / 2, cz);
    d.rotation.set(0, -(b.angle || 0), 0);
    d.scale.set(b.w, b.h, b.d);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
}

function polygonFill(world, polys, material, y, sample = null) {
  if (!polys.length) return;
  world.add(new THREE.Mesh(flatPolygonsGeometry(polys, y, sample), material));
}

// Box specs ({x,z,w,d} or {cx,cz,w,d,angle}) re-based onto the surface.
function anchorSpec(sample, b, y = b.y || 0) {
  if (!sample) return b;
  const corners = b.cx !== undefined
    ? orientedRect(b.cx, b.cz, b.w, b.d, b.angle || 0)
    : [[b.x, b.z], [b.x + b.w, b.z], [b.x + b.w, b.z + b.d], [b.x, b.z + b.d]];
  return { ...b, ...anchorFootprint(sample, corners, y, b.h) };
}

// The ink renderer's land datum: island lift (sea cities draw on top of the
// island disc) plus the paper terrain plate top. Null for flat models.
export function inkSurface(model) {
  const gy = model.water.some(w => w.type === 'sea') ? 1.4 : 0;
  return { gy, ...terrainFrame(model) };
}

// Roof heights of every building and landmark exactly as the ink renderer
// anchors them on the terrain (flat models: y + h), for the poster's levels.
export function anchoredTops(model) {
  const { surface } = inkSurface(model);
  const tops = [];
  for (const b of model.buildings) {
    const a = b.footprint
      ? anchorFootprint(surface, b.footprint, b.y || 0, b.h)
      : anchorSpec(surface, b);
    tops.push((a.y || 0) + a.h);
  }
  for (const l of model.landmarks) {
    const a = anchorSpec(surface, { cx: l.x, cz: l.z, w: l.w, d: l.d, h: l.h, angle: l.angle || 0 }, 0);
    tops.push((a.y || 0) + a.h);
  }
  return tops;
}

export function renderInk(viewer, model) {
  viewer.clearWorld();
  const cfg = model.config;
  const T = themeFor(cfg);
  const night = T.dark;

  // Transparent WebGL clear; the paper tone comes from the page behind the
  // canvas, which also lets the poster export show its watermark through.
  viewer.scene.background = null;
  viewer.renderer.setClearColor(0x000000, 0);
  viewer.viewport.style.background = '#' + T.paper.toString(16).padStart(6, '0');

  const world = viewer.world;
  const rng = new RNG(model.seed + ':ink');
  // Sea cities draw their ground on top of the island disc, so every ground
  // fill is lifted above it.
  // E3: terrain drape. `sample` is the water-masked lift (null for flat
  // models, which keep every original datum); `surface` is the one land datum
  // shared by the terrain, ground objects, building anchors and supports.
  const { gy, lift: sample, surface, datum, waterTop } = inkSurface(model);
  const at = (x, z, y = 0) => y + (surface ? surface(x, z) : 0);
  world.userData.terrain = { mode: 'ink', datum, elevated: !!surface, waterTop: surface ? waterTop : null };
  world.userData.infrastructure = {
    bridgeDecks: model.bridges.map(b => bridgeDeckY(surface, b)),
    railY: model.rail?.elevated ? elevatedRailY(surface, model.rail, RAIL_FLAT_Y) : null,
  };
  const main = new InkLines(rng, .55, sample);
  const faint = new InkLines(rng, .45, sample);
  const accent = new InkLines(rng, .5, sample);

  // Ground plate + sub-basement outlines (a signature of the original sheets).
  const plate = { x: -CITY_SIZE / 2 - 45, z: -CITY_SIZE / 2 - 45, w: CITY_SIZE + 90, d: CITY_SIZE + 90 };
  world.add(instancedBoxes([{ ...plate, h: 6, y: -6 }], fillMat(T.paper)));
  main.box(plate.x, -6, plate.z, plate.w, 6, plate.d, 0);
  if (surface) {
    // Draped paper terrain over the plate: an occluder for everything sunk
    // behind a rise, with a skirt so the rim reads as a cut section.
    world.add(new THREE.Mesh(flatPolygonsGeometry(terrainCells(plate), 0, surface), fillMat(T.paper)));
    world.add(new THREE.Mesh(terrainSkirtGeometry(plate, 0, surface), fillMat(T.paper)));
    const rim = [[plate.x, plate.z], [plate.x + plate.w, plate.z], [plate.x + plate.w, plate.z + plate.d], [plate.x, plate.z + plate.d]];
    main.groundPoly(rim, datum, 16 * DRAPE_EDGE_SEGMENTS);
  }
  faint.rect(plate.x, -24, plate.z, plate.w, plate.d);
  faint.rect(plate.x, -44, plate.z, plate.w, plate.d);
  for (const yb of [-24, -44]) {
    faint.seg(plate.x, yb, plate.z, plate.x, 0, plate.z);
    faint.seg(plate.x + plate.w, yb, plate.z, plate.x + plate.w, 0, plate.z);
    faint.seg(plate.x + plate.w, yb, plate.z + plate.d, plate.x + plate.w, 0, plate.z + plate.d);
    faint.seg(plate.x, yb, plate.z + plate.d, plate.x, 0, plate.z + plate.d);
  }

  // Water: translucent tint + outline. Sea also gets a drawn island ground.
  for (const w of model.water) {
    const wy = surface ? waterTop - 1.6 : .2;
    world.add(instancedBoxes([{ ...w, h: 1.6, y: wy }],
      fillMat(T.water, { transparent: true, opacity: .5, depthWrite: false })));
    faint.rect(w.x, surface ? waterTop : 2.2, w.z, w.w, w.d);
    if (w.type === 'sea') {
      const rx = w.rx ?? CITY_SIZE * .445, rz = w.rz ?? CITY_SIZE * .395;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(rx, rx, 2.4, 56), fillMat(T.paper));
      disc.scale.z = rz / rx;
      disc.position.y = .8;
      world.add(disc);
      main.ring(0, 2.3, 0, rx, 56, rz);
    }
  }

  // A quiet station-catchment wash, using model annotations only. Roads and
  // buildings remain above it, preserving the drafting hierarchy.
  polygonFill(world, model.blocks.filter(b => b.walkshed).map(b => b.polygon),
    fillMat(T.accent, { transparent: true, opacity: night ? .08 : .055, depthWrite: false }), gy + .7, sample);

  // Roads: quiet ribbon fills + round junction caps; arterials get an outline
  // along their two kerbs.
  const roadPolys = model.roads.map(r => r.polygon).concat(model.roadCaps.filter(c => !c.elevated).map(c => c.polygon));
  polygonFill(world, roadPolys, fillMat(T.road), gy + 1.0, sample);
  for (const r of model.roads) {
    if (r.type !== 'arterial') continue;
    const [a, b] = kerbs(r);
    faint.groundSeg(a[0][0], a[0][1], a[1][0], a[1][1], gy + 1.4);
    faint.groundSeg(b[0][0], b[0][1], b[1][0], b[1][1], gy + 1.4);
  }

  // Bridges: paper deck + drawn structure, oriented along the span. The deck
  // sits at least BRIDGE_CLEARANCE above the higher bank surface (3.4 when
  // flat); on terrain the bank ends get drawn piers down to the ground.
  for (const b of model.bridges) {
    const deck = bridgeDeckY(surface, b), top = deck + 2.2, rail = top + 3;
    world.add(instancedBoxes([{ cx: b.cx, cz: b.cz, w: b.len, d: b.width, h: 2.2, y: deck, angle: b.angle }], fillMat(T.paper)));
    main.obox(b.cx, deck, b.cz, b.len, 2.2, b.width, b.angle);
    const [ka, kb] = kerbs(b, .6);
    main.seg(ka[0][0], rail, ka[0][1], ka[1][0], rail, ka[1][1]);
    main.seg(kb[0][0], rail, kb[0][1], kb[1][0], rail, kb[1][1]);
    for (let t = 0; t <= 4; t++) {
      const f = t / 4;
      const pa = lerp(ka[0], ka[1], f), pb = lerp(kb[0], kb[1], f);
      faint.seg(pa[0], top, pa[1], pa[0], rail, pa[1]);
      faint.seg(pb[0], top, pb[1], pb[0], rail, pb[1]);
    }
    if (surface) {
      for (const f of [.04, .96]) {
        const pa = lerp(ka[0], ka[1], f), pb = lerp(kb[0], kb[1], f);
        faint.seg(pa[0], Math.min(surface(pa[0], pa[1]), deck), pa[1], pa[0], deck, pa[1]);
        faint.seg(pb[0], Math.min(surface(pb[0], pb[1]), deck), pb[1], pb[0], deck, pb[1]);
      }
    }
  }

  // Parks, courts, fields + plazas: polygon fills with faint outlines.
  polygonFill(world, model.parks.filter(p => !p.field && !p.court).map(p => p.polygon), fillMat(T.park), gy + 1.1, sample);
  polygonFill(world, model.parks.filter(p => p.court).map(p => p.polygon), fillMat(T.park, { transparent: true, opacity: .55 }), gy + 1.1, sample);
  for (const p of model.parks) if (!p.field) faint.groundPoly(p.polygon, gy + 1.5);
  polygonFill(world, model.plazas.map(p => p.polygon), fillMat(T.plaza), gy + 1.2, sample);
  for (const p of model.plazas) faint.groundPoly(p.polygon, gy + 1.7);

  // Buildings: paper occluder fills + ink edges; ~10% get an x-ray tint.
  const paperSpecs = [], tinted = new Map(), paperPrisms = [], tintedPrisms = new Map();
  for (const raw of model.buildings) {
    // Anchor each volume on the surface: base at the lowest footprint corner,
    // roof kept at its intended level, so nothing floats or sinks.
    const b = raw.footprint
      ? { ...raw, ...anchorFootprint(surface, raw.footprint, raw.y || 0, raw.h) }
      : anchorSpec(surface, raw);
    if (b.footprint) main.prism(b.footprint, b.courtyard, b.y || 0, b.h);
    else main.obox(b.cx, b.y || 0, b.cz, b.w, b.h, b.d, b.angle || 0);
    if (b.h > 30 && rng.bool(.1)) {
      const c = rng.pick(TINTS);
      if (b.footprint) {
        if (!tintedPrisms.has(c)) tintedPrisms.set(c, []);
        tintedPrisms.get(c).push(b);
      }
      else {
        if (!tinted.has(c)) tinted.set(c, []);
        tinted.get(c).push(b);
      }
    } else {
      if (b.footprint) paperPrisms.push(b);
      else paperSpecs.push(b);
    }
  }
  if (paperSpecs.length) world.add(instancedBoxes(paperSpecs, fillMat(T.paper)));
  for (const [c, arr] of tinted) {
    world.add(instancedBoxes(arr, fillMat(c, { transparent: true, opacity: night ? .3 : .2, depthWrite: false })));
  }
  if (paperPrisms.length) {
    const mesh = new THREE.Mesh(polygonPrismsGeometry(paperPrisms), fillMat(T.paper));
    mesh.userData.inkFootprintFillCount = paperPrisms.length;
    world.add(mesh);
  }
  for (const [c, arr] of tintedPrisms) {
    const mesh = new THREE.Mesh(polygonPrismsGeometry(arr),
      fillMat(c, { transparent: true, opacity: night ? .3 : .2, depthWrite: false }));
    mesh.userData.inkFootprintFillCount = arr.length;
    world.add(mesh);
  }

  // Landmark: accent-tinted x-ray volume with accent-colored edges + spire line.
  for (const l of model.landmarks) {
    const spec = anchorSpec(surface, { cx: l.x, cz: l.z, w: l.w, d: l.d, h: l.h, angle: l.angle || 0 }, 0);
    world.add(instancedBoxes([spec], fillMat(T.accent, { transparent: true, opacity: .16, depthWrite: false })));
    const y0 = spec.y || 0, top = y0 + spec.h;
    accent.obox(l.x, y0, l.z, l.w, spec.h, l.d, spec.angle);
    accent.seg(l.x, top, l.z, l.x, top + l.h * .3, l.z);
    for (let f = 1; f < 5; f++) accent.poly(orientedRect(l.x, l.z, l.w, l.d, spec.angle), y0 + spec.h * f / 5);
  }

  renderInkRail(world, model, main, faint, T, surface);
  const deckAt = bridgeDeckLookup(model, surface);

  // Cranes: pure line work, straight from the original poster language.
  for (const c of model.cranes) {
    const y0 = at(c.x, c.z), h = y0 + c.h;
    main.seg(c.x, y0, c.z, c.x, h, c.z);
    if (c.dir === 'x') {
      main.seg(c.x, h, c.z, c.x + c.jib, h - 3, c.z);
      main.seg(c.x, h, c.z, c.x - c.jib * .35, h - 1.5, c.z);
      faint.seg(c.x + c.jib * .7, h - 3, c.z, c.x + c.jib * .7, y0 + c.h * .45, c.z);
    } else {
      main.seg(c.x, h, c.z, c.x, h - 3, c.z + c.jib);
      main.seg(c.x, h, c.z, c.x, h - 1.5, c.z - c.jib * .35);
      faint.seg(c.x, h - 3, c.z + c.jib * .7, c.x, y0 + c.h * .45, c.z + c.jib * .7);
    }
  }

  // Trees: stem + crown ring. Cars: small oriented boxes. Drones: crosses.
  for (const t of model.trees) {
    const y0 = at(t.x, t.z);
    faint.seg(t.x, y0, t.z, t.x, y0 + 8 * t.s, t.z);
    faint.ring(t.x, y0 + 9.5 * t.s, t.z, 4.2 * t.s, 7);
  }
  for (const c of model.cars) {
    if (c.path) continue;
    const y = c.bridge ? deckAt(c.x, c.z) + 2.2 : at(c.x, c.z, .2);
    faint.obox(c.x, y, c.z, 6 * c.s, 2.4 * c.s, 3.2 * c.s, -c.rot, 0);
  }
  for (const a of model.drones) {
    faint.seg(a.x - 5 * a.s, a.y, a.z, a.x + 5 * a.s, a.y, a.z);
    faint.seg(a.x, a.y, a.z - 3 * a.s, a.x, a.y, a.z + 3 * a.s);
  }

  world.add(main.build(T.ink, .92));
  world.add(faint.build(T.ink, .38));
  world.add(accent.build(T.accent, .95));
  renderMovingInkCars(viewer, model, T, at, deckAt);
}

function renderMovingInkCars(viewer, model, T, at = (x, z, y = 0) => y, deckAt = () => BRIDGE_FLAT_Y) {
  const cars = model.cars.filter(c => c.path);
  if (!cars.length || !model.graph) return;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(6, 2.4, 3.2),
    new THREE.MeshBasicMaterial({ color: T.ink, wireframe: true, transparent: true, opacity: .72 }),
    cars.length,
  );
  const d = new THREE.Object3D();
  const update = elapsed => {
    cars.forEach((car, i) => {
      const p = positionOnRoute(model.graph, car, elapsed);
      d.position.set(p.x, p.bridge ? deckAt(p.x, p.z) + 3.4 : at(p.x, p.z, 1.4), p.z);
      d.rotation.set(0, p.rot, 0);
      d.scale.set(car.s, car.s, car.s);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  mesh.frustumCulled = false;
  viewer.world.add(mesh);
  viewer.setAnimation(update);
}

// The two kerb lines of a road/bridge axis, inset by `inset` from the edge.
function kerbs(r, inset = 0) {
  const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], l = Math.hypot(dx, dz) || 1;
  const nx = -dz / l * (r.width / 2 - inset), nz = dx / l * (r.width / 2 - inset);
  return [
    [[r.a[0] + nx, r.a[1] + nz], [r.b[0] + nx, r.b[1] + nz]],
    [[r.a[0] - nx, r.a[1] - nz], [r.b[0] - nx, r.b[1] - nz]],
  ];
}
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// Elevated lines run at max(15, highest surface along the alignment +
// RAIL_CLEARANCE) on supports drawn down to the ground; surface lines follow
// the terrain. Viaduct decks/piers stay explicit raised spans.
function renderInkRail(world, model, main, faint, T, sample = null) {
  const r = model.rail;
  if (!r) return;
  const y = r.elevated ? elevatedRailY(sample, r, RAIL_FLAT_Y) : 2.1;
  const ground = !r.elevated && sample;
  // Map an along-axis coordinate + lateral offset onto world [x, z].
  const P = (q, o) => (r.vertical ? [r.offset + o, q] : [q, r.offset + o]);
  const line = (L, q0, q1, o, yy) => {
    const [x0, z0] = P(q0, o), [x1, z1] = P(q1, o);
    if (ground) L.groundSeg(x0, z0, x1, z1, yy, Math.max(DRAPE_EDGE_SEGMENTS, Math.ceil(Math.abs(q1 - q0) / 20)));
    else L.seg(x0, yy, z0, x1, yy, z1);
  };
  const cross = (L, q, o0, o1, yy) => {
    const [x0, z0] = P(q, o0), [x1, z1] = P(q, o1);
    if (ground) L.groundSeg(x0, z0, x1, z1, yy, 1);
    else L.seg(x0, yy, z0, x1, yy, z1);
  };
  const boxAt = (L, q, qlen, o, olen, h, yy, anchor = false) => {
    const [x, z] = P(q, o);
    const spec = anchor ? anchorSpec(sample, { x, z, w: r.vertical ? olen : qlen, d: r.vertical ? qlen : olen, h }, yy) : null;
    if (spec) L.box(spec.x, spec.y, spec.z, spec.w, spec.h, spec.d, 0);
    else L.box(x, yy, z, r.vertical ? olen : qlen, h, r.vertical ? qlen : olen, 0);
  };
  // A support from the ground (flat: 0) up to `top`.
  const supportAt = (L, q, qlen, o, olen, top) => {
    const [x, z] = P(q, o);
    const spec = pillar(sample, { x, z, w: r.vertical ? olen : qlen, d: r.vertical ? qlen : olen }, top);
    L.box(spec.x, spec.y, spec.z, spec.w, spec.h, spec.d, 0);
  };

  for (const [a, b] of railRuns(r)) {
    line(main, a, b, -5.2, y);
    line(main, a, b, 5.2, y);
    for (let q = a; q < b; q += 18) cross(faint, q, -8, 8, y - .3);
  }
  if (r.elevated) {
    for (let q = r.extent.from; q < r.extent.to; q += 70) supportAt(main, q, 8, -4, 8, y - 1);
  }
  if (r.crossing === 'viaduct') {
    for (const s of r.spans) {
      boxAt(main, s.from, s.to - s.from, -8, 16, 2.2, y - 2.6);
      for (let q = s.from + 8; q < s.to - 8; q += 26) supportAt(main, q, 6, -5, 10, y - 2.6);
    }
  }
  if (r.crossing === 'tunnel') {
    for (const s of r.spans) {
      boxAt(main, s.from - 6, 6, -9, 18, 7, 0, true);   // portal head-walls
      boxAt(main, s.to, 6, -9, 18, 7, 0, true);
      // dashed subsurface alignment, in the language of the basement outlines
      for (let q = s.from; q < s.to; q += 16) line(faint, q, Math.min(q + 9, s.to), 0, -9);
    }
  }
  if (r.station) {
    const s = anchorSpec(sample, { ...r.station, h: 24 }, 0);
    const sy = s.y || 0, roof = sy + s.h;
    world.add(instancedBoxes([s],
      fillMat(T.accent, { transparent: true, opacity: .18, depthWrite: false })));
    main.box(s.x, sy, s.z, s.w, s.h, s.d);
    // Vault ribs over the concourse, per the original Gewölbebau sheets.
    const along = s.w > s.d;
    const ribs = 6;
    for (let i = 0; i <= ribs; i++) {
      const t = i / ribs;
      if (along) {
        const px = s.x + s.w * t;
        for (let k = 0; k < 8; k++) {
          const a0 = k / 8, a1 = (k + 1) / 8;
          main.seg(px, roof + Math.sin(a0 * Math.PI) * 10, s.z + s.d * a0, px, roof + Math.sin(a1 * Math.PI) * 10, s.z + s.d * a1);
        }
      } else {
        const pz = s.z + s.d * t;
        for (let k = 0; k < 8; k++) {
          const a0 = k / 8, a1 = (k + 1) / 8;
          main.seg(s.x + s.w * a0, roof + Math.sin(a0 * Math.PI) * 10, pz, s.x + s.w * a1, roof + Math.sin(a1 * Math.PI) * 10, pz);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Poster identity: deterministic naming + overlay chrome.
// ---------------------------------------------------------------------------
const TITLES = {
  mixed:      ['Stadtviertel', 'QUARTER / MIXED FABRIC / STRATA', 'QUARTER'],
  core:       ['Hochstadt', 'CORE / HIGH-RISE / CBD', 'HIGH CORE'],
  euro:       ['Blockwerk', 'PERIMETER BLOCKS / GRUENDERZEIT', 'BLOCKWORK'],
  lowrise:    ['Gartenstadt', 'LOW-RISE / GARDEN FABRIC', 'GARDEN'],
  industrial: ['Industriewerk', 'FOUNDRY / HALL / YARDS', 'FOUNDRY'],
};

const PATTERN_TITLES = {
  manhattan: ['Rasterstadt', 'GRID / AVENUES / LONG BLOCKS', 'GRID'],
  paris:     ['Sternstadt', 'RADIAL / BOULEVARDS / PLACES', 'RADIAL'],
  tokyo:     ['Wabenstadt', 'ORGANIC / FINE GRAIN / LANES', 'FABRIC'],
  medieval:  ['Altstadt', 'ORGANIC / WALLED CORE / LANES', 'OLD TOWN'],
  atlanta:   ['Vorortstadt', 'SPRAWL / CUL-DE-SACS / ARTERIALS', 'SPRAWL'],
};

export function posterMeta(model) {
  const r = new RNG(model.seed + ':meta');
  const massing = TITLES[model.config.massing] || TITLES.mixed;
  const pattern = model.engine === 'graph' ? PATTERN_TITLES[model.pattern] : null;
  // The title names the street pattern when the road graph made the city;
  // the taxonomy line keeps the massing so both axes stay legible.
  const title = pattern ? pattern[0] : massing[0];
  const taxo = pattern ? `${pattern[1]} / ${massing[2]}` : massing[1];
  const type = pattern ? pattern[2] : massing[2];
  const T = themeFor(model.config);
  return {
    title, taxo, type, theme: T,
    skyLabel: { day: 'DAYLIGHT', dusk: 'DUSK', night: 'NOCTURNE' }[model.config.sky] || 'DAYLIGHT',
    num: r.int(10, 99),
    spec: r.int(1000, 9999),
    sysId: 'IS-' + r.int(10000, 99999) + r.pick(['A', 'B', 'C', 'E']),
    az: r.int(0, 359), el: r.int(20, 60),
    footfall: r.int(20, 90),
    sub: r.int(40, 80),
    night: T.dark,
    sector: model.config.sector.toUpperCase(),
  };
}

export function updateOverlay(model) {
  const m = posterMeta(model);
  const $ = id => document.getElementById(id);
  // Poster chrome text takes the ink colour of the active theme.
  document.documentElement.style.setProperty('--po-ink', '#' + m.theme.ink.toString(16).padStart(6, '0'));
  $('po-spec').textContent = `SPECIMEN ${m.spec} : ${m.type}`;
  $('po-sector').textContent = `${m.sector} SECTOR / ${m.skyLabel}`;
  $('po-title').textContent = m.title;
  $('po-taxo').textContent = m.taxo;
  $('po-num').textContent = m.num;
  $('po-num2').textContent = m.num;
  $('po-typeword').textContent = m.type;
  $('po-sys').textContent = m.sysId;
  $('po-sidetext').textContent = `GENERATIVE ANTITECTURE / CITYMODEL / SPECIMEN ${m.spec}`;
}
