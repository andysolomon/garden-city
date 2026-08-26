// Top-down debug map (docs/V2-ROAD-GRAPH.md §8, P0). Plain 2D canvas,
// orthographic, with per-layer toggles: fields (population, direction,
// water), graph nodes/edges by class, faces, blocks, parcels, buildings.
// Debugging a planar graph through the isometric ink view is not possible;
// this is where the graph is actually looked at.

import { VIRTUAL } from './graph.js';

export const LAYERS = [
  ['water', 'WATER', true], ['population', 'POPULATION', false], ['direction', 'DIRECTION', false],
  ['faces', 'FACES', true], ['blocks', 'BUILDABLE', false], ['parcels', 'PARCELS', true],
  ['buildings', 'BUILDINGS', true], ['edges', 'EDGES', true], ['nodes', 'NODES', false],
  ['spurs', 'SPURS', true], ['labels', 'LABELS', false], ['reserved', 'RESERVED', true],
];

const CLASS_COLORS = {
  arterial: '#e8501e', collector: '#1c1a18', local: '#6b6b6b', boundary: '#b0a8a0', shore: '#3e7f9c',
};

// Draw the model into a 2D context, fitting the city square into (w, h).
// `view` = { scale, ox, oz } maps world → canvas; pass null to fit.
export function drawMap(ctx, model, w, h, layers, view = null, theme = 'day') {
  const dark = theme === 'night';
  const paper = dark ? '#101014' : '#f1eee6';
  ctx.save();
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);
  const S = model.size;
  const v = view || { scale: Math.min(w, h) / (S * 1.06), ox: w / 2, oz: h / 2 };
  const X = x => v.ox + x * v.scale, Z = z => v.oz + z * v.scale;
  const path = poly => { ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1]))); ctx.closePath(); };
  const on = k => layers[k];
  const f = model.fields;
  const g = model.graph;

  // Fields (sampled on a coarse grid).
  if (f && on('population')) {
    const step = 12;
    for (let x = -S / 2; x < S / 2; x += step) for (let z = -S / 2; z < S / 2; z += step) {
      const p = f.population(x + step / 2, z + step / 2);
      ctx.fillStyle = `rgba(232,80,30,${(p * .45).toFixed(3)})`;
      ctx.fillRect(X(x), Z(z), step * v.scale + .5, step * v.scale + .5);
    }
  }
  if (f && on('water')) {
    ctx.fillStyle = dark ? 'rgba(30,62,80,.7)' : 'rgba(170,191,197,.55)';
    for (const wtr of model.water) {
      if (wtr.type === 'sea') {
        ctx.fillRect(X(-S), Z(-S), 2 * S * v.scale, 2 * S * v.scale);
        ctx.fillStyle = paper;
        path(f.water.shores[0].pts); ctx.fill();
      } else ctx.fillRect(X(wtr.x), Z(wtr.z), wtr.w * v.scale, wtr.d * v.scale);
    }
  }
  if (f && on('direction')) {
    const step = 24, len = step * .38 * v.scale;
    ctx.strokeStyle = dark ? 'rgba(216,212,200,.35)' : 'rgba(28,26,24,.32)';
    ctx.lineWidth = 1;
    for (let x = -S / 2 + step / 2; x < S / 2; x += step) for (let z = -S / 2 + step / 2; z < S / 2; z += step) {
      const a = f.direction(x, z), c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(X(x) - c * len, Z(z) - s * len); ctx.lineTo(X(x) + c * len, Z(z) + s * len); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(x) + s * len * .4, Z(z) - c * len * .4); ctx.lineTo(X(x) - s * len * .4, Z(z) + c * len * .4); ctx.stroke();
    }
  }
  if (on('reserved')) {
    ctx.fillStyle = 'rgba(232,80,30,.12)';
    for (const r of model.reserved) ctx.fillRect(X(r.x), Z(r.z), r.w * v.scale, r.d * v.scale);
  }

  // Faces: hashed pastel fills so adjacent faces differ.
  if (model.faces && on('faces')) {
    for (const face of model.faces) {
      const hue = (face.id * 47) % 360;
      ctx.fillStyle = `hsla(${hue},45%,${dark ? 28 : 78}%,.55)`;
      path(face.polygon); ctx.fill();
    }
  }
  if (on('blocks')) {
    ctx.strokeStyle = '#8aa07a'; ctx.lineWidth = 1;
    for (const b of model.blocks) if (b.buildable) { path(b.buildable); ctx.stroke(); }
    ctx.fillStyle = 'rgba(138,160,122,.35)';
    for (const p of model.parks) { path(p.polygon); ctx.fill(); }
    for (const p of model.plazas) { ctx.fillStyle = 'rgba(232,80,30,.25)'; path(p.polygon); ctx.fill(); }
  }
  if (on('parcels')) {
    ctx.lineWidth = .7;
    for (const p of model.parcels) {
      ctx.strokeStyle = p.landlocked ? '#b05540' : (dark ? 'rgba(216,212,200,.5)' : 'rgba(28,26,24,.45)');
      path(p.polygon); ctx.stroke();
      if (p.frontage && v.scale > .9) {
        ctx.strokeStyle = '#e8501e'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(p.frontage.a[0]), Z(p.frontage.a[1])); ctx.lineTo(X(p.frontage.b[0]), Z(p.frontage.b[1])); ctx.stroke();
        ctx.lineWidth = .7;
      }
    }
  }
  if (on('buildings')) {
    ctx.fillStyle = dark ? 'rgba(216,212,200,.75)' : 'rgba(28,26,24,.72)';
    for (const b of model.buildings) {
      if (b.y) continue;
      ctx.save();
      ctx.translate(X(b.cx), Z(b.cz)); ctx.rotate(b.angle || 0);
      ctx.fillRect(-b.w / 2 * v.scale, -b.d / 2 * v.scale, b.w * v.scale, b.d * v.scale);
      ctx.restore();
    }
  }

  // Graph edges by class (BSP engine: plain road rects instead).
  if (on('edges')) {
    if (g) {
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        if (e.removed) continue;
        if (e.spur && !on('spurs')) continue;
        const a = g.nodes[e.a], b = g.nodes[e.b];
        ctx.strokeStyle = e.bridge ? '#3e7f9c' : (CLASS_COLORS[e.cls] || '#888');
        ctx.lineWidth = VIRTUAL.has(e.cls) ? 1 : Math.max(1, e.width * v.scale * .5);
        ctx.setLineDash(VIRTUAL.has(e.cls) ? [4, 4] : e.spur ? [3, 3] : []);
        ctx.beginPath(); ctx.moveTo(X(a.x), Z(a.z)); ctx.lineTo(X(b.x), Z(b.z)); ctx.stroke();
      }
      ctx.setLineDash([]);
    } else {
      for (const r of model.roads) { ctx.fillStyle = r.type === 'arterial' ? '#e8501e' : '#6b6b6b'; path(r.polygon); ctx.fill(); }
    }
  }
  if (g && on('nodes')) {
    for (let n = 0; n < g.nodes.length; n++) {
      const deg = g.adj[n].filter(e => !g.edges[e].removed).length;
      if (!deg) continue;
      const p = g.nodes[n];
      ctx.fillStyle = deg === 1 ? '#b05540' : deg === 2 ? '#c8a060' : deg === 3 ? '#1c1a18' : '#e8501e';
      ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), Math.max(1.5, 2.2 * v.scale), 0, Math.PI * 2); ctx.fill();
    }
  }
  if (on('labels') && v.scale > 1.4) {
    ctx.font = `${Math.max(8, 4 * v.scale)}px Courier New`;
    ctx.fillStyle = '#e8501e';
    if (g) for (let n = 0; n < g.nodes.length; n++) { if (g.adj[n].some(e => !g.edges[e].removed)) ctx.fillText(n, X(g.nodes[n].x) + 3, Z(g.nodes[n].z) - 3); }
    ctx.fillStyle = dark ? '#d8d4c8' : '#1c1a18';
    if (model.faces) for (const face of model.faces) {
      const b = face.polygon; let cx = 0, cz = 0;
      for (const p of b) { cx += p[0]; cz += p[1]; }
      ctx.fillText('f' + face.id, X(cx / b.length), Z(cz / b.length));
    }
  }
  if (model.corridors && on('labels')) {
    ctx.fillStyle = dark ? '#d8d4c8' : '#1c1a18';
    ctx.font = `${Math.max(8, 3.6 * v.scale)}px Courier New`;
    for (const c of model.corridors) {
      if (c.cls === 'local' || c.length < 120) continue;
      // Label along the longest edge of the corridor.
      let best = null, bl = 0;
      for (const ei of c.edgeIds) { const l = g.edgeLength(ei); if (l > bl) { bl = l; best = g.edges[ei]; } }
      const a = g.nodes[best.a], b = g.nodes[best.b];
      let ang = Math.atan2(b.z - a.z, b.x - a.x);
      if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
      ctx.save(); ctx.translate(X((a.x + b.x) / 2), Z((a.z + b.z) / 2)); ctx.rotate(ang);
      ctx.textAlign = 'center'; ctx.fillText(c.name, 0, -2); ctx.restore();
    }
  }
  if (model.centers) {
    ctx.strokeStyle = '#e8501e'; ctx.lineWidth = 1.5;
    for (const c of model.centers) { ctx.beginPath(); ctx.arc(X(c.x), Z(c.z), 6, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.restore();
}

// Interactive map view: canvas over the viewport with pan/zoom + a layer strip.
export class MapView {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'none', cursor: 'grab' });
    container.appendChild(this.canvas);
    this.layers = Object.fromEntries(LAYERS.map(([k, , on]) => [k, on]));
    this.view = null;
    this.model = null;
    this.visible = false;
    this.theme = 'day';

    this.strip = document.createElement('div');
    this.strip.id = 'maplayers';
    Object.assign(this.strip.style, { position: 'fixed', right: '18px', top: '60px', zIndex: 9, display: 'none', flexDirection: 'column', gap: '2px', background: 'rgba(17,19,23,.93)', border: '1px solid #30343c', padding: '8px' });
    for (const [k, label] of LAYERS) {
      const b = document.createElement('button');
      b.textContent = label; b.dataset.layer = k;
      Object.assign(b.style, { height: '22px', fontSize: '8px', padding: '0 8px', textAlign: 'left' });
      b.onclick = () => { this.layers[k] = !this.layers[k]; this.sync(); this.draw(); };
      this.strip.appendChild(b);
    }
    document.body.appendChild(this.strip);
    this.sync();

    let drag = null;
    this.canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oz: this.view.oz }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', e => { if (!drag) return; this.view.ox = drag.ox + (e.clientX - drag.x) * devicePixelRatio; this.view.oz = drag.oz + (e.clientY - drag.y) * devicePixelRatio; this.draw(); });
    this.canvas.addEventListener('pointerup', () => drag = null);
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * .0015);
      const mx = e.offsetX * devicePixelRatio, my = e.offsetY * devicePixelRatio;
      this.view.ox = mx + (this.view.ox - mx) * k; this.view.oz = my + (this.view.oz - my) * k; this.view.scale *= k;
      this.draw();
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.visible) { this.fit(); this.draw(); } });
  }
  sync() { for (const b of this.strip.children) b.style.background = this.layers[b.dataset.layer] ? '#e8501e' : '#20242a'; }
  show(on) {
    this.visible = on;
    this.canvas.style.display = on ? 'block' : 'none';
    this.strip.style.display = on ? 'flex' : 'none';
    if (on) { this.fit(); this.draw(); }
  }
  fit() {
    const w = this.container.clientWidth * devicePixelRatio, h = this.container.clientHeight * devicePixelRatio;
    this.canvas.width = w; this.canvas.height = h;
    this.view = { scale: Math.min(w, h) / (900 * 1.08), ox: w / 2, oz: h / 2 };
  }
  setModel(model, theme) { this.model = model; this.theme = theme; if (this.visible) this.draw(); }
  draw() {
    if (!this.model) return;
    if (!this.view) this.fit();
    drawMap(this.canvas.getContext('2d'), this.model, this.canvas.width, this.canvas.height, this.layers, this.view, this.theme);
  }
}
