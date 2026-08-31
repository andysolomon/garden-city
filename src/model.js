// CityModel generation. No rendering code in this file — it produces plain
// data that any renderer (solid, ink, map, export) can consume.
//
// Two fabric engines share the same infrastructure steps:
//   graph (default) — planar road graph grown under fields; blocks are the
//                     faces of the graph (docs/V2-ROAD-GRAPH.md)
//   bsp             — V1 recursive rectangular subdivision, kept behind
//                     config.engine = 'bsp' so a broken graph never blocks
//                     renderer work
//
// Pipeline order matters:
//   land → rail plan (reserves corridors) → fabric engine → life
// Infrastructure claims its footprint BEFORE buildings are placed.
//
// Model contract (both engines emit the same shapes):
//   roads/bridges: { polygon, type, width, a, b, angle, len, cx, cz, x,z,w,d }
//   blocks/parks/plazas/parcels: { polygon, x,z,w,d, … }
//   buildings: { cx, cz, w, d, h, y, angle, zone, style, x, z,
//                footprint?, courtyard? }
//   landmarks: { x, z, w, d, h, angle }   (x,z = centre)

import { RNG } from './rng.js';
import { CITY_SIZE, DENSITY, intersects, pickZone, massBuilding } from './common.js';
import { graphFabric } from './fabric.js';
import { rectPoly, bbox, pointInPolygon } from './geom.js';
import { buildDrivableAdjacency, lengthBudgetDijkstra, shortestPath, positionOnRoute, sampleTraffic } from './routing.js';

export { CITY_SIZE } from './common.js';
export { TRAFFIC_SAMPLE_COUNT } from './routing.js';
export const WALKSHED_BUDGET = 300;

export function generateCity(config) {
  config = { engine: 'graph', pattern: 'manhattan', ...config };
  const rng = new RNG(config.seed + ':city');
  const model = {
    config, seed: config.seed, size: CITY_SIZE, engine: config.engine,
    roads: [], roadCaps: [], bridges: [], blocks: [], parcels: [], buildings: [],
    parks: [], plazas: [], trees: [], cars: [], drones: [], cranes: [],
    rail: null, landmarks: [], water: [], reserved: [],
  };

  const land = makeLand(config.land, rng, model);
  // Rail is planned before any building exists so the corridor can be reserved.
  planRail(config.rail, model, rng);

  if (config.engine === 'bsp') bspFabric(model, land, rng, config);
  else graphFabric(model, land, rng, config);

  annotateTraffic(model);
  annotateWalkshed(model);
  normalizeModel(model);
  addLife(config.life, model, rng);
  addAir(config.air, model, rng);
  return model;
}

// Traffic volume is graph analysis, not life simulation: graph cities always
// expose the same bounded, seeded sample while BSP keeps its legacy plain-data
// contract with no graph metadata.
function annotateTraffic(model) {
  const graph = model.graph;
  if (!graph || !model.corridors) return;
  const traffic = sampleTraffic(graph, model.corridors, model.seed);
  model.traffic = traffic;

  for (let edgeId = 0; edgeId < graph.edges.length; edgeId++) {
    graph.edges[edgeId].traffic = traffic.edgeCounts[edgeId] || 0;
  }
  const annotate = entry => { entry.traffic = traffic.edgeCounts[entry.edge] || 0; };
  model.roads.forEach(annotate);
  model.bridges.forEach(annotate);
  for (const corridor of model.corridors) corridor.traffic = traffic.corridorCounts[String(corridor.id)] || 0;
}

// A walkshed is model data, not renderer layout: resolve the terminal to the
// nearest node that participates in the live real road graph, traverse a fixed
// physical-length budget, then annotate each graph block by the nearest live
// road node to its centroid. Rail kinds without a station and BSP intentionally
// have none.
function annotateWalkshed(model) {
  const station = model.rail?.station, graph = model.graph;
  if (!station || !graph) return;
  const adjacency = buildDrivableAdjacency(graph);
  const sx = station.x + station.w / 2, sz = station.z + station.d / 2;
  let stationNode = -1, nearest = Infinity;
  for (let node = 0; node < graph.nodes.length; node++) {
    if (!adjacency[node].length) continue;
    const p = graph.nodes[node], distance = Math.hypot(p.x - sx, p.z - sz);
    if (distance < nearest - 1e-12 || (Math.abs(distance - nearest) <= 1e-12 && node < stationNode)) {
      stationNode = node;
      nearest = distance;
    }
  }
  if (stationNode < 0) return;
  const reached = lengthBudgetDijkstra(graph, stationNode, WALKSHED_BUDGET, adjacency);
  if (!reached) return;
  const nodeIds = new Set(reached.nodeIds);
  for (const block of model.blocks) {
    let blockNode = -1, blockDistance = Infinity;
    for (let node = 0; node < graph.nodes.length; node++) {
      if (!adjacency[node].length) continue;
      const p = graph.nodes[node], distance = Math.hypot(p.x - block.cx, p.z - block.cz);
      if (distance < blockDistance - 1e-12 || (Math.abs(distance - blockDistance) <= 1e-12 && node < blockNode)) {
        blockNode = node;
        blockDistance = distance;
      }
    }
    block.walkshed = blockNode >= 0 && nodeIds.has(blockNode);
  }
  model.walkshed = { ...reached, stationNode, stationDistance: nearest };
}

// ---------------------------------------------------------------------------
// Adapter: give every entry both a polygon and a bbox, and every road an
// axis (a, b, angle, width) so renderers and life placement have one path.
// ---------------------------------------------------------------------------
function normalizeModel(model) {
  const withPoly = o => { if (!o.polygon) o.polygon = rectPoly(o); if (o.x === undefined) Object.assign(o, bbox(o.polygon)); return o; };
  for (const list of [model.blocks, model.parks, model.plazas, model.parcels]) list.forEach(withPoly);
  const axis = r => {
    withPoly(r);
    if (r.a) return r;
    const horiz = r.w >= r.d;
    r.a = horiz ? [r.x, r.z + r.d / 2] : [r.x + r.w / 2, r.z];
    r.b = horiz ? [r.x + r.w, r.z + r.d / 2] : [r.x + r.w / 2, r.z + r.d];
    r.angle = horiz ? 0 : Math.PI / 2;
    r.width = horiz ? r.d : r.w;
    r.len = horiz ? r.w : r.d;
    r.cx = r.x + r.w / 2; r.cz = r.z + r.d / 2;
    return r;
  };
  model.roads.forEach(axis);
  model.bridges.forEach(axis);
  for (const b of model.buildings) {
    if (b.cx === undefined) { b.cx = b.x + b.w / 2; b.cz = b.z + b.d / 2; }
    if (b.angle === undefined) b.angle = 0;
    if (b.y === undefined) b.y = 0;
  }
  for (const l of model.landmarks) if (l.angle === undefined) l.angle = 0;
}

// ---------------------------------------------------------------------------
// Land: mask decides where blocks may exist; kind data drives water fields.
// ---------------------------------------------------------------------------
function makeLand(kind, rng, model) {
  if (kind === 'river') {
    const cx = rng.float(-70, 70), width = rng.float(60, 92);
    const x0 = cx - width / 2, x1 = cx + width / 2;
    model.water.push({ x: x0, z: -CITY_SIZE * .56, w: width, d: CITY_SIZE * 1.12, type: 'river' });
    return { kind, x0, x1, mask: (bx, bz, rect) => !(rect.x < x1 + 4 && rect.x + rect.w > x0 - 4) };
  }
  if (kind === 'coast') {
    const edge = rng.float(-250, -120);
    model.water.push({ x: -CITY_SIZE * .72, z: -CITY_SIZE * .56, w: edge + CITY_SIZE * .72, d: CITY_SIZE * 1.12, type: 'coast' });
    return { kind, edge, mask: (cx, cz, rect) => rect ? rect.x >= edge : cx > edge + 22 };
  }
  if (kind === 'island') {
    const rx = CITY_SIZE * .43, rz = CITY_SIZE * .38;
    model.water.push({ x: -CITY_SIZE * .65, z: -CITY_SIZE * .65, w: CITY_SIZE * 1.3, d: CITY_SIZE * 1.3, type: 'sea', rx, rz });
    const shore = Array.from({ length: 56 }, (_, i) => {
      const t = i / 56 * Math.PI * 2;
      return [Math.cos(t) * rx, Math.sin(t) * rz];
    });
    const onLand = (x, z) => pointInPolygon(x, z, shore);
    return { kind, rx, rz, mask: (cx, cz, rect) => {
      const corners = rect
        ? [[rect.x, rect.z], [rect.x + rect.w, rect.z], [rect.x + rect.w, rect.z + rect.d], [rect.x, rect.z + rect.d]]
        : [[cx, cz]];
      return corners.every(([x, z]) => onLand(x, z));
    } };
  }
  return { kind: 'flat', mask: () => true };
}

// Rail is planned first and reserves its right-of-way (plus station
// footprint), so the fabric grows around the line instead of under it.
function planRail(kind, model, rng) {
  if (kind === 'none') return;
  const vertical = rng.bool();
  let offset = rng.float(-100, 100);
  const elevated = kind === 'elevated' || kind === 'terminal';

  const river = model.water.find(w => w.type === 'river');
  if (river && vertical) {
    const x0 = river.x, x1 = river.x + river.w;
    if (offset > x0 - 16 && offset < x1 + 16) {
      offset = Math.abs(x1 + 26) <= Math.abs(x0 - 26) ? x1 + 26 : x0 - 26;
    }
  }

  const rail = { kind, vertical, offset, elevated, terminal: kind === 'terminal' };
  const cw = elevated ? 13 : 17;
  model.reserved.push(vertical
    ? { x: offset - cw / 2, z: -CITY_SIZE / 2, w: cw, d: CITY_SIZE }
    : { x: -CITY_SIZE / 2, z: offset - cw / 2, w: CITY_SIZE, d: cw });

  if (rail.terminal) {
    const s = vertical
      ? { x: offset - 34, z: -70, w: 68, d: 140 }
      : { x: -70, z: offset - 34, w: 140, d: 68 };
    if (river && !vertical && s.x < river.x + river.w + 10 && s.x + s.w > river.x - 10) {
      const right = river.x + river.w + 14, left = river.x - 14 - s.w;
      s.x = Math.abs(right + s.w / 2) <= Math.abs(left + s.w / 2) ? right : left;
    }
    rail.station = s;
    model.reserved.push({ x: s.x - 6, z: s.z - 6, w: s.w + 12, d: s.d + 12 });
  }

  // Where the line meets water: an elevated line carries a viaduct across,
  // an at-grade metro tunnels under, and open sea truncates it at the shore.
  // `extent` is measured along the line's own axis.
  const half = CITY_SIZE * .515;
  rail.extent = { from: -half, to: half };
  rail.spans = [];

  const coast = model.water.find(w => w.type === 'coast');
  const sea = model.water.find(w => w.type === 'sea');

  if (river && !vertical) rail.spans.push({ from: river.x - 9, to: river.x + river.w + 9 });
  if (coast && !vertical) rail.extent.from = Math.max(rail.extent.from, coast.x + coast.w + 22);
  if (sea) {
    const rx = CITY_SIZE * .43, rz = CITY_SIZE * .38;
    const q = 1 - (offset / (vertical ? rx : rz)) ** 2;
    if (q > .02) {
      const chord = (vertical ? rz : rx) * Math.sqrt(q);
      rail.extent = { from: -chord, to: chord };
    }
  }
  rail.crossing = rail.spans.length ? (elevated ? 'viaduct' : 'tunnel') : 'none';
  model.rail = rail;
}

// The continuous runs of track, along the line's own axis: a tunnelled
// crossing removes its span from the surface alignment, everything else
// stays whole.
export function railRuns(r) {
  const runs = [];
  let cursor = r.extent.from;
  const cuts = r.crossing === 'tunnel' ? r.spans : [];
  for (const s of cuts) {
    if (s.from > cursor) runs.push([cursor, Math.min(s.from, r.extent.to)]);
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < r.extent.to) runs.push([cursor, r.extent.to]);
  return runs;
}

// ---------------------------------------------------------------------------
// V1 fabric: recursive rectangular subdivision (kept verbatim in spirit).
// ---------------------------------------------------------------------------
function trimAgainst(p, r, pad = 2, minSide = 11) {
  if (!p || !intersects(p, r, pad)) return p;
  const rx0 = r.x - pad, rx1 = r.x + r.w + pad;
  const rz0 = r.z - pad, rz1 = r.z + r.d + pad;
  const options = [
    { ...p, w: rx0 - p.x }, { ...p, x: rx1, w: p.x + p.w - rx1 },
    { ...p, d: rz0 - p.z }, { ...p, z: rz1, d: p.z + p.d - rz1 },
  ];
  let best = null;
  for (const o of options) {
    if (o.w < minSide || o.d < minSide) continue;
    if (!best || o.w * o.d > best.w * best.d) best = o;
  }
  return best;
}

function bspFabric(model, land, rng, config) {
  const dcfg = DENSITY[config.density];
  const blocksRaw = [];
  subdivide({ x: -CITY_SIZE / 2, z: -CITY_SIZE / 2, w: CITY_SIZE, d: CITY_SIZE }, 0);

  function subdivide(rect, level) {
    const canV = rect.w > dcfg.minBlock * 2.05;
    const canH = rect.d > dcfg.minBlock * 2.05;
    const stop = level >= dcfg.depth || (!canV && !canH) || (level > 2 && rng.bool(.12));
    if (stop) { addBlock(rect); return; }
    let vertical;
    if (canV && !canH) vertical = true;
    else if (canH && !canV) vertical = false;
    else {
      const aspect = rect.w / rect.d;
      vertical = aspect > 1.2 ? true : aspect < .83 ? false : rng.bool();
    }
    const roadW = level === 0 ? 28 : level === 1 ? 20 : level <= 3 ? 13 : 9;
    if (vertical) {
      const available = rect.w - roadW;
      const cut = Math.min(available - dcfg.minBlock, Math.max(dcfg.minBlock, available * rng.float(.38, .62)));
      const rx = rect.x + cut;
      model.roads.push({ x: rx, z: rect.z, w: roadW, d: rect.d, level, type: level < 2 ? 'arterial' : 'street' });
      subdivide({ x: rect.x, z: rect.z, w: cut, d: rect.d }, level + 1);
      subdivide({ x: rx + roadW, z: rect.z, w: rect.w - cut - roadW, d: rect.d }, level + 1);
    } else {
      const available = rect.d - roadW;
      const cut = Math.min(available - dcfg.minBlock, Math.max(dcfg.minBlock, available * rng.float(.38, .62)));
      const rz = rect.z + cut;
      model.roads.push({ x: rect.x, z: rz, w: rect.w, d: roadW, level, type: level < 2 ? 'arterial' : 'street' });
      subdivide({ x: rect.x, z: rect.z, w: rect.w, d: cut }, level + 1);
      subdivide({ x: rect.x, z: rz + roadW, w: rect.w, d: rect.d - cut - roadW }, level + 1);
    }
  }

  function addBlock(rect) {
    const inset = config.detail === 'high' ? 7 : 9;
    const b = { x: rect.x + inset, z: rect.z + inset, w: Math.max(4, rect.w - inset * 2), d: Math.max(4, rect.d - inset * 2) };
    if (!land.mask(b.x + b.w / 2, b.z + b.d / 2, b)) return;
    b.dist = Math.hypot(b.x + b.w / 2, b.z + b.d / 2) / (CITY_SIZE * .707);
    b.zone = pickZone(config.sector, b.dist, rng);
    blocksRaw.push(b);
  }

  clipRoadsToWater(model, land, rng);
  chooseLandmark(model, blocksRaw, rng);

  const vacants = [];
  for (const b of blocksRaw) {
    model.blocks.push(b);
    if (b.landmark) { makePlaza(b); continue; }
    const parkChance = dcfg.park + (b.zone === 'civic' ? .08 : 0);
    if (rng.bool(parkChance)) { addPark(b); continue; }
    subdivideParcels(b);
  }

  const craneSites = vacants.filter(p => p.dist < .6);
  for (let i = 0; i < Math.min(2, craneSites.length); i++) {
    const p = craneSites.splice(rng.int(0, craneSites.length - 1), 1)[0];
    model.cranes.push({ x: p.x + p.w / 2, z: p.z + p.d / 2, h: rng.float(70, 115), jib: rng.float(42, 68), dir: rng.bool() ? 'x' : 'z' });
  }

  function makePlaza(b) {
    model.plazas.push({ x: b.x, z: b.z, w: b.w, d: b.d });
    const size = Math.min(b.w, b.d) * .42;
    model.landmarks.push({ x: b.x + b.w / 2, z: b.z + b.d / 2, w: size, d: size, h: config.density === 'extreme' ? 210 : 145 });
    for (let i = 0; i < 10; i++) {
      const t = i / 10 * Math.PI * 2;
      model.trees.push({ x: b.x + b.w / 2 + Math.cos(t) * (b.w * .42), z: b.z + b.d / 2 + Math.sin(t) * (b.d * .42), s: rng.float(.8, 1.2) });
    }
  }
  function addPark(b) {
    model.parks.push({ x: b.x, z: b.z, w: b.w, d: b.d });
    const n = Math.max(4, Math.floor((b.w * b.d) / 2600));
    for (let i = 0; i < n; i++) model.trees.push({ x: rng.float(b.x + 7, b.x + b.w - 7), z: rng.float(b.z + 7, b.z + b.d - 7), s: rng.float(.7, 1.35) });
  }
  function subdivideParcels(b) {
    const cols = Math.max(1, Math.floor(b.w / dcfg.parcel));
    const rows = Math.max(1, Math.floor(b.d / dcfg.parcel));
    const cw = b.w / cols, rd = b.d / rows;
    for (let iz = 0; iz < rows; iz++) for (let ix = 0; ix < cols; ix++) {
      const gap = rng.float(3.5, 7.5);
      const p = { x: b.x + ix * cw + gap, z: b.z + iz * rd + gap, w: Math.max(7, cw - gap * 2), d: Math.max(7, rd - gap * 2), zone: b.zone, dist: b.dist };
      model.parcels.push(p);
      let usable = p;
      for (const r of model.reserved) { usable = trimAgainst(usable, r); if (!usable) break; }
      if (!usable) continue;
      if (rng.bool(config.density === 'low' ? .12 : .045)) { vacants.push(usable); continue; }
      const spec = { cx: usable.x + usable.w / 2, cz: usable.z + usable.d / 2, w: usable.w, d: usable.d, angle: 0, zone: usable.zone, dist: usable.dist };
      for (const bl of massBuilding(spec, config, dcfg, rng)) model.buildings.push(bl);
    }
  }
}

// V1: roads never pave over water; river crossings become bridge spans.
function clipRoadsToWater(model, land, rng) {
  if (land.kind === 'flat') return;
  const keep = [];
  for (const r of model.roads) {
    const horiz = r.w > r.d;
    if (land.kind === 'river') {
      const { x0, x1 } = land;
      if (horiz) {
        if (!(r.x < x1 && r.x + r.w > x0)) { keep.push(r); continue; }
        const bridge = r.level < 2 || rng.bool(.35);
        if (r.x < x0 - 2) keep.push({ ...r, w: x0 - 2 - r.x });
        if (r.x + r.w > x1 + 2) keep.push({ ...r, x: x1 + 2, w: r.x + r.w - (x1 + 2) });
        if (bridge) model.bridges.push({ x: x0 - 5, z: r.z, w: (x1 - x0) + 10, d: r.d, level: r.level, type: r.type });
      } else {
        const cx = r.x + r.w / 2;
        if (cx > x0 - 6 && cx < x1 + 6) continue;
        keep.push(r);
      }
    } else if (land.kind === 'coast') {
      const e = land.edge + 10;
      if (horiz) {
        if (r.x + r.w <= e) continue;
        keep.push(r.x < e ? { ...r, x: e, w: r.x + r.w - e } : r);
      } else {
        if (r.x + r.w / 2 < e) continue;
        keep.push(r);
      }
    } else if (land.kind === 'island') {
      const rx = land.rx - 14, rz = land.rz - 10;
      if (horiz) {
        const zc = r.z + r.d / 2, q = 1 - (zc / rz) ** 2;
        if (q <= .02) continue;
        const half = rx * Math.sqrt(q);
        const nx = Math.max(r.x, -half), x2 = Math.min(r.x + r.w, half);
        if (x2 - nx < 20) continue;
        keep.push({ ...r, x: nx, w: x2 - nx });
      } else {
        const xc = r.x + r.w / 2, q = 1 - (xc / rx) ** 2;
        if (q <= .02) continue;
        const half = rz * Math.sqrt(q);
        const nz = Math.max(r.z, -half), z2 = Math.min(r.z + r.d, half);
        if (z2 - nz < 20) continue;
        keep.push({ ...r, z: nz, d: z2 - nz });
      }
    }
  }
  model.roads = keep;
}

function chooseLandmark(model, blocksRaw, rng) {
  const free = blocksRaw.filter(b => !model.reserved.some(r => intersects(b, r, 4)));
  let candidates = free.filter(b => b.dist < .28 && Math.min(b.w, b.d) > 55);
  if (!candidates.length) candidates = free.filter(b => b.dist < .42 && Math.min(b.w, b.d) > 44);
  if (!candidates.length) return;
  rng.pick(candidates).landmark = true;
}

// ---------------------------------------------------------------------------
// Life: graph cars follow deterministic routes; BSP cars retain their static
// road-axis placement. Trees and air keep their established :city draw order.
// ---------------------------------------------------------------------------
function addLife(level, model, rng) {
  if (level === 'off') return;
  if (model.engine === 'graph' && model.graph) {
    addRoutedCars(level, model, new RNG(model.seed + ':traffic'));
    // Before routing, graph cars drew from :city. Consume the old sequence so
    // trees and air remain byte-identical outside the new traffic namespace.
    consumeLegacyCarDraws(level, model, rng);
  } else {
    addStaticCars(level, model, rng);
  }
  if (level === 'high') {
    for (const p of model.parks) {
      if (p.field || p.court) continue;
      for (let i = 0, tries = 0; i < 5 && tries < 30; tries++) {
        const x = rng.float(p.x, p.x + p.w), z = rng.float(p.z, p.z + p.d);
        if (!pointInPolygon(x, z, p.polygon)) continue;
        model.trees.push({ x, z, s: rng.float(.65, 1.2) });
        i++;
      }
    }
  }
}

function addStaticCars(level, model, rng) {
  const pool = model.roads.concat(model.bridges);
  const carCount = level === 'high' ? 120 : 38;
  for (let i = 0; i < carCount && pool.length; i++) {
    const r = rng.pick(pool);
    if (r.len < 14) continue;
    const t = rng.float(6 / r.len, 1 - 6 / r.len);
    const lateral = rng.float(-r.width * .25, r.width * .25);
    const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1];
    const nx = -dz / r.len, nz = dx / r.len;
    model.cars.push({
      x: r.a[0] + dx * t + nx * lateral, z: r.a[1] + dz * t + nz * lateral,
      rot: -r.angle, s: rng.float(.85, 1.15), bridge: model.bridges.includes(r),
    });
  }
}

function consumeLegacyCarDraws(level, model, rng) {
  const pool = model.roads.concat(model.bridges);
  const carCount = level === 'high' ? 120 : 38;
  for (let i = 0; i < carCount && pool.length; i++) {
    const r = rng.pick(pool);
    if (r.len < 14) continue;
    rng.float(6 / r.len, 1 - 6 / r.len);
    rng.float(-r.width * .25, r.width * .25);
    rng.float(.85, 1.15);
  }
}

function addRoutedCars(level, model, rng) {
  const graph = model.graph;
  const corridors = (model.corridors || []).filter(c => c.name && c.nodeIds.length > 1 && c.edgeIds.length);
  if (corridors.length < 2) return;
  const adjacency = buildDrivableAdjacency(graph);
  const carCount = level === 'high' ? 120 : 38;

  for (let i = 0; i < carCount; i++) {
    let selected = null;
    const attempts = i === 0 ? 24 : 6;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const origin = rng.pick(corridors);
      const destinations = corridors.filter(c => c.id !== origin.id && c.name !== origin.name);
      if (!destinations.length) continue;
      const destination = rng.pick(destinations);
      const start = rng.pick(origin.nodeIds), goal = rng.pick(destination.nodeIds);
      const route = shortestPath(graph, start, goal, adjacency);
      if (!route || route.edges.length < 2 || route.length < 18) continue;
      const candidate = { origin, destination, route };
      if (!selected || route.edges.length > selected.route.edges.length) selected = candidate;
      if (i !== 0 || routeTurns(graph, route)) { selected = candidate; break; }
    }
    if (!selected) continue;
    const { origin, destination, route } = selected;
    const car = {
      path: route.edges, nodes: route.nodes, routeLength: route.length,
      t: rng.float(0, route.length), speed: rng.float(5.5, 9.5), s: rng.float(.85, 1.15),
      originCorridor: origin.name, originCorridorId: origin.id,
      destinationCorridor: destination.name, destinationCorridorId: destination.id,
    };
    Object.assign(car, positionOnRoute(graph, car, 0));
    model.cars.push(car);
  }
}

function routeTurns(graph, route) {
  for (let i = 1; i < route.nodes.length - 1; i++) {
    const a = graph.nodes[route.nodes[i - 1]], b = graph.nodes[route.nodes[i]], c = graph.nodes[route.nodes[i + 1]];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    const scale = Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z);
    if (Math.abs(cross) > scale * .08) return true;
  }
  return false;
}

function addAir(level, model, rng) {
  if (level === 'none') return;
  const n = level === 'busy' ? 26 : 7;
  for (let i = 0; i < n; i++) {
    model.drones.push({ x: rng.float(-CITY_SIZE * .45, CITY_SIZE * .45), z: rng.float(-CITY_SIZE * .45, CITY_SIZE * .45), y: rng.float(55, 180), s: rng.float(.7, 1.5) });
  }
}
