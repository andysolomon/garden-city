import assert from 'node:assert/strict';
import { importRoadGraph, IMPORT_DIAGNOSTIC_CODES } from '../src/roadgraph-import.js';

const line = (index, points, properties = {}, sourceId = `road-${index}`) => ({
  index, sourceId, properties, geometry: { type: 'line', parts: Array.isArray(points[0][0]) ? points : [points] },
});

// Stable part road IDs, source provenance, and deterministic metadata
// classification/width precedence.
{
  const records = [
    line(7, [[[.12, 0], [4.13, 0]], [[0, 2], [4, 2]]], { class: 'collector', width: '7.5 m' }, 0),
    line(8, [[0, 4], [4, 4]], { highway: 'primary', lanes: '3' }),
    line(9, [[0, 6], [4, 6]], {}),
  ];
  const { graph } = importRoadGraph(records, { size: 20 });
  assert.deepEqual(graph.edges.map(edge => [edge.roadId, edge.sourceId, edge.sourceIndex, edge.sourcePart, edge.cls, edge.width]), [
    ['7:0', 0, 7, 0, 'collector', 7.5], ['7:1', 0, 7, 1, 'collector', 7.5],
    ['8:0', 'road-8', 8, 0, 'arterial', 10.5], ['9:0', 'road-9', 9, 0, 'local', 9],
  ]);
}

// Bridge, tunnel, and explicit levels cross in 2D without false adjacency.
{
  const { graph } = importRoadGraph([
    line(0, [[-5, 0], [5, 0]], { bridge: 'yes' }),
    line(1, [[0, -5], [0, 5]]),
    line(2, [[-5, 2], [5, 2]], { tunnel: true }),
    line(3, [[2, -5], [2, 5]], { layer: '2' }),
  ], { size: 20 });
  assert.equal(graph.nodes.filter(node => node.x === 0 && node.z === 0).length, 0, 'different-level crossing was materialized as a junction');
  assert.equal(graph.edges.find(edge => edge.sourceIndex === 2).level, -1);
  assert.equal(graph.edges.find(edge => edge.sourceIndex === 3).level, 2);
}

// Clipping, collapsed geometry, duplicates, non-lines, invalid fallback
// metadata, and disconnected components produce diagnostics.
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
  const codes = first.diagnostics.map(diagnostic => diagnostic.code);
  for (const code of [
    IMPORT_DIAGNOSTIC_CODES.INVALID_CLASS, IMPORT_DIAGNOSTIC_CODES.INVALID_WIDTH,
    IMPORT_DIAGNOSTIC_CODES.INVALID_LANES, IMPORT_DIAGNOSTIC_CODES.INVALID_BRIDGE,
    IMPORT_DIAGNOSTIC_CODES.INVALID_LEVEL, IMPORT_DIAGNOSTIC_CODES.DUPLICATE_SEGMENT,
    IMPORT_DIAGNOSTIC_CODES.EMPTY_AFTER_CLIP, IMPORT_DIAGNOSTIC_CODES.ZERO_LENGTH,
    IMPORT_DIAGNOSTIC_CODES.NON_LINE_RECORD, IMPORT_DIAGNOSTIC_CODES.DISCONNECTED_COMPONENT,
  ]) assert.ok(codes.includes(code), `missing ${code}`);
}

console.log('roadgraph-import: all tests passed');
