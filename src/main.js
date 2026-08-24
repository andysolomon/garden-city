import { Viewer } from './render.js';
import { generateCity } from './model.js';
import { renderSolid } from './solid.js';
import { renderInk, updateOverlay } from './ink.js';
import { exportPoster } from './poster.js';
import { randomSeed } from './rng.js';

const $ = id => document.getElementById(id);
const viewer = new Viewer($('viewport'));
let model = null;

function readConfig() {
  let seed = $('seed').value.trim();
  if (!seed || seed.toUpperCase() === 'RANDOM') seed = randomSeed();
  $('seed').value = seed;
  const v = id => $(id).value;
  return {
    seed,
    mode: v('mode'), palette: v('palette'), massing: v('massing'), land: v('land'),
    air: v('air'), rail: v('rail'), sector: v('sector'), sky: v('sky'),
    detail: v('detail'), density: v('density'),
    rotation: v('rotation'), life: v('life'), orbit: v('orbit'),
  };
}

function rerender() {
  if (!model) return;
  const ink = $('mode').value === 'ink';
  model.config.mode = $('mode').value;
  document.body.classList.toggle('ink', ink);
  document.body.classList.toggle('ink-night', ink && model.config.sky === 'night');
  if (ink) { renderInk(viewer, model); updateOverlay(model); }
  else renderSolid(viewer, model);
  updateStats(model);
}

function generate() {
  const cfg = readConfig();
  setStatus('GENERATING…');
  // setTimeout, not requestAnimationFrame: rAF never fires in an occluded
  // window, which would leave generation stuck at "GENERATING…".
  setTimeout(() => {
    model = generateCity(cfg);
    rerender();
    viewer.controls.autoRotate = cfg.rotation === 'on';
    viewer.controls.autoRotateSpeed = { slow: .28, normal: .72, fast: 1.75 }[cfg.orbit];
    viewer.fit();
    setStatus(`SEED ${cfg.seed}`);
  }, 0);
}

function setStatus(t) { $('status').textContent = t; }

function updateStats(m) {
  $('stats').innerHTML =
    `<b>CITY MODEL</b><br>ROADS ${m.roads.length}<br>BRIDGES ${m.bridges.length}` +
    `<br>BLOCKS ${m.blocks.length}<br>PARCELS ${m.parcels.length}` +
    `<br>BUILDINGS ${m.buildings.length}<br>PARKS ${m.parks.length}` +
    `<br>VEHICLES ${m.cars.length}<br>SEED ${m.seed}`;
}

$('generate').onclick = generate;
$('draw').onclick = generate;
$('newSeed').onclick = () => { $('seed').value = randomSeed(); generate(); };
$('resetView').onclick = () => { viewer.controls.reset(); viewer.fit(); };
$('fit').onclick = () => viewer.fit();
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
  if ($('mode').value === 'ink') {
    a.download = `antitecture-city-${model.seed}.png`;
    a.href = exportPoster(viewer, model);
  } else {
    viewer.renderer.render(viewer.scene, viewer.camera);
    a.download = `procedural-city-${model.seed}.png`;
    a.href = viewer.renderer.domElement.toDataURL('image/png');
  }
  a.click();
};

generate();

// Debug handle for console poking; not part of the app API.
window.__app = { viewer, exportPoster, get model() { return model; }, generate };
