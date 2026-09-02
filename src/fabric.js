// Graph fabric: the V2 pipeline from fields to buildings.
//
//   centers → fields → road growth → faces → blocks → buildable polygons
//   → parcels (+frontage) → buildings
//
// Produces polygon-based model entries. Every entry also carries an
// axis-aligned bbox {x, z, w, d} so rect-only consumers keep working.

import { CITY_SIZE, DENSITY, pickZone, massBuilding } from './common.js';
import { makeWater, makePopulation, makeDirection, makeExclusion, makeNoise, makeElevation } from './fields.js';
import { growRoads, extractFaces, VIRTUAL, WATER_TOLERANCE } from './graph.js';
import { importRoadGraph } from './roadgraph-import.js';
import { buildableAreas, subdivideParcels, findFrontage, mergeLandlockedParcels, fitRect } from './blocks.js';
import { resolvePreset } from './presets.js';
import { buildCorridors } from './corridors.js';
import {
  centroid, obb, bbox, orientedRect, trimPolyAgainstRect, polyIntersectsRect,
  pointInPolygon, angleBetween, offsetPolygon, shrinkPolygon, area, signedArea,
  isSimple, distToBoundary, segIntersect,
} from './geom.js';

export function graphFabric(model, land, rng, config) {
  return buildFabric(model, land, rng, config, proceduralGraph);
}

// Geographic fabric: the same pipeline, but the road graph is imported from
// normalized line records (W-000004) instead of grown from the fields. Every
// rendered road/bridge keeps its imported edge provenance; below-grade edges
// stay routable graph data but never become surface geometry.
export function geographicFabric(model, land, rng, config) {
  return buildFabric(model, land, rng, config, importedGraph);
}

function proceduralGraph({ rng, fields, P, size, dcfg, centers }) {
  const budget = Math.round(dcfg.budget * P.budgetScale);
  P.parallelGap = Math.min(P.spacing.major, P.spacing.minor) * .4;
  return growRoads({ rng, fields, P, size, budget, centers });
}

function importedGraph({ config, size, fields }) {
  const geography = config.geography;
  const records = geography.records;
  const { graph, diagnostics, stats } = importRoadGraph(records, { viewportSize: size });
  rejectAtGradeWaterEdges(graph, fields.water);
  const fx = extractFaces(graph);
  if (!fx.faces.length) {
    const codes = [...new Set(diagnostics.map(d => d.code))];
    throw new Error(`geographic source has no usable road faces (records=${stats.records}, lineRecords=${stats.lineRecords}, edges=${stats.edges}, faces=0` +
      `${codes.length ? `, diagnostics: ${codes.join(', ')}` : ''})`);
  }
  const bridgeElevatedEdges = graph.edges.filter(e => !e.removed && (e.bridge || (e.level ?? 0) > 0)).length;
  const importStats = { ...stats, bridges: bridgeElevatedEdges, elevatedEdges: bridgeElevatedEdges, bridgeElevatedEdges };
  return {
    graph, faces: fx,
    stats: importStats,
    importStats,
    geography: {
      diagnostics: diagnostics.map(d => ({ ...d })),
      stats: { ...importStats },
      upstreamDiagnostics: Array.isArray(geography.diagnostics) ? geography.diagnostics.map(d => ({ ...d })) : [],
    },
  };
}

// Imported water is authoritative. A source road may cross it only when the
// source metadata explicitly makes that edge a bridge/elevated or below grade.
// Sampling at half the graph's shoreline tolerance catches narrow incursions;
// points no farther than the quantization tolerance into water are accepted so
// quantized shore endpoints retain the same tolerance as procedural roads.
function rejectAtGradeWaterEdges(graph, water) {
  const step = WATER_TOLERANCE / 2;
  for (let edge = 0; edge < graph.edges.length; edge++) {
    const e = graph.edges[edge];
    if (e.removed || e.bridge || e.tunnel || (e.level ?? 0) !== 0) continue;
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    const samples = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let i = 0; i <= samples; i++) {
      const t = i / samples, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const distance = water.sdf(x, z);
      if (water.isLand(x, z) || distance >= -WATER_TOLERANCE) continue;
      throw new Error('geographic source has unusable road-water data: ' +
        `at-grade edge=${edge} sourceIndex=${e.sourceIndex ?? 'unknown'} sourceId=${JSON.stringify(e.sourceId ?? null)} ` +
        `sourcePart=${e.sourcePart ?? 'unknown'} roadId=${JSON.stringify(e.roadId)} enters imported water at ` +
        `x=${x.toFixed(3)}, z=${z.toFixed(3)}, sdf=${distance.toFixed(3)}`);
    }
  }
}

// Surface edges become roads/bridges/caps. Tunnels and below-grade imported
// edges are routing data only. Procedural edges carry neither field.
const isSurface = e => !e.removed && !VIRTUAL.has(e.cls) && !e.tunnel && !((e.level ?? 0) < 0);
const isElevated = e => e.bridge || (e.level ?? 0) > 0;

function buildFabric(model, land, rng, config, buildGraph) {
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
  const built = buildGraph({ rng, fields, P, size, dcfg, centers: growthCenters, config });
  const g = built.graph, stats = built.stats;
  const fx = built.faces || extractFaces(g);
  model.graph = g;
  model.faces = fx.faces;
  model.stats = { ...stats, faces: fx.faces.length, spurs: fx.spurCount, droppedEdges: fx.droppedEdges, degenerateFaces: fx.degenerateFaces, offsetDrops: 0, landlocked: 0, slivers: 0 };
  if (built.importStats) model.stats.import = { ...built.importStats };
  if (built.geography) model.geography = built.geography;

  // Source fabric is accepted before procedural massing. Only geographic land
  // carries these entries, keeping every procedural graph/BSP path untouched.
  const claimed = [];
  const importedBuildingClaims = [];
  if (land.imported) {
    // Rings rejected at the model boundary are reported alongside the fabric's
    // own water/reserved rejections; the stats sync below covers both.
    for (const diagnostic of land.imported.diagnostics) model.geography.diagnostics.push({ ...diagnostic });
    for (const park of land.imported.parks) {
      model.parks.push(park);
      claimed.push(park.polygon);
    }
    for (const building of land.imported.buildings) {
      let code = null, message = null;
      if (!footprintOnLand(building.footprint)) {
        code = 'imported-building-water';
        message = 'imported building footprint is not fully on land';
      } else if (model.reserved.some(rect => polyIntersectsRect(building.footprint, rect))) {
        code = 'imported-building-reserved';
        message = 'imported building footprint intersects reserved infrastructure';
      }
      if (code) {
        model.geography.diagnostics.push({
          index: building.sourceIndex, sourceId: building.sourceId,
          sourcePart: building.sourcePart, code, message,
        });
        continue;
      }
      model.buildings.push(building);
      claimed.push(building.footprint);
      importedBuildingClaims.push(building.footprint);
    }
    model.geography.stats.diagnostics = model.geography.diagnostics.length;
    model.stats.import.diagnostics = model.geography.diagnostics.length;
    model.stats.diagnostics = model.geography.diagnostics.length;
  }

  // ---- roads, bridges, junction caps --------------------------------------
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (!isSurface(e)) continue;
    const a = g.nodes[e.a], b = g.nodes[e.b];
    const angle = Math.atan2(b.z - a.z, b.x - a.x), len = Math.hypot(b.x - a.x, b.z - a.z);
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    const polygon = orientedRect(cx, cz, len, e.width, angle);
    const elevated = isElevated(e);
    const entry = { polygon, cls: e.cls, type: e.cls === 'arterial' ? 'arterial' : 'street', width: e.width, a: [a.x, a.z], b: [b.x, b.z], angle, len, cx, cz, edge: i, bridge: elevated, ...bbox(polygon) };
    if (elevated) model.bridges.push(entry); else model.roads.push(entry);
  }
  model.corridors = buildCorridors(g, config.seed, config.massing);
  model.stats.corridors = model.corridors.length;
  for (let n = 0; n < g.nodes.length; n++) {
    const inc = g.adj[n].filter(e => isSurface(g.edges[e]));
    if (inc.length < 2) continue;
    if (inc.length === 2) {
      const a0 = g.angleFrom(n, inc[0]), a1 = g.angleFrom(n, inc[1]);
      if (angleBetween(a0, a1 + Math.PI) < .06 && g.edges[inc[0]].width === g.edges[inc[1]].width) continue; // straight through
    }
    const r = Math.max(...inc.map(e => g.edges[e].width)) / 2;
    const N = g.nodes[n], poly = [];
    for (let k = 0; k < 12; k++) { const t = k / 12 * Math.PI * 2; poly.push([N.x + Math.cos(t) * r, N.z + Math.sin(t) * r]); }
    model.roadCaps.push({ polygon: poly, x: N.x, z: N.z, r, elevated: inc.every(e => isElevated(g.edges[e])) });
  }

  // ---- faces → blocks ------------------------------------------------------
  const blocksRaw = [];
  for (const f of fx.faces) {
    const [cx, cz] = centroid(f.polygon);
    if (!water.isLand(cx, cz)) continue;
    // A disconnected imported lake ring may be absent from the retained face
    // component. Its containing face still is not a land block, even when the
    // face boundary and centroid happen to be on land. Simplified graph-shore
    // chords also must not turn the water-side sliver into accepted geometry.
    if (!importedFaceOnLand(f.polygon)) continue;
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
    const pieces = buildableAreas(b.face, g, b.zone, config.detail).filter(piece => footprintOnLand(piece));
    b.buildable = pieces[0] || null;
    if (pieces.length > 1) b.buildablePieces = pieces;
    if (!pieces.length) model.stats.offsetDrops++;
  }

  // Landmark: a central, generous, unreserved block.
  {
    const free = blocksRaw.filter(b => b.buildable
      && !model.reserved.some(r => buildablePieces(b).some(poly => polyIntersectsRect(poly, r)))
      && !buildablePieces(b).some(overlapsClaimed));
    const dim = b => { const o = obb(b.buildable); return Math.min(o.w, o.d); };
    let cands = free.filter(b => b.pop > .6 && dim(b) > 50);
    if (!cands.length) cands = free.filter(b => b.pop > .35 && dim(b) > 40);
    if (cands.length) rng.pick(cands).landmark = true;
  }

  const vacants = [];
  const targetParcelBase = dcfg.parcel * dcfg.parcel * P.parcelScale;
  for (const b of blocksRaw) {
    model.blocks.push(b);
    if (b.field) {
      if (proceduralParkAllowed(b.polygon)) model.parks.push({ polygon: b.polygon, field: true, ...bbox(b.polygon) });
      continue;
    }
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
    for (const piece of buildablePieces(b)) model.plazas.push({ polygon: piece, ...bbox(piece) });
    const o = obb(poly);
    const size = Math.min(o.w, o.d) * .42;
    model.landmarks.push({ x: o.cx, z: o.cz, w: size, d: size, h: config.density === 'extreme' ? 210 : 145, angle: o.angle });
    const n = 10;
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2;
      const c = Math.cos(o.angle), s = Math.sin(o.angle);
      const u = Math.cos(t) * o.w * .42, v = Math.sin(t) * o.d * .42;
      const x = o.cx + u * c - v * s, z = o.cz + u * s + v * c;
      if (pointInPolygon(x, z, poly) && proceduralTreeAllowed(x, z)) model.trees.push({ x, z, s: rng.float(.8, 1.2) });
    }
  }

  function addPark(b) {
    const pieces = buildablePieces(b).filter(proceduralParkAllowed);
    const total = pieces.reduce((sum, piece) => sum + area(piece), 0);
    for (const poly of pieces) {
      model.parks.push({ polygon: poly, ...bbox(poly) });
      const count = pieces.length === 1 ? Math.max(4, Math.floor(b.area / 2600))
        : Math.max(2, Math.floor(b.area / 2600 * area(poly) / total));
      scatterTrees(poly, count, rng, model, [.7, 1.35], proceduralTreeAllowed);
    }
  }

  // Euro blocks are a single polygonal building around a courtyard. Blocks
  // crossed by reserved infrastructure, too small for a useful court, or
  // rejected by the robust inset fall back to the ordinary parcel grammar.
  function makePerimeter(b) {
    if (b.buildablePieces) return false;
    const outer = b.buildable;
    if (model.reserved.some(r => polyIntersectsRect(outer, r))) return false;
    if (!footprintOnLand(outer)) return false;
    if (overlapsClaimed(outer)) return false;

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
    for (const buildable of buildablePieces(b)) {
      const { parcels, slivers } = subdivideParcels(buildable, { targetArea: target, minWidth: 9, rng });
      model.stats.slivers += slivers;
      const frontageFor = poly => findFrontage(poly, buildable, b.face, g);
      const merged = mergeLandlockedParcels(parcels, frontageFor);
      for (const { polygon: poly, frontage: fr } of merged.parcels) {
        if (!footprintOnLand(poly)) continue;
        const parcel = { polygon: poly, zone: b.zone, dist: b.dist, pop: b.pop, frontage: fr, landlocked: !fr, block: b, ...bbox(poly) };
        model.parcels.push(parcel);
        if (!fr) {
          model.stats.landlocked++;
          if (proceduralParkAllowed(poly)) model.parks.push({ polygon: poly, court: true, ...bbox(poly) });
          continue;
        }
        // Reserved corridors take their right-of-way out of the lot.
        let usable = poly;
        for (const r of model.reserved) { usable = trimPolyAgainstRect(usable, r); if (!usable) break; }
        if (!usable) { courtyardFallback(parcel); continue; }
        const rect = fitRect(usable, fr.angle, 0);
        if (!rect || rect.w < 5.5 || rect.d < 5.5) { courtyardFallback(parcel); continue; }
        if (rng.bool(config.density === 'low' ? .12 : .045)) {
          parcel.vacant = true;
          vacants.push({ ...rect, dist: b.dist });
          continue;
        }
        const bs = massBuilding({ ...rect, zone: b.zone, dist: b.dist }, config, dcfg, rng)
          .filter(bl => {
            const footprint = orientedRect(bl.cx, bl.cz, bl.w, bl.d, bl.angle || 0);
            return footprintOnLand(footprint) && !overlapsClaimed(footprint);
          });
        if (!bs.length) { courtyardFallback(parcel); continue; }
        for (const bl of bs) model.buildings.push(bl);
        parcel.built = true;
      }
    }
  }

  function courtyardFallback(parcel) {
    parcel.fallback = 'courtyard';
    if (proceduralParkAllowed(parcel.polygon)) {
      model.parks.push({ polygon: parcel.polygon, court: true, fallback: 'courtyard', ...bbox(parcel.polygon) });
    }
  }

  // A face centroid can be on land while an inset edge still crosses a river
  // or coast. Sample every buildable/parcel/building edge densely enough that
  // the same signed-distance water field governs the whole footprint, not
  // merely its centre or corners. Imported polygons additionally receive exact
  // ring-intersection and containment checks: dense boundary samples alone
  // cannot detect a closed lake wholly enclosed by an otherwise-land polygon.
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
    if (water.kind !== 'imported') return true;
    if (containsImportedWater(poly)) return false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      for (const polygon of water.polygons) for (const ring of polygon) {
        const count = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
          ? ring.length - 1 : ring.length;
        for (let j = 0; j < count; j++) {
          const p = ring[j], q = ring[(j + 1) % count];
          if (segIntersect(a[0], a[1], b[0], b[1], p[0], p[1], q[0], q[1])) return false;
        }
      }
    }
    return true;
  }

  function importedRingCount(ring) {
    return ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
      ? ring.length - 1 : ring.length;
  }

  function importedFaceOnLand(poly) {
    if (water.kind !== 'imported') return true;
    if (containsImportedWater(poly)) return false;
    for (const point of poly) if (!water.isLand(point[0], point[1])) return false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      for (const polygon of water.polygons) for (const ring of polygon) {
        const count = importedRingCount(ring);
        for (let j = 0; j < count; j++) {
          const p = ring[j], q = ring[(j + 1) % count];
          if (segIntersect(a[0], a[1], b[0], b[1], p[0], p[1], q[0], q[1])) return false;
        }
      }
    }
    return true;
  }

  function containsImportedWater(poly) {
    if (water.kind !== 'imported') return false;
    // Vertices or edge midpoints of an imported outer ring inside the candidate
    // prove that candidate encloses water, including thin ribbons whose corners
    // sit outside the face.
    for (const polygon of water.polygons) {
      const outer = polygon[0] || [];
      const count = importedRingCount(outer);
      for (let i = 0; i < count; i++) {
        if (pointInPolygon(outer[i][0], outer[i][1], poly)) return true;
        const q = outer[(i + 1) % count];
        const mx = (outer[i][0] + q[0]) / 2, mz = (outer[i][1] + q[1]) / 2;
        if (pointInPolygon(mx, mz, poly) && !water.isLand(mx, mz)) return true;
      }
    }
    return false;
  }

  function overlapsClaimed(poly) {
    return claimed.length > 0 && claimed.some(other => polygonsIntersect(poly, other));
  }

  // Geographic output predates these open-space constraints. Hybrid alone
  // treats imported claims, water, and infrastructure as authoritative for
  // procedural parks and for every tree produced during fabric generation.
  function proceduralParkAllowed(poly) {
    return config.source !== 'hybrid' || (footprintOnLand(poly)
      && !model.reserved.some(rect => polyIntersectsRect(poly, rect))
      && !overlapsClaimed(poly));
  }

  function proceduralTreeAllowed(x, z) {
    if (config.source !== 'hybrid') return true;
    if (!(water.sdf(x, z) > .5)) return false;
    if (model.reserved.some(rect => x >= rect.x && x <= rect.x + rect.w && z >= rect.z && z <= rect.z + rect.d)) return false;
    return !importedBuildingClaims.some(poly => pointInPolygon(x, z, poly));
  }

  function buildablePieces(block) {
    return block.buildablePieces || (block.buildable ? [block.buildable] : []);
  }
}

function polygonsIntersect(a, b) {
  const aa = bbox(a), bb = bbox(b);
  if (!(aa.x < bb.x + bb.w && aa.x + aa.w > bb.x && aa.z < bb.z + bb.d && aa.z + aa.d > bb.z)) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length];
      if (segIntersect(p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1])) return true;
    }
  }
  return pointInPolygon(a[0][0], a[0][1], b) || pointInPolygon(b[0][0], b[0][1], a);
}

export function scatterTrees(poly, n, rng, model, sRange, accept = () => true) {
  const b = bbox(poly);
  let placed = 0, tries = 0;
  while (placed < n && tries++ < n * 12) {
    const x = rng.float(b.x + 4, b.x + b.w - 4), z = rng.float(b.z + 4, b.z + b.d - 4);
    if (!pointInPolygon(x, z, poly) || !accept(x, z)) continue;
    model.trees.push({ x, z, s: rng.float(sRange[0], sRange[1]) });
    placed++;
  }
}
