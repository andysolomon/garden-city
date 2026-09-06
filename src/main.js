import { Viewer } from './render.js';
import { generateCity } from './model.js';
import { renderSolid } from './solid.js';
import { renderInk, updateOverlay } from './ink.js';
import { exportPoster } from './poster.js';
import { randomSeed } from './rng.js';
import { MapView } from './map.js';
import { loadProviderGeography, providerErrorMessage } from './provider.js';

const $ = id => document.getElementById(id);
const viewer = new Viewer($('viewport'));
const map = new MapView($('viewport'));
let model = null;
let providerData = null;
let providerController = null;
let providerLoadId = 0;

function providerRequestKey() {
  return `${$('location').value.trim()}\u0000${$('cropRadius').value.trim()}`;
}

function readConfig(geography = providerData) {
  let seed = $('seed').value.trim();
  if (!seed || seed.toUpperCase() === 'RANDOM') seed = randomSeed();
  $('seed').value = seed;
  const v = id => $(id).value;
  const source = v('source');
  const config = {
    seed,
    mode: v('mode'), engine: v('engine'), pattern: v('pattern'),
    palette: v('palette'), massing: v('massing'), land: v('land'),
    air: v('air'), rail: v('rail'), sector: v('sector'), sky: v('sky'),
    detail: v('detail'), density: v('density'),
    rotation: v('rotation'), life: v('life'), orbit: v('orbit'),
  };
  if (source !== 'procedural') {
    config.source = source;
    if (geography) config.geography = { records: geography.records, diagnostics: geography.diagnostics };
  }
  return config;
}

function setStatus(text) { $('status').textContent = text; }

function setError(error) {
  const target = $('error');
  if (!error) {
    target.hidden = true;
    target.textContent = '';
    return;
  }
  target.hidden = false;
  target.textContent = providerErrorMessage(error);
}

function updateAttribution() {
  const target = $('attribution');
  const visible = $('source').value !== 'procedural' && providerData?.attribution;
  target.hidden = !visible;
  target.textContent = visible ? providerData.attribution : '';
}

function updateSourceUI() {
  const imported = $('source').value !== 'procedural';
  document.querySelectorAll('.provider-only').forEach(element => { element.hidden = !imported; });
  $('engine').disabled = imported;
  if (imported) $('engine').value = 'graph';
  $('loadLocation').textContent = $('source').value === 'hybrid' ? 'LOAD HYBRID LOCATION' : 'LOAD LOCATION';
  updateAttribution();
}

function cancelProviderLoad() {
  providerLoadId++;
  if (providerController) providerController.abort();
  providerController = null;
}

function providerDataIsCurrent() {
  return providerData && providerData.requestKey === providerRequestKey();
}

function installModel(config) {
  const t0 = performance.now();
  model = generateCity(config);
  model.genMs = performance.now() - t0;
  rerender();
  viewer.controls.autoRotate = config.rotation === 'on';
  viewer.controls.autoRotateSpeed = { slow: .28, normal: .72, fast: 1.75 }[config.orbit];
  viewer.fit();
}

function rerender() {
  if (!model) return;
  const mode = $('mode').value;
  const ink = mode === 'ink';
  model.config.mode = mode;
  document.body.classList.toggle('ink', ink);
  document.body.classList.toggle('ink-night', ink && model.config.sky === 'night');
  document.body.classList.toggle('map', mode === 'map');
  if (mode === 'map') viewer.clearWorld();
  map.setModel(model, model.config.sky);
  map.show(mode === 'map');
  if (ink) { renderInk(viewer, model); updateOverlay(model); }
  else if (mode === 'solid') renderSolid(viewer, model);
  updateAttribution();
  updateStats(model);
}

async function loadLocation() {
  if ($('source').value === 'procedural') return;
  cancelProviderLoad();
  const requestId = providerLoadId;
  const controller = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
  providerController = controller;
  setError(null);
  setStatus('LOADING LOCATION…');

  try {
    const data = await loadProviderGeography({
      location: $('location').value,
      radius: $('cropRadius').value,
      token: $('providerToken').value,
      signal: controller.signal,
    });
    if (requestId !== providerLoadId) return;
    providerData = { ...data, requestKey: providerRequestKey() };
    providerController = null;
    setStatus('GENERATING…');
    installModel(readConfig(providerData));
    setStatus(`LOCATION ${data.location.label.toUpperCase()}`);
  } catch (error) {
    if (requestId !== providerLoadId || error?.code === 'aborted') return;
    providerController = null;
    setError(error);
    setStatus('LOAD ERROR');
  }
}

function generate() {
  if ($('source').value !== 'procedural' && !providerDataIsCurrent()) {
    loadLocation();
    return;
  }
  cancelProviderLoad();
  const cfg = readConfig(providerData);
  setError(null);
  setStatus('GENERATING…');
  // setTimeout, not requestAnimationFrame: rAF never fires in an occluded
  // window, which would leave generation stuck at "GENERATING…".
  setTimeout(() => {
    try {
      installModel(cfg);
      setStatus(`SEED ${cfg.seed}`);
    } catch (error) {
      setError(error);
      setStatus('GENERATION ERROR');
    }
  }, 0);
}

function updateStats(m) {
  const s = m.stats;
  const graph = s
    ? `<br>NODES ${s.nodes}<br>EDGES ${s.edges}<br>FACES ${s.faces}<br>CORRIDORS ${s.corridors}<br>LANDLOCKED ${s.landlocked}<br>OFFSET DROPS ${s.offsetDrops}`
    : '';
  const source = m.source ? ` · ${m.source.toUpperCase()}` : '';
  $('stats').innerHTML =
    `<b>CITY MODEL · ${m.engine.toUpperCase()}${m.pattern ? ' · ' + m.pattern.toUpperCase() : ''}${source}</b>` +
    `<br>ROADS ${m.roads.length}<br>BRIDGES ${m.bridges.length}` +
    `<br>BLOCKS ${m.blocks.length}<br>PARCELS ${m.parcels.length}` +
    `<br>BUILDINGS ${m.buildings.length}<br>PARKS ${m.parks.length}` +
    `<br>VEHICLES ${m.cars.length}${graph}<br>GEN ${m.genMs ? m.genMs.toFixed(0) + ' MS' : '—'}<br>SEED ${m.seed}`;
}

$('generate').onclick = generate;
$('draw').onclick = generate;
$('loadLocation').onclick = loadLocation;
$('newSeed').onclick = () => { $('seed').value = randomSeed(); generate(); };
$('resetView').onclick = () => { viewer.controls.reset(); viewer.fit(); if (map.visible) { map.fit(); map.draw(); } };
$('fit').onclick = () => { viewer.fit(); if (map.visible) { map.fit(); map.draw(); } };
$('options').onclick = () => $('panel').classList.toggle('hidden');

// Render-only controls apply without regenerating the model.
$('mode').onchange = rerender;
$('source').onchange = () => {
  updateSourceUI();
  if ($('source').value === 'procedural') cancelProviderLoad();
};
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

updateSourceUI();
generate();

// Debug handle for console poking; not part of the app API.
window.__app = {
  viewer, map, exportPoster, loadLocation,
  get model() { return model; },
  get providerData() { return providerData; },
  generate,
};
