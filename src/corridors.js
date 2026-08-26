// Named corridors (docs/V2-ROAD-GRAPH.md §2 `roads`): every real edge carries
// the roadId of the street that grew it, so a corridor is the ordered chain
// of edges sharing a roadId — one avenue running across the city, not the
// segments it happens to be made of. Names are deterministic per seed.

import { RNG } from './rng.js';
import { VIRTUAL } from './graph.js';

const STEMS = ['Kaiser', 'Ring', 'Garten', 'Hafen', 'Bahnhof', 'Markt', 'Linden', 'Wall', 'Berg', 'Brücken',
  'Stern', 'Kanal', 'Turm', 'Park', 'Nord', 'Süd', 'Ost', 'West', 'Neu', 'Alt', 'Hoch', 'Schloss', 'Münz', 'Rathaus'];
const SUFFIX = { arterial: ['allee', 'straße', 'ring', 'damm'], collector: ['straße', 'weg', 'gasse'], local: ['gasse', 'weg', 'steig'] };

export function buildCorridors(g, seed) {
  const byRoad = new Map();
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (e.removed || VIRTUAL.has(e.cls) || e.roadId < 0) continue;
    if (!byRoad.has(e.roadId)) byRoad.set(e.roadId, []);
    byRoad.get(e.roadId).push(i);
  }
  const rng = new RNG(seed + ':names');
  const used = new Set();
  const corridors = [];
  for (const [id, edgeIds] of [...byRoad.entries()].sort((a, b) => a[0] - b[0])) {
    // Order the edges into a chain: walk from a degree-1 end of the sub-graph.
    const deg = new Map();
    for (const ei of edgeIds) for (const n of [g.edges[ei].a, g.edges[ei].b]) deg.set(n, (deg.get(n) || 0) + 1);
    let start = [...deg.entries()].filter(([, d]) => d === 1).map(([n]) => n).sort((a, b) => a - b)[0];
    if (start === undefined) start = g.edges[edgeIds[0]].a; // a loop; pick a stable node
    const left = new Set(edgeIds), chain = [], nodes = [start];
    let cur = start;
    while (left.size) {
      const next = [...left].find(ei => g.edges[ei].a === cur || g.edges[ei].b === cur);
      if (next === undefined) break; // disconnected pieces (rare): stop at this chain
      left.delete(next); chain.push(next);
      cur = g.other(next, cur); nodes.push(cur);
    }
    const cls = g.edges[chain[0]].cls;
    const length = chain.reduce((s, ei) => s + g.edgeLength(ei), 0);
    let name;
    for (let k = 0; k < 20; k++) {
      name = rng.pick(STEMS) + rng.pick(SUFFIX[cls] || SUFFIX.local);
      if (!used.has(name)) break;
    }
    used.add(name);
    corridors.push({ id, cls, name, edgeIds: chain, nodeIds: nodes, length, polyline: nodes.map(n => [g.nodes[n].x, g.nodes[n].z]), orphan: left.size });
  }
  return corridors.sort((a, b) => b.length - a.length);
}
