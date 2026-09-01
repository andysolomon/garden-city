import assert from 'node:assert/strict';
import { importRoadGraph, IMPORT_DIAGNOSTIC_CODES } from '../src/roadgraph-import.js';
import { RoadGraph, extractFaces } from '../src/graph.js';
import { shortestPath } from '../src/routing.js';
import { drawMap } from '../src/map.js';

const line = (index, points, properties = {}, sourceId = `road-${index}`) => ({
  index, sourceId, properties, geometry: { type: 'line', parts: Array.isArray(points[0][0]) ? points : [points] },
});
const live = graph => graph.edges.filter(edge => !edge.removed);
const nodeAt = (graph, x, z, level = 0) => graph.nodes.findIndex(node => node.x === x && node.z === z && node.level === level);

// Optional metadata does not alter historical procedural shapes, and splitting
// propagates every imported field.
{
  const graph = new RoadGraph();
  const a = graph.addNode(0, 0), b = graph.addNode(2, 0);
  assert.deepEqual(graph.nodes[a], { x: 0, z: 0 });
  graph.addEdge(a, b, { cls: 'local' });
  assert.deepEqual(graph.edges[0], { a: 0, b: 1, cls: 'local', width: 0, bridge: false, roadId: -1, removed: false });
  const imported = new RoadGraph();
  const ia = imported.addNode(0, 0, { level: -1 }), ib = imported.addNode(2, 0, { level: -1 });
  imported.addEdge(ia, ib, { cls: 'collector', width: 7, roadId: '4:2', sourceId: 0, sourceIndex: 4, sourcePart: 2, level: -1, bridge: false, tunnel: true, faceEligible: false });
  imported.splitEdge(0, 1, 0);
  for (const edge of imported.edges) assert.deepEqual(
    Object.fromEntries(['sourceId', 'sourceIndex', 'sourcePart', 'level', 'bridge', 'tunnel', 'faceEligible'].map(key => [key, edge[key]])),
    { sourceId: 0, sourceIndex: 4, sourcePart: 2, level: -1, bridge: false, tunnel: true, faceEligible: false },
  );
}

// Quantization, stable part road IDs, source provenance, and deterministic
// metadata classification/width precedence.
{
  const records = [
    line(7, [[[.12, 0], [4.13, 0]], [[0, 2], [4, 2]]], { class: 'collector', width: '7.5 m' }, 0),
    line(8, [[0, 4], [4, 4]], { highway: 'primary', lanes: '3' }),
    line(9, [[0, 6], [4, 6]], {}),
  ];
  const { graph } = importRoadGraph(records, { size: 20 });
  assert.deepEqual(graph.nodes[0], { x: 0, z: 0, level: 0 });
  assert.deepEqual(graph.edges.map(edge => [edge.roadId, edge.sourceId, edge.sourceIndex, edge.sourcePart, edge.cls, edge.width]), [
    ['7:0', 0, 7, 0, 'collector', 7.5], ['7:1', 0, 7, 1, 'collector', 7.5],
    ['8:0', 'road-8', 8, 0, 'arterial', 10.5], ['9:0', 'road-9', 9, 0, 'local', 9],
  ]);
}

// Proper crossings and T junctions share one level-aware node and route
// through it.
{
  const cross = importRoadGraph([line(0, [[-5, 0], [5, 0]]), line(1, [[0, -5], [0, 5]])], { size: 20 });
  const center = nodeAt(cross.graph, 0, 0);
  assert.equal(cross.graph.adj[center].length, 4);
  assert.equal(live(cross.graph).length, 4);
  assert.ok(shortestPath(cross.graph, nodeAt(cross.graph, -5, 0), nodeAt(cross.graph, 0, 5)));

  const tee = importRoadGraph([line(0, [[-5, 0], [5, 0]]), line(1, [[0, -5], [0, 0]])], { size: 20 });
  assert.equal(tee.graph.adj[nodeAt(tee.graph, 0, 0)].length, 3);
  assert.equal(live(tee.graph).length, 3);
}

// Bridge, tunnel, and explicit levels cross in 2D without false adjacency;
// all remain routable within their own components.
{
  const { graph, stats } = importRoadGraph([
    line(0, [[-5, 0], [5, 0]], { bridge: 'yes' }),
    line(1, [[0, -5], [0, 5]]),
    line(2, [[-5, 2], [5, 2]], { tunnel: true }),
    line(3, [[2, -5], [2, 5]], { layer: '2' }),
  ], { size: 20 });
  assert.equal(graph.nodes.filter(node => node.x === 0 && node.z === 0).length, 0, 'different-level crossing was materialized as a junction');
  assert.equal(graph.edges.find(edge => edge.sourceIndex === 0).level, 1);
  assert.equal(graph.edges.find(edge => edge.sourceIndex === 2).level, -1);
  assert.equal(graph.edges.find(edge => edge.sourceIndex === 3).level, 2);
  assert.ok(graph.edges.filter(edge => edge.level !== 0).every(edge => edge.faceEligible === false));
  assert.equal(shortestPath(graph, nodeAt(graph, -5, 0, 1), nodeAt(graph, 0, 5, 0)), null);
  assert.ok(stats.disconnectedComponents >= 1);
}

// Clipping, collapsed geometry, duplicates, non-lines, invalid fallback
// metadata, and disconnected components produce stable diagnostics while
// retaining every usable component.
{
  const records = [
    line(0, [[-20, 0], [20, 0]], { class: 'unknown', width: 'wide', lanes: 'two', level: 'up', bridge: 'perhaps' }),
    line(1, [[-5, 0], [5, 0]]),
    line(2, [[30, 30], [40, 40]]),
    line(3, [[0.01, 1], [0.02, 1]]),
    { index: 4, sourceId: 'polygon', properties: {}, geometry: { type: 'polygon', polygons: [] } },
    line(5, [[-4, 4], [4, 4]]),
  ];
  const first = importRoadGraph(records, { size: 20 });
  const second = importRoadGraph(records, { size: 20 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(first.graph.nodes.every(node => Math.abs(node.x) <= 10 && Math.abs(node.z) <= 10));
  assert.ok(first.graph.edges.some(edge => edge.sourceIndex === 5), 'disconnected usable component was dropped');
  const codes = first.diagnostics.map(diagnostic => diagnostic.code);
  for (const code of [
    IMPORT_DIAGNOSTIC_CODES.INVALID_CLASS, IMPORT_DIAGNOSTIC_CODES.INVALID_WIDTH,
    IMPORT_DIAGNOSTIC_CODES.INVALID_LANES, IMPORT_DIAGNOSTIC_CODES.INVALID_BRIDGE,
    IMPORT_DIAGNOSTIC_CODES.INVALID_LEVEL, IMPORT_DIAGNOSTIC_CODES.DUPLICATE_SEGMENT,
    IMPORT_DIAGNOSTIC_CODES.EMPTY_AFTER_CLIP, IMPORT_DIAGNOSTIC_CODES.ZERO_LENGTH,
    IMPORT_DIAGNOSTIC_CODES.NON_LINE_RECORD, IMPORT_DIAGNOSTIC_CODES.DISCONNECTED_COMPONENT,
  ]) assert.ok(codes.includes(code), `missing ${code}`);
}

// A ground square yields one face. A crossing elevated edge neither creates a
// false face nor gets removed, so routing/debug drawing can still consume it.
{
  const { graph } = importRoadGraph([
    line(0, [[-4, -4], [4, -4]]), line(1, [[4, -4], [4, 4]]),
    line(2, [[4, 4], [-4, 4]]), line(3, [[-4, 4], [-4, -4]]),
    line(4, [[0, -6], [0, 6]], { bridge: true }),
  ], { size: 20 });
  const elevated = graph.edges.find(edge => edge.sourceIndex === 4);
  const result = extractFaces(graph);
  assert.equal(result.faces.length, 1);
  assert.equal(elevated.removed, false);
  assert.ok(shortestPath(graph, elevated.a, elevated.b));

  const calls = [];
  const ctx = new Proxy({
    setLineDash(value) { calls.push(['dash', value]); },
    save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {},
    translate() {}, rotate() {}, fillText() {},
  }, { set(target, key, value) { target[key] = value; return true; } });
  drawMap(ctx, {
    size: 20, graph, fields: null, water: [], reserved: [], faces: result.faces,
    blocks: [], parcels: [], parks: [], plazas: [], buildings: [], roads: [], centers: [],
  }, 200, 200, { edges: true, nodes: true, spurs: true, faces: true, water: false, elevation: false, population: false, direction: false, reserved: false, walkshed: false, blocks: false, parcels: false, buildings: false, labels: false, traffic: false });
  assert.ok(calls.length);
}

console.log('roadgraph-import: all tests passed');
