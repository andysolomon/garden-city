// Shared model vocabulary used by both fabric engines (BSP v1 and the road
// graph): density tables, zoning, building styles and the massing grammar.

export const CITY_SIZE = 900;

export const DENSITY = {
  low:     { depth: 4, minBlock: 100, parcel: 58, height: [8, 42],   park: .18, budget: 620 },
  med:     { depth: 5, minBlock: 78,  parcel: 48, height: [12, 72],  park: .13, budget: 980 },
  high:    { depth: 6, minBlock: 64,  parcel: 40, height: [18, 118], park: .09, budget: 1450 },
  extreme: { depth: 6, minBlock: 56,  parcel: 34, height: [22, 170], park: .06, budget: 1950 },
};

export function intersects(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad &&
         a.z < b.z + b.d + pad && a.z + a.d > b.z - pad;
}

export function pickZone(sector, dist, rng) {
  if (sector !== 'mixed') return sector;
  const r = rng.next();
  if (dist < .22 && r < .62) return 'commercial';
  if (r < .48) return 'residential';
  if (r < .70) return 'mixed';
  if (r < .84) return 'commercial';
  if (r < .94) return 'industrial';
  return 'civic';
}

export function chooseBuildingStyle(massing, zone, rng) {
  if (massing === 'industrial' || zone === 'industrial') return rng.pick(['shed', 'warehouse', 'stack']);
  if (massing === 'euro') return rng.pick(['perimeter', 'masonry', 'masonry']);
  if (zone === 'civic') return rng.pick(['civic', 'hall']);
  return rng.pick(['slab', 'tower', 'slab', 'block']);
}

// Massing grammar for one lot. `p` is an oriented rectangle
// { cx, cz, w, d, angle, zone, dist } (dist: 0 at the densest center → 1 at
// the edge). Returns one or two buildings (podium + set-back tower).
export function massBuilding(p, config, dcfg, rng) {
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
  const w = Math.max(5, p.w - set * 2), d = Math.max(5, p.d - set * 2);
  const angle = p.angle || 0;
  const style = chooseBuildingStyle(config.massing, p.zone, rng);
  const b = building(p.cx, p.cz, w, d, h, 0, angle, p.zone, style);
  const out = [b];

  // Tiny massing grammar: tall parcels may get a podium + set-back tower.
  if (h > 58 && w > 13 && d > 13 && rng.bool(.58)) {
    const topH = h * rng.float(.48, .72), inset = rng.float(2.2, Math.min(6, Math.min(w, d) * .2));
    b.h -= topH * .22;
    out.push(building(p.cx, p.cz, w - inset * 2, d - inset * 2, topH, b.h, angle, p.zone, 'tower'));
  }
  return out;
}

export function building(cx, cz, w, d, h, y, angle, zone, style) {
  return { cx, cz, w, d, h, y, angle, zone, style, x: cx - w / 2, z: cz - d / 2 };
}
