import { Viewer } from './render.js';
import { generateCity } from './model.js';
import { renderSolid } from './solid.js';
import { renderInk, updateOverlay } from './ink.js';
import { exportPoster } from './poster.js';
import { randomSeed } from './rng.js';
import { MapView } from './map.js';

const $ = id => document.getElementById(id);
const viewer = new Viewer($('viewport'));
const map = new MapView($('viewport'));
let model = null;

function readConfig() {
  let seed = $('seed').value.trim();
  if (!seed || seed.toUpperCase() === 'RANDOM') seed = randomSeed();
  $('seed').value = seed;
  const v = id => $(id).value;
  return {
    seed,
    mode: v('mode'), engine: v('engine'), pattern: v('pattern'),
    palette: v('palette'), massing: v('massing'), land: v('land'),
    air: v('air'), rail: v('rail'), sector: v('sector'), sky: v('sky'),
    detail: v('detail'), density: v('density'),
    rotation: v('rotation'), life: v('life'), orbit: v('orbit'),
  };
}

function rerender() {
  if (!model) return;
  const mode = $('mode').value;
  const ink = mode === 'ink';
  model.config.mode = mode;
  document.body.classList.toggle('ink', ink);
  document.body.classList.toggle('ink-night', ink && model.config.sky === 'night');
  document.body.classList.toggle('map', mode === 'map');
  map.setModel(model, model.config.sky);
  map.show(mode === 'map');
  if (ink) { renderInk(viewer, model); updateOverlay(model); }
  else if (mode === 'solid') renderSolid(viewer, model);
  updateStats(model);
}

function generate() {
  const cfg = readConfig();
  setStatus('GENERATING…');
  // setTimeout, not requestAnimationFrame: rAF never fires in an occluded
  // window, which would leave generation stuck at "GENERATING…".
  setTimeout(() => {
    const t0 = performance.now();
    model = generateCity(cfg);
    model.genMs = performance.now() - t0;
    rerender();
    viewer.controls.autoRotate = cfg.rotation === 'on';
    viewer.controls.autoRotateSpeed = { slow: .28, normal: .72, fast: 1.75 }[cfg.orbit];
    viewer.fit();
    setStatus(`SEED ${cfg.seed}`);
  }, 0);
}

function setStatus(t) { $('status').textContent = t; }

function updateStats(m) {
  const s = m.stats;
  const graph = s
    ? `<br>NODES ${s.nodes}<br>EDGES ${s.edges}<br>FACES ${s.faces}<br>CORRIDORS ${s.corridors}<br>LANDLOCKED ${s.landlocked}<br>OFFSET DROPS ${s.offsetDrops}`
    : '';
  $('stats').innerHTML =
    `<b>CITY MODEL · ${m.engine.toUpperCase()}${m.pattern ? ' · ' + m.pattern.toUpperCase() : ''}</b>` +
    `<br>ROADS ${m.roads.length}<br>BRIDGES ${m.bridges.length}` +
    `<br>BLOCKS ${m.blocks.length}<br>PARCELS ${m.parcels.length}` +
    `<br>BUILDINGS ${m.buildings.length}<br>PARKS ${m.parks.length}` +
    `<br>VEHICLES ${m.cars.length}${graph}<br>GEN ${m.genMs ? m.genMs.toFixed(0) + ' MS' : '—'}<br>SEED ${m.seed}`;
}

$('generate').onclick = generate;
$('draw').onclick = generate;
$('newSeed').onclick = () => { $('seed').value = randomSeed(); generate(); };
$('resetView').onclick = () => { viewer.controls.reset(); viewer.fit(); if (map.visible) { map.fit(); map.draw(); } };
$('fit').onclick = () => { viewer.fit(); if (map.visible) { map.fit(); map.draw(); } };
$('options').onclick = () => $('panel').classList.toggle('hidden');

// Render-only controls apply without regenerating the model.
$('mode').onchange = rerender;
$('sky').onchange = () => { if (model) { model.config.sky = $('sky').value; rerender(); } };
$('palette').onchange = () => { if (model) { model.config.palette = $('palette').value; rerender(); } };
$('rotation').onchange = () => viewer.controls.autoRotate = $('rotation').value === 'on';
$('orbit').onchange = () => viewer.controls.autoRotateSpeed = { slow: .28, normal: .72, fast: 1.75 }[$('orbit').value];

$('save').onclick = () => {
  if (!model) return;
  const a = document.createElement('a');
  const mode = $('mode').value;
  if (mode === 'ink') {
    a.download = `antitecture-city-${model.seed}.png`;
    a.href = exportPoster(viewer, model);
  } else if (mode === 'map') {
    a.download = `city-map-${model.seed}.png`;
    a.href = map.canvas.toDataURL('image/png');
  } else {
    viewer.renderer.render(viewer.scene, viewer.camera);
    a.download = `procedural-city-${model.seed}.png`;
    a.href = viewer.renderer.domElement.toDataURL('image/png');
  }
  a.click();
};

generate();

// Debug handle for console poking; not part of the app API.
window.__app = { viewer, map, exportPoster, get model() { return model; }, generate };
