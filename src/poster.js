// Poster export: composites the live ink render into the antitecture
// specimen-sheet frame (ported from antitecture.html), at print resolution.
// Unlike the original, the metadata panels report real CityModel statistics.

import { RNG } from './rng.js';
import { posterMeta, themeFor } from './ink.js';

const W = 1654, H = 2339; // A-series @2x

export function exportPoster(viewer, model) {
  const m = posterMeta(model);
  const r = new RNG(model.seed + ':frame');
  const T = themeFor(model.config);
  const hex = v => '#' + v.toString(16).padStart(6, '0');
  const NIGHT = T.dark;
  const PAPER = hex(T.paper), INK = hex(T.ink), ORANGE = hex(T.accent);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // paper + grain
  g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = NIGHT ? 'rgba(255,255,255,.02)' : 'rgba(0,0,0,.025)';
    g.fillRect(r.next() * W, r.next() * H, 1, 1);
  }

  // watermark number (shows through the transparent WebGL blit)
  g.fillStyle = INK; g.globalAlpha = .07;
  g.font = '900 560px Helvetica, Arial';
  g.fillText(m.num, W - 720, H - 460);
  g.globalAlpha = 1;

  // ---- the drawing: render the current 3D view at export size -------------
  const ax = 60, ay = 470, aw = W - 190 - ax, ah = H - 400 - ay;
  const { canvas, restore } = viewer.renderToSize(aw, ah);
  g.drawImage(canvas, ax, ay, aw, ah);
  restore();

  // level markers over the drawing
  const maxH = Math.max(60, ...model.buildings.map(b => (b.y || 0) + b.h), ...model.landmarks.map(l => l.h));
  g.strokeStyle = INK; g.lineWidth = 1; g.font = '20px Courier New';
  for (let l = 0; l < 5; l++) {
    const y = ay + ah * .62 - l * (ah * .105);
    g.globalAlpha = .35;
    g.setLineDash([6, 10]);
    g.beginPath(); g.moveTo(ax + 10, y); g.lineTo(ax + aw - 10, y); g.stroke();
    g.setLineDash([]);
    g.fillStyle = INK; g.fillRect(ax + 12, y - 14, 52, 26);
    g.fillStyle = PAPER; g.fillText('L' + (l + 1), ax + 22, y + 6);
    g.fillStyle = INK; g.fillText('+' + (maxH * l / 4).toFixed(1) + 'M', ax + aw - 130, y + 6);
    g.globalAlpha = 1;
  }

  // ---- top black bar -------------------------------------------------------
  g.fillStyle = '#1c1a18'; g.fillRect(0, 0, W, 56);
  g.fillStyle = '#eae6dd'; g.font = 'bold 17px Courier New';
  g.fillText(`SPECIMEN ${m.spec} : ${m.type}`, 40, 36);
  g.fillText('>>>>>>>>>>>>>', 660, 36);
  g.fillStyle = ORANGE;
  g.fillText(`${m.sector} SECTOR / ${m.skyLabel}`, W - 460, 36);

  // ---- title + metadata ----------------------------------------------------
  g.fillStyle = INK;
  g.font = '900 96px Helvetica, Arial'; g.fillText(m.title, 60, 190);
  g.font = 'bold 15px Courier New'; g.fillText(m.taxo, 62, 222);
  g.textAlign = 'right';
  g.fillText(`VIEW: AZ ${m.az}° / EL ${m.el}°`, W - 130, 200);
  g.textAlign = 'left';

  const cfg = model.config;
  g.font = '12px Courier New'; g.globalAlpha = .85;
  const L = [
    `SYSTEM ID: ${m.sysId}`,
    `PLATFORM CLASS: CITYMODEL / ${cfg.massing.toUpperCase()}`,
    `CONFIGURATION: ${cfg.sector.toUpperCase()} / ${cfg.density.toUpperCase()}`,
    `GROUND: ${cfg.land.toUpperCase()}${model.bridges.length ? ' / ' + model.bridges.length + ' BRIDGES' : ''}`,
    `DENSITY: ${cfg.density.toUpperCase()} / DETAIL ${cfg.detail.toUpperCase()}`,
    'STATUS: GENERATED',
  ];
  L.forEach((t, i) => g.fillText(t, 62, 264 + i * 18));
  const R = [
    `TRANSIT: ${cfg.rail === 'none' ? 'ROAD ONLY' : cfg.rail.toUpperCase() + ' LINE'}`,
    `VEHICLES: ${model.cars.length} ROAD`,
    `FOOTFALL: ${m.footfall} ON FOOT`,
    `AIRSPACE: ${model.drones.length} UAV`,
    `SUBSURFACE: B2 / -${m.sub}M`,
    `BLOCKS: ${model.blocks.length} / PARCELS: ${model.parcels.length}`,
  ];
  g.textAlign = 'right';
  R.forEach((t, i) => g.fillText(t, W - 130, 264 + i * 18));
  g.textAlign = 'left';
  g.globalAlpha = .18;
  g.font = '600 44px Helvetica, Arial'; g.fillText(m.title, 62, 420);
  g.globalAlpha = 1;

  // ---- footer panels ---------------------------------------------------------
  const fy = H - 340;
  g.strokeStyle = INK; g.setLineDash([4, 6]);
  g.beginPath(); g.moveTo(60, fy); g.lineTo(W - 130, fy); g.stroke();
  g.setLineDash([]);
  g.font = 'bold 13px Courier New'; g.fillStyle = INK;
  g.fillText('[KEY PLAN]', 62, fy + 30); if (model.corridors?.length) g.fillText('[STREETS]', 206, fy + 30); g.fillText('[INDEX]', 380, fy + 30);
  g.fillText('[SCALE]', 850, fy + 30); g.fillText('[CONFIGURATION]', 1180, fy + 30);

  // key plan
  g.strokeRect(62, fy + 45, 130, 130);
  g.fillStyle = ORANGE;
  g.save(); g.translate(127, fy + 110); g.rotate(r.next());
  g.fillRect(-22, -22, 44, 44); g.fillRect(14, 24, 14, 14);
  g.restore();

  // street index: the longest named corridors (graph engine only)
  if (model.corridors?.length) {
    g.fillStyle = INK; g.font = '11px Courier New';
    model.corridors.slice(0, 6).forEach((c, i) => {
      g.fillText(`${c.name}`.toUpperCase().slice(0, 16), 206, fy + 58 + i * 18);
      g.globalAlpha = .6; g.fillText(`${Math.round(c.length)}M`, 320, fy + 58 + i * 18); g.globalAlpha = 1;
    });
  }

  // Traffic index: show the busiest named corridors without changing the
  // model's corridor ordering used by the rest of the poster.
  if (model.traffic && model.corridors?.length) {
    g.globalAlpha = 1; g.fillStyle = INK; g.font = 'bold 13px Courier New';
    g.fillText('[TRAFFIC]', 206, fy + 190);
    g.font = '11px Courier New';
    model.corridors.slice().sort((a, b) => (b.traffic || 0) - (a.traffic || 0) || a.id - b.id).slice(0, 3).forEach((c, i) => {
      const y = fy + 210 + i * 14;
      g.fillText(`${c.name}`.toUpperCase().slice(0, 16), 206, y);
      g.globalAlpha = .6; g.fillText(`${Math.round(c.traffic || 0)}X`, 320, y); g.globalAlpha = 1;
    });
  }

  // index: real counts from the model
  g.fillStyle = INK; g.font = '11px Courier New';
  const idx = [
    ['ROADS', model.roads.length], ['BRIDGES', model.bridges.length],
    ['BLOCKS', model.blocks.length], ['PARCELS', model.parcels.length],
    ['BVILDINGS', model.buildings.length], ['PARKS', model.parks.length],
    ['TREES', model.trees.length], ['VEHICLES', model.cars.length],
    ['CRANES', model.cranes.length], ['VAV', model.drones.length],
  ];
  idx.forEach(([name, count], i) => {
    const col = i % 2, row = i / 2 | 0;
    g.fillText(`[M${String(i + 1).padStart(2, '0')}] ${name.padEnd(11)}${String(count).padStart(4, '0')}`, 380 + col * 220, fy + 58 + row * 20);
  });

  // scale bar
  for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? PAPER : ORANGE; g.fillRect(850 + i * 40, fy + 48, 40, 12); }
  g.strokeRect(850, fy + 48, 240, 12);
  g.fillStyle = INK;
  ['1:100 / 40 M', 'PROJECTION: AXONOMETRIC', `SEED: ${model.seed}`, 'PAPER: STANDARD / INK: BOLD']
    .forEach((t, i) => g.fillText(t, 850, fy + 84 + i * 18));

  // configuration
  const conf = [
    ['MODE', m.type], ['MASSING', cfg.massing.toUpperCase()], ['LAND', cfg.land.toUpperCase()],
    ['RAIL', cfg.rail.toUpperCase()], ['SECTOR', cfg.sector.toUpperCase()],
    ['SKY', m.skyLabel], ['DENSITY', cfg.density.toUpperCase()],
  ];
  conf.forEach(([k, v], i) => {
    g.fillText(k, 1180, fy + 58 + i * 20);
    g.textAlign = 'right'; g.font = 'bold 11px Courier New';
    g.fillText(v, W - 140, fy + 58 + i * 20);
    g.textAlign = 'left'; g.font = '11px Courier New';
  });

  // ---- bottom bar + orange sidebar -------------------------------------------
  g.fillStyle = '#1c1a18'; g.fillRect(0, H - 90, W, 90);
  g.fillStyle = ORANGE; g.fillRect(0, H - 90, 200, 90);
  g.fillStyle = '#1c1a18'; g.font = '900 56px Helvetica, Arial'; g.fillText(m.num, 24, H - 28);
  g.fillStyle = '#eae6dd'; g.font = 'bold 16px Courier New';
  g.fillText(m.type.split(' ')[0], 120, H - 38);
  g.fillText('SHEET 1 / 1   >>>>>>>>>>', 260, H - 38);
  g.font = '900 34px Helvetica, Arial'; g.textAlign = 'right';
  g.fillText(m.sysId, W - 130, H - 32);
  g.textAlign = 'left';

  g.fillStyle = ORANGE; g.fillRect(W - 100, 0, 100, H);
  g.fillStyle = '#1c1a18'; g.font = '900 40px Helvetica, Arial'; g.fillText(m.num, W - 82, 60);
  g.save(); g.translate(W - 45, 120); g.rotate(Math.PI / 2);
  g.font = 'bold 14px Courier New';
  g.fillText(`GENERATIVE ANTITECTURE / CITYMODEL / SPECIMEN ${m.spec}`, 0, 0);
  g.restore();
  g.strokeStyle = '#1c1a18'; g.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.moveTo(W - 100, H - 200 + i * 12);
    g.lineTo(W - 60, H - 240 + i * 12);
    g.stroke();
  }

  return cv.toDataURL('image/png');
}
