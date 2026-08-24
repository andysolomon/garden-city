// CityModel generation. No rendering code in this file — it produces plain
// data that any renderer (solid, ink, map, export) can consume.
//
// Pipeline order matters:
//   land → rail plan (reserves corridors) → street subdivision → road/water
//   clipping (bridges) → landmark site → blocks → parcels → buildings → life
// Infrastructure claims its footprint BEFORE buildings are placed, so nothing
// is pasted on top of the fabric after the fact.

import { RNG } from './rng.js';

export const CITY_SIZE = 900;

const DENSITY = {
  low:     { depth: 4, minBlock: 100, parcel: 58, height: [8, 42],   park: .18 },
  med:     { depth: 5, minBlock: 78,  parcel: 48, height: [12, 72],  park: .13 },
  high:    { depth: 6, minBlock: 64,  parcel: 40, height: [18, 118], park: .09 },
  extreme: { depth: 6, minBlock: 56,  parcel: 34, height: [22, 170], park: .06 },
};

function intersects(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad &&
         a.z < b.z + b.d + pad && a.z + a.d > b.z - pad;
}

export function generateCity(config) {
  const rng = new RNG(config.seed + ':city');
  const dcfg = DENSITY[config.density];
  const model = {
    config, seed: config.seed, size: CITY_SIZE,
    roads: [], bridges: [], blocks: [], parcels: [], buildings: [],
    parks: [], plazas: [], trees: [], cars: [], drones: [], cranes: [],
    rail: null, landmarks: [], water: [], reserved: [],
  };

  const land = makeLand(config.land, rng, model);

  // Rail is planned before any building exists so the corridor can be reserved.
  planRail(config.rail, model, rng);

  // ---- street network + raw blocks via recursive subdivision -------------
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

  // ---- STEP 1: roads respect water — clip and emit explicit bridges ------
  clipRoadsToWater(model, land, rng);

  // ---- STEP 2a: landmark claims a whole block before parcelization -------
  chooseLandmark(model, blocksRaw, rng, config);

  // ---- blocks → parks / plaza / parcels + buildings -----------------------
  const vacants = [];
  for (const b of blocksRaw) {
    model.blocks.push(b);
    if (b.landmark) { makePlaza(b); continue; }
    const parkChance = dcfg.park + (b.zone === 'civic' ? .08 : 0);
    if (rng.bool(parkChance)) { addPark(b); continue; }
    subdivideParcels(b);
  }

  // Construction sites on a couple of vacant lots (a nod to the poster crane).
  const craneSites = vacants.filter(p => p.dist < .6);
  for (let i = 0; i < Math.min(2, craneSites.length); i++) {
    const p = craneSites.splice(rng.int(0, craneSites.length - 1), 1)[0];
    model.cranes.push({
      x: p.x + p.w / 2, z: p.z + p.d / 2,
      h: rng.float(70, 115), jib: rng.float(42, 68), dir: rng.bool() ? 'x' : 'z',
    });
  }

  addLife(config.life, model, rng);
  addAir(config.air, model, rng);
  return model;

  function makePlaza(b) {
    model.plazas.push({ x: b.x, z: b.z, w: b.w, d: b.d });
    const size = Math.min(b.w, b.d) * .42;
    model.landmarks.push({
      x: b.x + b.w / 2, z: b.z + b.d / 2, w: size, d: size,
      h: config.density === 'extreme' ? 210 : 145,
    });
    const n = 10;
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2;
      model.trees.push({
        x: b.x + b.w / 2 + Math.cos(t) * (b.w * .42),
        z: b.z + b.d / 2 + Math.sin(t) * (b.d * .42),
        s: rng.float(.8, 1.2),
      });
    }
  }

  function addPark(b) {
    model.parks.push({ x: b.x, z: b.z, w: b.w, d: b.d });
    const n = Math.max(4, Math.floor((b.w * b.d) / 2600));
    for (let i = 0; i < n; i++) {
      model.trees.push({ x: rng.float(b.x + 7, b.x + b.w - 7), z: rng.float(b.z + 7, b.z + b.d - 7), s: rng.float(.7, 1.35) });
    }
  }

  function subdivideParcels(b) {
    const cols = Math.max(1, Math.floor(b.w / dcfg.parcel));
    const rows = Math.max(1, Math.floor(b.d / dcfg.parcel));
    const cw = b.w / cols, rd = b.d / rows;
    for (let iz = 0; iz < rows; iz++) for (let ix = 0; ix < cols; ix++) {
      const gap = rng.float(3.5, 7.5);
      const p = {
        x: b.x + ix * cw + gap, z: b.z + iz * rd + gap,
        w: Math.max(7, cw - gap * 2), d: Math.max(7, rd - gap * 2),
        zone: b.zone, dist: b.dist,
      };
      model.parcels.push(p);
      // STEP 2b: parcels inside a reserved corridor (rail, station) stay empty.
      if (model.reserved.some(r => intersects(p, r, 2))) continue;
      if (rng.bool(config.density === 'low' ? .12 : .045)) { vacants.push(p); continue; }
      addBuilding(p);
    }
  }

  function addBuilding(p) {
    let [h0, h1] = dcfg.height;
    let centerBias = Math.pow(1 - Math.min(1, p.dist), 1.55);
    if (config.massing === 'core') centerBias = Math.pow(1 - Math.min(1, p.dist), 2.4) * 1.25;
    if (config.massing === 'lowrise') { h1 = Math.min(h1, 36); centerBias *= .35; }
    if (config.massing === 'euro') { h0 = 10; h1 = Math.min(h1, 34); centerBias = .3 + .25 * centerBias; }
    if (config.massing === 'industrial') { h0 = 7; h1 = 26; centerBias = .2; }

    const zoneScale = { residential: .72, commercial: 1.25, industrial: .42, civic: .88, mixed: 1 }[p.zone] || 1;
    let h = (h0 + (h1 - h0) * (0.16 + 0.84 * centerBias) * rng.float(.55, 1.16)) * zoneScale;
    if (config.massing === 'mixed' && rng.bool(.08 + centerBias * .14)) h *= rng.float(1.35, 2.0);
    h = Math.max(5, h);

    const set = rng.float(1.5, 4.5);
    const x = p.x + set, z = p.z + set, w = Math.max(5, p.w - set * 2), d = Math.max(5, p.d - set * 2);
    const style = chooseBuildingStyle(config.massing, p.zone, rng);
    const b = { x, z, w, d, h, zone: p.zone, style };
    model.buildings.push(b);

    // Tiny massing grammar: tall parcels may get a podium + set-back tower.
    if (h > 58 && w > 13 && d > 13 && rng.bool(.58)) {
      const topH = h * rng.float(.48, .72), inset = rng.float(2.2, Math.min(6, Math.min(w, d) * .2));
      b.h -= topH * .22;
      model.buildings.push({ x: x + inset, z: z + inset, w: w - inset * 2, d: d - inset * 2, h: topH, y: b.h, zone: p.zone, style: 'tower' });
    }
  }
}

// ---------------------------------------------------------------------------
// Land: mask decides where blocks may exist; kind data drives road clipping.
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
    return { kind, edge, mask: cx => cx > edge + 22 };
  }
  if (kind === 'island') {
    const rx = CITY_SIZE * .43, rz = CITY_SIZE * .38;
    model.water.push({ x: -CITY_SIZE * .65, z: -CITY_SIZE * .65, w: CITY_SIZE * 1.3, d: CITY_SIZE * 1.3, type: 'sea' });
    return { kind, rx, rz, mask: (cx, cz) => (cx / rx) ** 2 + (cz / rz) ** 2 < 1 };
  }
  return { kind: 'flat', mask: () => true };
}

// STEP 1 core: roads never pave over water. River crossings become explicit
// bridge spans (arterials always bridge, minor streets sometimes); coast and
// island roads are truncated at the shoreline.
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
        if (bridge) model.bridges.push({ x: x0 - 5, z: r.z, w: (x1 - x0) + 10, d: r.d, level: r.level, horiz: true });
      } else {
        const cx = r.x + r.w / 2;
        if (cx > x0 - 6 && cx < x1 + 6) continue; // road running down the river: drop
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

// STEP 2: rail is planned first and reserves its right-of-way (plus station
// footprint), so the fabric grows around the line instead of under it.
function planRail(kind, model, rng) {
  if (kind === 'none') return;
  const vertical = rng.bool();
  let offset = rng.float(-100, 100);
  const elevated = kind === 'elevated' || kind === 'terminal';

  // A river is a vertical strip; keep a vertical line (parallel to it) on dry
  // land, and keep the station off the water entirely.
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
  model.rail = rail;
}

function chooseLandmark(model, blocksRaw, rng, config) {
  const free = blocksRaw.filter(b => !model.reserved.some(r => intersects(b, r, 4)));
  let candidates = free.filter(b => b.dist < .28 && Math.min(b.w, b.d) > 55);
  // Rivers/rail can eat the geometric center; fall back to the biggest
  // reasonably central block rather than skipping the landmark entirely.
  if (!candidates.length) candidates = free.filter(b => b.dist < .42 && Math.min(b.w, b.d) > 44);
  if (!candidates.length) return;
  rng.pick(candidates).landmark = true;
}

function pickZone(sector, dist, rng) {
  if (sector !== 'mixed') return sector;
  const r = rng.next();
  if (dist < .22 && r < .62) return 'commercial';
  if (r < .48) return 'residential';
  if (r < .70) return 'mixed';
  if (r < .84) return 'commercial';
  if (r < .94) return 'industrial';
  return 'civic';
}

function chooseBuildingStyle(massing, zone, rng) {
  if (massing === 'industrial' || zone === 'industrial') return rng.pick(['shed', 'warehouse', 'stack']);
  if (massing === 'euro') return rng.pick(['perimeter', 'masonry', 'masonry']);
  if (zone === 'civic') return rng.pick(['civic', 'hall']);
  return rng.pick(['slab', 'tower', 'slab', 'block']);
}

function addLife(level, model, rng) {
  if (level === 'off') return;
  const pool = model.roads.concat(model.bridges);
  const carCount = level === 'high' ? 120 : 38;
  for (let i = 0; i < carCount && pool.length; i++) {
    const r = rng.pick(pool);
    const horizontal = r.w > r.d;
    const x = horizontal ? rng.float(r.x + 6, r.x + r.w - 6) : r.x + r.w * .5 + rng.float(-3, 3);
    const z = horizontal ? r.z + r.d * .5 + rng.float(-3, 3) : rng.float(r.z + 6, r.z + r.d - 6);
    model.cars.push({ x, z, rot: horizontal ? 0 : Math.PI / 2, s: rng.float(.85, 1.15), bridge: !!r.horiz && model.bridges.includes(r) });
  }
  if (level === 'high') {
    for (const p of model.parks) {
      for (let i = 0; i < 5; i++) model.trees.push({ x: rng.float(p.x, p.x + p.w), z: rng.float(p.z, p.z + p.d), s: rng.float(.65, 1.2) });
    }
  }
}

function addAir(level, model, rng) {
  if (level === 'none') return;
  const n = level === 'busy' ? 26 : 7;
  for (let i = 0; i < n; i++) {
    model.drones.push({ x: rng.float(-CITY_SIZE * .45, CITY_SIZE * .45), z: rng.float(-CITY_SIZE * .45, CITY_SIZE * .45), y: rng.float(55, 180), s: rng.float(.7, 1.5) });
  }
}
