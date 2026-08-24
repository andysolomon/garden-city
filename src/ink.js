// Ink renderer: the antitecture drafting look, driven by the CityModel.
//
// Technique: every volume is drawn twice —
//   1. a paper-colored MeshBasicMaterial fill (pushed back with polygonOffset)
//      that acts as a hidden-line occluder, and
//   2. jittered line segments for its edges, merged into a handful of big
//      LineSegments objects so the whole city costs a few draw calls.
// A subset of masses gets a translucent tinted fill (depthWrite off) for the
// x-ray poster feel; everything behind them stays visible.

import * as THREE from 'three';
import { RNG } from './rng.js';
import { CITY_SIZE, railRuns } from './model.js';

export const INK_THEMES = {
  day:   { paper: 0xeae6dd, ink: 0x1c1a18, road: 0xded7c7, park: 0xdcd6c2, plaza: 0xe4dfd2, water: 0xaabfc5, accent: 0xe8501e, dark: false },
  dusk:  { paper: 0xe6d8c3, ink: 0x33241d, road: 0xd8c7ab, park: 0xcfc2a1, plaza: 0xdfd2ba, water: 0xb3a6ad, accent: 0xd8451a, dark: false },
  night: { paper: 0x101014, ink: 0xd8d4c8, road: 0x1a1a20, park: 0x171d18, plaza: 0x18181d, water: 0x1e3e50, accent: 0xf06632, dark: true },
};

export function themeFor(config) {
  return INK_THEMES[config.sky] || INK_THEMES.day;
}

const TINTS = [0xe8724a, 0x8aa07a, 0xc8a060, 0xb05540];

class InkLines {
  constructor(rng, jitter) { this.pos = []; this.rng = rng; this.j = jitter; }
  r(scale) { return (this.rng.next() - .5) * scale * 2; }
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
  rect(x, y, z, w, d) {
    this.seg(x, y, z, x + w, y, z); this.seg(x + w, y, z, x + w, y, z + d);
    this.seg(x + w, y, z + d, x, y, z + d); this.seg(x, y, z + d, x, y, z);
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
    color,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    ...opts,
  });
}

function instancedBoxes(specs, material) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const im = new THREE.InstancedMesh(geo, material, specs.length);
  const d = new THREE.Object3D();
  specs.forEach((b, i) => {
    d.position.set(b.x + b.w / 2, (b.y || 0) + b.h / 2, b.z + b.d / 2);
    d.scale.set(b.w, b.h, b.d);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
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
  const main = new InkLines(rng, .55);
  const faint = new InkLines(rng, .45);
  const accent = new InkLines(rng, .5);

  // Ground plate + sub-basement outlines (a signature of the original sheets).
  const plate = { x: -CITY_SIZE / 2 - 45, z: -CITY_SIZE / 2 - 45, w: CITY_SIZE + 90, d: CITY_SIZE + 90 };
  world.add(instancedBoxes([{ ...plate, h: 6, y: -6 }], fillMat(T.paper)));
  main.box(plate.x, -6, plate.z, plate.w, 6, plate.d, 0);
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
    world.add(instancedBoxes([{ ...w, h: 1.6, y: .2 }],
      fillMat(T.water, { transparent: true, opacity: .5, depthWrite: false })));
    faint.rect(w.x, 2.2, w.z, w.w, w.d);
    if (w.type === 'sea') {
      const rx = CITY_SIZE * .445, rz = CITY_SIZE * .395;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(rx, rx, 2.4, 48), fillMat(T.paper));
      disc.scale.z = rz / rx;
      disc.position.y = 1.4;
      world.add(disc);
      main.ring(0, 2.8, 0, rx, 48, rz);
    }
  }

  // Roads: quiet fills; arterials get an outline.
  const roadFills = model.roads.map(r => ({ ...r, h: .9, y: .2 }));
  if (roadFills.length) world.add(instancedBoxes(roadFills, fillMat(T.road)));
  for (const r of model.roads.filter(r => r.type === 'arterial')) faint.rect(r.x, 1.4, r.z, r.w, r.d);

  // Bridges: paper deck + drawn structure.
  for (const b of model.bridges) {
    world.add(instancedBoxes([{ ...b, h: 2.2, y: 3.4 }], fillMat(T.paper)));
    main.box(b.x, 3.4, b.z, b.w, 2.2, b.d);
    main.seg(b.x, 8.6, b.z + .6, b.x + b.w, 8.6, b.z + .6);
    main.seg(b.x, 8.6, b.z + b.d - .6, b.x + b.w, 8.6, b.z + b.d - .6);
    for (let t = 0; t <= 4; t++) {
      const px = b.x + b.w * t / 4;
      faint.seg(px, 5.6, b.z + .6, px, 8.6, b.z + .6);
      faint.seg(px, 5.6, b.z + b.d - .6, px, 8.6, b.z + b.d - .6);
    }
  }

  // Parks + plazas.
  const parkFills = model.parks.map(p => ({ ...p, h: 1.1, y: .2 }));
  if (parkFills.length) world.add(instancedBoxes(parkFills, fillMat(T.park)));
  for (const p of model.parks) faint.rect(p.x, 1.5, p.z, p.w, p.d);
  const plazaFills = model.plazas.map(p => ({ ...p, h: 1.3, y: .2 }));
  if (plazaFills.length) world.add(instancedBoxes(plazaFills, fillMat(T.plaza)));
  for (const p of model.plazas) faint.rect(p.x, 1.7, p.z, p.w, p.d);

  // Buildings: paper occluder fills + ink edges; ~10% get an x-ray tint.
  const paperSpecs = [], tinted = new Map();
  for (const b of model.buildings) {
    main.box(b.x, b.y || 0, b.z, b.w, b.h, b.d);
    if (b.h > 30 && rng.bool(.1)) {
      const c = rng.pick(TINTS);
      if (!tinted.has(c)) tinted.set(c, []);
      tinted.get(c).push(b);
    } else {
      paperSpecs.push(b);
    }
  }
  if (paperSpecs.length) world.add(instancedBoxes(paperSpecs, fillMat(T.paper)));
  for (const [c, arr] of tinted) {
    world.add(instancedBoxes(arr, fillMat(c, { transparent: true, opacity: night ? .3 : .2, depthWrite: false })));
  }

  // Landmark: accent-tinted x-ray volume with accent-colored edges + spire line.
  for (const l of model.landmarks) {
    const spec = { x: l.x - l.w / 2, z: l.z - l.d / 2, w: l.w, d: l.d, h: l.h };
    world.add(instancedBoxes([spec], fillMat(T.accent, { transparent: true, opacity: .16, depthWrite: false })));
    accent.box(spec.x, 0, spec.z, spec.w, spec.h, spec.d);
    accent.seg(l.x, l.h, l.z, l.x, l.h + l.h * .3, l.z);
    for (let f = 1; f < 5; f++) accent.rect(spec.x, l.h * f / 5, spec.z, spec.w, spec.d);
  }

  renderInkRail(world, model, main, faint, T);

  // Cranes: pure line work, straight from the original poster language.
  for (const c of model.cranes) {
    main.seg(c.x, 0, c.z, c.x, c.h, c.z);
    if (c.dir === 'x') {
      main.seg(c.x, c.h, c.z, c.x + c.jib, c.h - 3, c.z);
      main.seg(c.x, c.h, c.z, c.x - c.jib * .35, c.h - 1.5, c.z);
      faint.seg(c.x + c.jib * .7, c.h - 3, c.z, c.x + c.jib * .7, c.h * .45, c.z);
    } else {
      main.seg(c.x, c.h, c.z, c.x, c.h - 3, c.z + c.jib);
      main.seg(c.x, c.h, c.z, c.x, c.h - 1.5, c.z - c.jib * .35);
      faint.seg(c.x, c.h - 3, c.z + c.jib * .7, c.x, c.h * .45, c.z + c.jib * .7);
    }
  }

  // Trees: stem + crown ring. Cars: small edge boxes. Drones: crosses.
  for (const t of model.trees) {
    faint.seg(t.x, 0, t.z, t.x, 8 * t.s, t.z);
    faint.ring(t.x, 9.5 * t.s, t.z, 4.2 * t.s, 7);
  }
  for (const c of model.cars) {
    const y = c.bridge ? 5.6 : .2;
    const w = c.rot === 0 ? 6 * c.s : 3.2 * c.s, d = c.rot === 0 ? 3.2 * c.s : 6 * c.s;
    faint.box(c.x - w / 2, y, c.z - d / 2, w, 2.4 * c.s, d, 0);
  }
  for (const a of model.drones) {
    faint.seg(a.x - 5 * a.s, a.y, a.z, a.x + 5 * a.s, a.y, a.z);
    faint.seg(a.x, a.y, a.z - 3 * a.s, a.x, a.y, a.z + 3 * a.s);
  }

  world.add(main.build(T.ink, .92));
  world.add(faint.build(T.ink, .38));
  world.add(accent.build(T.accent, .95));
}

function renderInkRail(world, model, main, faint, T) {
  const r = model.rail;
  if (!r) return;
  const y = r.elevated ? 15 : 2.1;
  // Map an along-axis coordinate + lateral offset onto world [x, z].
  const P = (q, o) => (r.vertical ? [r.offset + o, q] : [q, r.offset + o]);
  const line = (L, q0, q1, o, yy) => {
    const [x0, z0] = P(q0, o), [x1, z1] = P(q1, o);
    L.seg(x0, yy, z0, x1, yy, z1);
  };
  const cross = (L, q, o0, o1, yy) => {
    const [x0, z0] = P(q, o0), [x1, z1] = P(q, o1);
    L.seg(x0, yy, z0, x1, yy, z1);
  };
  const boxAt = (L, q, qlen, o, olen, h, yy) => {
    const [x, z] = P(q, o);
    L.box(x, yy, z, r.vertical ? olen : qlen, h, r.vertical ? qlen : olen, 0);
  };

  for (const [a, b] of railRuns(r)) {
    line(main, a, b, -5.2, y);
    line(main, a, b, 5.2, y);
    for (let q = a; q < b; q += 18) cross(faint, q, -8, 8, y - .3);
  }
  if (r.elevated) {
    for (let q = r.extent.from; q < r.extent.to; q += 70) boxAt(main, q, 8, -4, 8, 14, 0);
  }
  if (r.crossing === 'viaduct') {
    for (const s of r.spans) {
      boxAt(main, s.from, s.to - s.from, -8, 16, 2.2, y - 2.6);
      for (let q = s.from + 8; q < s.to - 8; q += 26) boxAt(main, q, 6, -5, 10, y - 2.6, 0);
    }
  }
  if (r.crossing === 'tunnel') {
    for (const s of r.spans) {
      boxAt(main, s.from - 6, 6, -9, 18, 7, 0);   // portal head-walls
      boxAt(main, s.to, 6, -9, 18, 7, 0);
      // dashed subsurface alignment, in the language of the basement outlines
      for (let q = s.from; q < s.to; q += 16) line(faint, q, Math.min(q + 9, s.to), 0, -9);
    }
  }
  if (r.station) {
    const s = r.station;
    world.add(instancedBoxes([{ ...s, h: 24 }],
      fillMat(T.accent, { transparent: true, opacity: .18, depthWrite: false })));
    main.box(s.x, 0, s.z, s.w, 24, s.d);
    // Vault ribs over the concourse, per the original Gewölbebau sheets.
    const along = s.w > s.d;
    const ribs = 6;
    for (let i = 0; i <= ribs; i++) {
      const t = i / ribs;
      if (along) {
        const px = s.x + s.w * t;
        for (let k = 0; k < 8; k++) {
          const a0 = k / 8, a1 = (k + 1) / 8;
          main.seg(px, 24 + Math.sin(a0 * Math.PI) * 10, s.z + s.d * a0, px, 24 + Math.sin(a1 * Math.PI) * 10, s.z + s.d * a1);
        }
      } else {
        const pz = s.z + s.d * t;
        for (let k = 0; k < 8; k++) {
          const a0 = k / 8, a1 = (k + 1) / 8;
          main.seg(s.x + s.w * a0, 24 + Math.sin(a0 * Math.PI) * 10, pz, s.x + s.w * a1, 24 + Math.sin(a1 * Math.PI) * 10, pz);
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

export function posterMeta(model) {
  const r = new RNG(model.seed + ':meta');
  const [title, taxo, type] = TITLES[model.config.massing] || TITLES.mixed;
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
