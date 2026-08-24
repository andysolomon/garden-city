// Solid renderer: shaded massing view of a CityModel.

import * as THREE from 'three';
import { mat, addBox } from './render.js';
import { hashSeed } from './rng.js';
import { CITY_SIZE, railRuns } from './model.js';

const palettes = {
  concrete: { bg: 0xd8d2c5, ground: 0xc7c1b5, road: 0x77736d, roadLine: 0xe8dcc2, water: 0x78919c, park: 0x8d967b, build: [0xc7bfae, 0xa9aaa6, 0x998f83, 0xd0c5ad, 0x8f9698], accent: 0xe8501e },
  warm:     { bg: 0xe0d5c5, ground: 0xc8bca7, road: 0x625d58, roadLine: 0xe5cda9, water: 0x7a98a6, park: 0x87906f, build: [0xb35e45, 0xc88d63, 0xd1b184, 0x8e7766, 0xe0c6a0], accent: 0xd84e25 },
  cool:     { bg: 0xd7dde0, ground: 0xbcc5c6, road: 0x606a70, roadLine: 0xdde7e8, water: 0x5f879d, park: 0x82988c, build: [0x8da3ac, 0xaebcc0, 0x6f858d, 0xc1c8c5, 0x667178], accent: 0xd85b37 },
  nocturne: { bg: 0x0b0e13, ground: 0x151a20, road: 0x262c33, roadLine: 0x89919a, water: 0x1e3e50, park: 0x253d32, build: [0x343a42, 0x48464c, 0x2d3640, 0x555156, 0x242b31], accent: 0xf06632 },
};

export function renderSolid(viewer, model) {
  viewer.clearWorld();
  const { scene, world, hemi, sun } = viewer;
  const cfg = model.config;
  const pal = palettes[cfg.palette] || palettes.concrete;

  scene.background = new THREE.Color(pal.bg);
  viewer.viewport.style.background = '#' + pal.bg.toString(16).padStart(6, '0');
  hemi.intensity = cfg.sky === 'night' ? 1.05 : cfg.sky === 'dusk' ? 1.55 : 2.1;
  sun.intensity = cfg.sky === 'night' ? .55 : cfg.sky === 'dusk' ? 1.8 : 3.2;
  sun.color.set(cfg.sky === 'dusk' ? 0xffc28f : cfg.sky === 'night' ? 0x9bb5dc : 0xffffff);

  const groundMat = mat(pal.ground);
  const ground = new THREE.Mesh(new THREE.BoxGeometry(CITY_SIZE + 90, 7, CITY_SIZE + 90), groundMat);
  ground.position.y = -4;
  ground.receiveShadow = true;
  world.add(ground);

  for (const w of model.water) {
    if (w.type === 'sea') {
      const water = new THREE.Mesh(new THREE.BoxGeometry(w.w, 1.8, w.d),
        new THREE.MeshStandardMaterial({ color: pal.water, roughness: .35, metalness: .05, transparent: true, opacity: .78 }));
      water.position.y = 1;
      world.add(water);
      const island = new THREE.Mesh(new THREE.CylinderGeometry(CITY_SIZE * .42, CITY_SIZE * .45, 6, 64), groundMat);
      island.scale.z = .9;
      island.position.y = 2.6;
      world.add(island);
    } else {
      addBox(world, { ...w, h: 2 }, new THREE.MeshStandardMaterial({ color: pal.water, roughness: .35, transparent: true, opacity: .82 }), 1);
    }
  }

  const roadMat = mat(pal.road);
  const arterialMat = mat(new THREE.Color(pal.road).multiplyScalar(.82));
  for (const r of model.roads) addBox(world, { ...r, h: 1.2 }, r.type === 'arterial' ? arterialMat : roadMat, .35);

  // Bridges: deck + parapets + bank piers.
  const deckMat = mat(new THREE.Color(pal.road).multiplyScalar(1.08), .7);
  const pierMat = mat(0x8e8a83);
  for (const b of model.bridges) {
    addBox(world, { ...b, h: 2.4 }, deckMat, 3.4);
    addBox(world, { x: b.x, z: b.z + .4, w: b.w, d: 1.1, h: 2.2 }, deckMat, 5.8);
    addBox(world, { x: b.x, z: b.z + b.d - 1.5, w: b.w, d: 1.1, h: 2.2 }, deckMat, 5.8);
    addBox(world, { x: b.x + 1, z: b.z + 2, w: 3.5, d: b.d - 4, h: 4 }, pierMat, 0);
    addBox(world, { x: b.x + b.w - 4.5, z: b.z + 2, w: 3.5, d: b.d - 4, h: 4 }, pierMat, 0);
  }

  if (cfg.detail !== 'low') {
    const lm = new THREE.MeshBasicMaterial({ color: pal.roadLine, transparent: true, opacity: .62 });
    for (const r of model.roads.filter(r => r.type === 'arterial')) {
      const horizontal = r.w > r.d;
      const spec = horizontal
        ? { x: r.x, z: r.z + r.d / 2 - .45, w: r.w, d: .9, h: .12 }
        : { x: r.x + r.w / 2 - .45, z: r.z, w: .9, d: r.d, h: .12 };
      addBox(world, spec, lm, 1.05);
    }
  }

  const parkMat = mat(pal.park);
  for (const p of model.parks) addBox(world, { ...p, h: 1.3 }, parkMat, .75);
  const plazaMat = mat(new THREE.Color(pal.ground).multiplyScalar(1.08));
  for (const p of model.plazas) addBox(world, { ...p, h: 1.5 }, plazaMat, .75);

  // Buildings, grouped by color into instanced meshes.
  const groups = new Map();
  model.buildings.forEach((b, i) => {
    const color = pal.build[hashSeed(b.zone + b.style + i) % pal.build.length];
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(b);
  });
  const baseGeo = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();
  for (const [color, arr] of groups) {
    const im = new THREE.InstancedMesh(baseGeo, mat(color, .78), arr.length);
    im.castShadow = true;
    im.receiveShadow = true;
    arr.forEach((b, i) => {
      dummy.position.set(b.x + b.w / 2, (b.y || 0) + b.h / 2, b.z + b.d / 2);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    world.add(im);
  }

  const accentMat = mat(pal.accent, .7);
  for (const l of model.landmarks) {
    addBox(world, { x: l.x - l.w / 2, z: l.z - l.d / 2, w: l.w, d: l.d, h: l.h }, accentMat, 0);
    if (cfg.detail === 'high') {
      const spire = new THREE.Mesh(new THREE.ConeGeometry(l.w * .18, l.h * .35, 8), accentMat);
      spire.position.set(l.x, l.h + l.h * .175, l.z);
      world.add(spire);
    }
  }

  renderRail(world, model, pal, cfg);
  renderCranes(world, model);
  renderTrees(world, model, pal);
  renderCars(world, model, pal);
  renderDrones(world, model, pal);
}

// The line is described along its own axis; `seg` maps an along-axis run and
// a lateral offset onto world x/z depending on the line's orientation.
function renderRail(world, model, pal, cfg) {
  const r = model.rail;
  if (!r) return;
  const y = r.elevated ? 15 : 2.1;
  const railMat = mat(0x3d3d40, .45);
  const sleeperMat = mat(0x75695d, .9);
  const supportMat = mat(0x8e8a83);
  const seg = (q, qlen, o, olen, h, material, yy) => {
    if (qlen <= 0) return;
    addBox(world, r.vertical
      ? { x: r.offset + o, z: q, w: olen, d: qlen, h }
      : { x: q, z: r.offset + o, w: qlen, d: olen, h }, material, yy);
  };

  for (const [a, b] of railRuns(r)) {
    seg(a, b - a, -6, 1.6, 1, railMat, y);
    seg(a, b - a, 4.4, 1.6, 1, railMat, y);
    if (cfg.detail !== 'low') for (let q = a; q < b; q += 14) seg(q, 1.8, -8, 16, .7, sleeperMat, y - .3);
  }

  if (r.elevated) {
    for (let q = r.extent.from; q < r.extent.to; q += 70) seg(q, 8, -4, 8, 14, supportMat, 0);
  }
  if (r.crossing === 'viaduct') {
    for (const s of r.spans) {
      seg(s.from, s.to - s.from, -8, 16, 2.2, supportMat, y - 2.6);          // deck
      for (let q = s.from + 8; q < s.to - 8; q += 26) seg(q, 6, -5, 10, y - 2.6, supportMat, 0); // piers
    }
  }
  if (r.crossing === 'tunnel') {
    for (const s of r.spans) {                                              // portals at each bank
      seg(s.from - 6, 6, -9, 18, 7, supportMat, 0);
      seg(s.to, 6, -9, 18, 7, supportMat, 0);
    }
  }
  if (r.station) {
    const term = mat(pal.accent, .65);
    addBox(world, { ...r.station, h: 24 }, term, 0);
  }
}

function renderCranes(world, model) {
  const craneMat = mat(0xb8b2a6, .6);
  for (const c of model.cranes) {
    addBox(world, { x: c.x - 1.2, z: c.z - 1.2, w: 2.4, d: 2.4, h: c.h }, craneMat, 0);
    const jib = c.dir === 'x'
      ? { x: c.x - c.jib * .3, z: c.z - .8, w: c.jib, d: 1.6, h: 1.6 }
      : { x: c.x - .8, z: c.z - c.jib * .3, w: 1.6, d: c.jib, h: 1.6 };
    addBox(world, jib, craneMat, c.h - 2);
  }
}

function renderTrees(world, model, pal) {
  if (!model.trees.length) return;
  const trunkGeo = new THREE.CylinderGeometry(.8, .9, 6, 6), crownGeo = new THREE.ConeGeometry(4.2, 9, 7);
  const trunk = new THREE.InstancedMesh(trunkGeo, mat(0x675647), model.trees.length);
  const crown = new THREE.InstancedMesh(crownGeo, mat(pal.park), model.trees.length);
  const d = new THREE.Object3D();
  model.trees.forEach((t, i) => {
    d.position.set(t.x, 3 * t.s, t.z); d.scale.set(t.s, t.s, t.s); d.updateMatrix(); trunk.setMatrixAt(i, d.matrix);
    d.position.set(t.x, 9 * t.s, t.z); d.updateMatrix(); crown.setMatrixAt(i, d.matrix);
  });
  trunk.instanceMatrix.needsUpdate = true;
  crown.instanceMatrix.needsUpdate = true;
  world.add(trunk, crown);
}

function renderCars(world, model, pal) {
  if (!model.cars.length) return;
  const geo = new THREE.BoxGeometry(6, 2.4, 3.2);
  const im = new THREE.InstancedMesh(geo, mat(pal.accent, .55), model.cars.length);
  const d = new THREE.Object3D();
  model.cars.forEach((c, i) => {
    d.position.set(c.x, c.bridge ? 6.9 : 2.3, c.z);
    d.rotation.set(0, c.rot, 0);
    d.scale.set(c.s, c.s, c.s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  world.add(im);
}

function renderDrones(world, model, pal) {
  if (!model.drones.length) return;
  const geo = new THREE.BoxGeometry(5, .9, 1.2);
  const im = new THREE.InstancedMesh(geo, mat(pal.accent, .45), model.drones.length);
  const d = new THREE.Object3D();
  model.drones.forEach((a, i) => {
    d.position.set(a.x, a.y, a.z);
    d.rotation.set(0, i * .47, 0);
    d.scale.set(a.s, a.s, a.s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  world.add(im);
}
