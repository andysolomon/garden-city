// Graph fabric: the V2 pipeline from fields to buildings.
//
//   centers → fields → road growth → faces → blocks → buildable polygons
//   → parcels (+frontage) → buildings
//
// Produces polygon-based model entries. Every entry also carries an
// axis-aligned bbox {x, z, w, d} so rect-only consumers keep working.

import { CITY_SIZE, DENSITY, pickZone, massBuilding } from './common.js';
import { makeWater, makePopulation, makeDirection, makeExclusion, makeNoise, makeElevation } from './fields.js';
import { growRoads, extractFaces, VIRTUAL } from './graph.js';
import { buildableArea, subdivideParcels, findFrontage, fitRect } from './blocks.js';
import { resolvePreset } from './presets.js';
import { buildCorridors } from './corridors.js';
import {
  centroid, obb, bbox, orientedRect, trimPolyAgainstRect, polyIntersectsRect,
  pointInPolygon, angleBetween, offsetPolygon, shrinkPolygon, area, signedArea,
  isSimple, distToBoundary, segIntersect,
} from './geom.js';

export function graphFabric(model, land, rng, config) {
  const dcfg = DENSITY[config.density];
  const P = resolvePreset(config.pattern);
  const size = CITY_SIZE;
  model.pattern = P.name;

  // ---- fields --------------------------------------------------------------
  const water = makeWater(land, size);
  const station = model.rail?.station;
  const exclusion = makeExclusion(station ? [{ x: station.x - 4, z: station.z - 4, w: station.w + 8, d: station.d + 8 }] : []);
  const onLand = (x, z) => water.sdf(x, z) > 14 && !exclusion(x, z) && Math.abs(x) < size * .44 && Math.abs(z) < size * .44;

  const centers = [];
  let cbd = null;
  for (let i = 0; i < 60 && !cbd; i++) {
    const x = rng.float(-80, 80), z = rng.float(-80, 80);
    if (onLand(x, z)) cbd = { x, z };
  }
  if (!cbd) { // deterministic fallback: nearest land point to the origin on a coarse grid
    let best = Infinity;
    for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) {
      const x = i * 20, z = j * 20, d = x * x + z * z;
      if (d < best && onLand(x, z)) { best = d; cbd = { x, z }; }
    }
    if (!cbd) cbd = { x: 0, z: 0 };
  }
  centers.push({ ...cbd, sigma: 260, w: 1 });
  for (let i = 0; i < P.secondaryCenters; i++) {
    let s = null;
    for (let k = 0; k < 40 && !s; k++) {
      const a = rng.float(0, Math.PI * 2), r = rng.float(190, 330);
      const x = cbd.x + Math.cos(a) * r, z = cbd.z + Math.sin(a) * r;
      if (onLand(x, z) && centers.every(o => Math.hypot(o.x - x, o.z - z) > 150)) s = { x, z };
    }
    if (s) centers.push({ ...s, sigma: 140, w: .55 });
  }
  const growthCenters = centers.slice();
  if (station) centers.push({ x: station.x + station.w / 2, z: station.z + station.d / 2, sigma: 120, w: .45, station: true });

  const population = makePopulation(centers, size);
  const noise = makeNoise(config.seed + ':noise');
  const directionOptions = {
    noiseAmp: P.noiseAmp, noiseScale: P.noiseScale, shores: water.shores,
  };
  if (land.kind === 'coast' || land.kind === 'river') {
    // Shore influence spans a few local blocks and dominates at the bank;
    // the RBF still decays before it can flatten the interior preset grammar.
    directionOptions.boundarySigma = 110;
    directionOptions.boundaryWeight = 8;
  }
  const direction = makeDirection(P.sources(rng, growthCenters), noise, directionOptions);
  const elevation = makeElevation(config.seed, size);
  const fields = { water, population, direction, exclusion, elevation };
  model.fields = fields;
  model.centers = centers;

  // ---- growth + faces ------------------------------------------------------
  const budget = Math.round(dcfg.budget * P.budgetScale);
  P.parallelGap = Math.min(P.spacing.major, P.spacing.minor) * .4;
  const { graph: g, stats } = growRoads({ rng, fields, P, size, budget, centers: growthCenters });
  const fx = extractFaces(g);
  model.graph = g;
  model.faces = fx.faces;
  model.stats = { ...stats, faces: fx.faces.length, spurs: fx.spurCount, droppedEdges: fx.droppedEdges, degenerateFaces: fx.degenerateFaces, offsetDrops: 0, landlocked: 0, slivers: 0 };

  // ---- roads, bridges, junction caps --------------------------------------
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (e.removed || VIRTUAL.has(e.cls)) continue;
    const a = g.nodes[e.a], b = g.nodes[e.b];
    const angle = Math.atan2(b.z - a.z, b.x - a.x), len = Math.hypot(b.x - a.x, b.z - a.z);
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    const polygon = orientedRect(cx, cz, len, e.width, angle);
    const entry = { polygon, cls: e.cls, type: e.cls === 'arterial' ? 'arterial' : 'street', width: e.width, a: [a.x, a.z], b: [b.x, b.z], angle, len, cx, cz, edge: i, bridge: e.bridge, ...bbox(polygon) };
    if (e.bridge) model.bridges.push(entry); else model.roads.push(entry);
  }
  model.corridors = buildCorridors(g, config.seed);
  model.stats.corridors = model.corridors.length;
  for (let n = 0; n < g.nodes.length; n++) {
    const inc = g.adj[n].filter(e => !g.edges[e].removed && !VIRTUAL.has(g.edges[e].cls));
    if (inc.length < 2) continue;
    if (inc.length === 2) {
      const a0 = g.angleFrom(n, inc[0]), a1 = g.angleFrom(n, inc[1]);
      if (angleBetween(a0, a1 + Math.PI) < .06 && g.edges[inc[0]].width === g.edges[inc[1]].width) continue; // straight through
    }
    const r = Math.max(...inc.map(e => g.edges[e].width)) / 2;
    const N = g.nodes[n], poly = [];
    for (let k = 0; k < 12; k++) { const t = k / 12 * Math.PI * 2; poly.push([N.x + Math.cos(t) * r, N.z + Math.sin(t) * r]); }
    model.roadCaps.push({ polygon: poly, x: N.x, z: N.z, r, elevated: inc.every(e => g.edges[e].bridge) });
  }

  // ---- faces → blocks ------------------------------------------------------
  const blocksRaw = [];
  for (const f of fx.faces) {
    const [cx, cz] = centroid(f.polygon);
    if (!water.isLand(cx, cz)) continue;
    if (f.area < 350) continue;
    const pop = population(cx, cz);
    const dist = 1 - pop;
    const b = { polygon: f.polygon, face: f, area: f.area, cx, cz, pop, dist, ...bbox(f.polygon) };
    // Oversized periphery faces stay open land — unless the station sits in
    // them, in which case the fabric still parcelizes around the terminal.
    const hasStation = station && pointInPolygon(station.x + station.w / 2, station.z + station.d / 2, f.polygon);
    if (f.area > P.maxBlockArea * (1.6 - pop) && !hasStation) b.field = true;
    b.zone = pickZone(config.sector, dist, rng);
    blocksRaw.push(b);
  }
  for (const b of blocksRaw) {
    if (b.field) continue;
    b.buildable = buildableArea(b.face, g, b.zone, config.detail);
    if (b.buildable && !footprintOnLand(b.buildable)) b.buildable = null;
    if (!b.buildable) model.stats.offsetDrops++;
  }

  // Landmark: a central, generous, unreserved block.
  {
    const free = blocksRaw.filter(b => b.buildable && !model.reserved.some(r => polyIntersectsRect(b.buildable, r)));
    const dim = b => { const o = obb(b.buildable); return Math.min(o.w, o.d); };
    let cands = free.filter(b => b.pop > .6 && dim(b) > 50);
    if (!cands.length) cands = free.filter(b => b.pop > .35 && dim(b) > 40);
    if (cands.length) rng.pick(cands).landmark = true;
  }

  const vacants = [];
  const targetParcelBase = dcfg.parcel * dcfg.parcel * P.parcelScale;
  for (const b of blocksRaw) {
    model.blocks.push(b);
    if (b.field) { model.parks.push({ polygon: b.polygon, field: true, ...bbox(b.polygon) }); continue; }
    if (!b.buildable) continue;
    if (b.landmark) { makePlaza(b); continue; }
    const parkChance = dcfg.park + (b.zone === 'civic' ? .08 : 0);
    if (rng.bool(parkChance)) { addPark(b); continue; }
    if (config.massing === 'euro' && makePerimeter(b)) continue;
    parcelize(b);
  }

  const craneSites = vacants.filter(p => p.dist < .6);
  for (let i = 0; i < Math.min(2, craneSites.length); i++) {
    const p = craneSites.splice(rng.int(0, craneSites.length - 1), 1)[0];
    model.cranes.push({ x: p.cx, z: p.cz, h: rng.float(70, 115), jib: rng.float(42, 68), dir: rng.bool() ? 'x' : 'z' });
  }
  return model;

  function makePlaza(b) {
    const poly = b.buildable;
    model.plazas.push({ polygon: poly, ...bbox(poly) });
    const o = obb(poly);
    const size = Math.min(o.w, o.d) * .42;
    model.landmarks.push({ x: o.cx, z: o.cz, w: size, d: size, h: config.density === 'extreme' ? 210 : 145, angle: o.angle });
    const n = 10;
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2;
      const c = Math.cos(o.angle), s = Math.sin(o.angle);
      const u = Math.cos(t) * o.w * .42, v = Math.sin(t) * o.d * .42;
      const x = o.cx + u * c - v * s, z = o.cz + u * s + v * c;
      if (pointInPolygon(x, z, poly)) model.trees.push({ x, z, s: rng.float(.8, 1.2) });
    }
  }

  function addPark(b) {
    const poly = b.buildable;
    model.parks.push({ polygon: poly, ...bbox(poly) });
    scatterTrees(poly, Math.max(4, Math.floor(b.area / 2600)), rng, model, [.7, 1.35]);
  }

  // Euro blocks are a single polygonal building around a courtyard. Blocks
  // crossed by reserved infrastructure, too small for a useful court, or
  // rejected by the robust inset fall back to the ordinary parcel grammar.
  function makePerimeter(b) {
    const outer = b.buildable;
    if (model.reserved.some(r => polyIntersectsRect(outer, r))) return false;
    if (!footprintOnLand(outer)) return false;

    const box = obb(outer), minDim = Math.min(box.w, box.d);
    if (minDim < 24 || area(outer) < 650) return false;
    const depth = Math.min(rng.float(8, 13), minDim * .28);
    const dists = outer.map(() => depth);
    let courtyard = offsetPolygon(outer, dists);
    if (!courtyard) courtyard = shrinkPolygon(outer, dists);
    if (!validCourtyard(outer, courtyard)) return false;

    const frontage = findFrontage(outer, outer, b.face, g);
    if (!frontage) return false;
    const parcel = {
      polygon: outer, zone: b.zone, dist: b.dist, pop: b.pop, frontage,
      landlocked: false, block: b, built: true, perimeter: true, ...bbox(outer),
    };
    model.parcels.push(parcel);

    // Reuse the established euro height/style RNG grammar, then replace its
    // fallback rectangle with the footprint's axis-aligned bounds. Rect-only
    // consumers retain every legacy field while polygon renderers use rings.
    const [mass] = massBuilding({ ...box, zone: b.zone, dist: b.dist }, config, dcfg, rng);
    const bounds = bbox(outer);
    Object.assign(mass, {
      ...bounds, cx: bounds.x + bounds.w / 2, cz: bounds.z + bounds.d / 2,
      angle: 0, style: 'perimeter', footprint: outer.map(p => p.slice()),
      courtyard: courtyard.map(p => p.slice()), blockFace: b.face.id,
    });
    model.buildings.push(mass);
    return true;
  }

  function validCourtyard(outer, inner) {
    if (!inner || signedArea(inner) <= 0 || !isSimple(inner) || area(inner) < 36) return false;
    if (area(inner) >= area(outer) - 1) return false;
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], q = inner[(i + 1) % inner.length];
      for (const [x, z] of [a, [(a[0] + q[0]) / 2, (a[1] + q[1]) / 2]]) {
        if (!pointInPolygon(x, z, outer) || distToBoundary(x, z, outer) <= .5) return false;
      }
      for (let j = 0; j < outer.length; j++) {
        const p = outer[j], r = outer[(j + 1) % outer.length];
        if (segIntersect(a[0], a[1], q[0], q[1], p[0], p[1], r[0], r[1])) return false;
      }
    }
    return true;
  }

  function parcelize(b) {
    const target = targetParcelBase * (1.5 - .9 * b.pop);
    const { parcels, slivers } = subdivideParcels(b.buildable, { targetArea: target, minWidth: 9, rng });
    model.stats.slivers += slivers;
    for (const poly of parcels) {
      const fr = findFrontage(poly, b.buildable, b.face, g);
      const parcel = { polygon: poly, zone: b.zone, dist: b.dist, pop: b.pop, frontage: fr, landlocked: !fr, block: b, ...bbox(poly) };
      model.parcels.push(parcel);
      if (!fr) { model.stats.landlocked++; model.parks.push({ polygon: poly, court: true, ...bbox(poly) }); continue; }
      // Reserved corridors take their right-of-way out of the lot.
      let usable = poly;
      for (const r of model.reserved) { usable = trimPolyAgainstRect(usable, r); if (!usable) break; }
      if (!usable) continue;
      const rect = fitRect(usable, fr.angle, 0);
      if (!rect || rect.w < 5.5 || rect.d < 5.5) continue;
      if (rng.bool(config.density === 'low' ? .12 : .045)) { vacants.push({ ...rect, dist: b.dist }); continue; }
      const bs = massBuilding({ ...rect, zone: b.zone, dist: b.dist }, config, dcfg, rng)
        .filter(bl => footprintOnLand(orientedRect(bl.cx, bl.cz, bl.w, bl.d, bl.angle || 0)));
      for (const bl of bs) model.buildings.push(bl);
      if (bs.length) parcel.built = true;
    }
  }

  // A face centroid can be on land while an inset edge still crosses a river
  // or coast. Sample every buildable/building edge densely enough that the
  // same signed-distance water field governs the whole footprint, not merely
  // its centre or corners. Rejection leaves the graph and parcel grammar
  // unchanged away from the shoreline.
  function footprintOnLand(poly, clearance = .5, step = 4) {
    if (!poly?.length) return false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        if (!(water.sdf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) > clearance)) return false;
      }
    }
    return true;
  }
}

export function scatterTrees(poly, n, rng, model, sRange) {
  const b = bbox(poly);
  let placed = 0, tries = 0;
  while (placed < n && tries++ < n * 12) {
    const x = rng.float(b.x + 4, b.x + b.w - 4), z = rng.float(b.z + 4, b.z + b.d - 4);
    if (!pointInPolygon(x, z, poly)) continue;
    model.trees.push({ x, z, s: rng.float(sRange[0], sRange[1]) });
    placed++;
  }
}
