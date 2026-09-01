// Deterministic adapter from normalizeGeoJSON() line records to RoadGraph.
// This module is intentionally provider-neutral and performs no I/O.

import { RoadGraph } from './graph.js';
import { QUANTUM, pointSegDist, segIntersect } from './geom.js';

export const IMPORT_DIAGNOSTIC_CODES = Object.freeze({
  NON_LINE_RECORD: 'non-line-record',
  INVALID_LINE_PART: 'invalid-line-part',
  EMPTY_AFTER_CLIP: 'empty-after-clip',
  ZERO_LENGTH: 'zero-length-after-quantization',
  INVALID_CLASS: 'invalid-class',
  INVALID_WIDTH: 'invalid-width',
  INVALID_LANES: 'invalid-lanes',
  INVALID_LEVEL: 'invalid-level',
  INVALID_BRIDGE: 'invalid-bridge',
  INVALID_TUNNEL: 'invalid-tunnel',
  DUPLICATE_SEGMENT: 'duplicate-segment',
  DISCONNECTED_COMPONENT: 'disconnected-component',
});

const BASE_WIDTHS = Object.freeze({ arterial: 20, collector: 13, local: 9 });
const CLASSES = new Set(['arterial', 'collector', 'local']);
const ARTERIAL = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const COLLECTOR = new Set(['secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
const LOCAL = new Set(['residential', 'living_street', 'service', 'unclassified', 'road', 'track']);

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function optionNumber(value, fallback, name, { positive = false } = {}) {
  if (value === undefined) return fallback;
  if (!finite(value) || (positive ? value <= 0 : value < 0)) throw new RangeError(`${name} must be a ${positive ? 'positive' : 'non-negative'} finite number`);
  return value;
}

function boundsOf(options) {
  const supplied = options.bounds || options.viewportBounds;
  if (supplied !== undefined) {
    if (!plain(supplied)) throw new TypeError('bounds must be an object');
    const b = { minX: supplied.minX, maxX: supplied.maxX, minZ: supplied.minZ, maxZ: supplied.maxZ };
    if (!Object.values(b).every(finite) || b.minX > b.maxX || b.minZ > b.maxZ) throw new RangeError('bounds must contain ordered finite minX, maxX, minZ, and maxZ');
    return b;
  }
  const size = optionNumber(options.viewportSize ?? options.size, 900, 'viewportSize', { positive: true });
  return { minX: -size / 2, maxX: size / 2, minZ: -size / 2, maxZ: size / 2 };
}

// Liang-Barsky clipping. Returning null (rather than a degenerate point) makes
// source segments tangent to a viewport corner deterministically unusable.
function clipSegment(a, b, bounds) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a[0] - bounds.minX], [dx, bounds.maxX - a[0]], [-dz, a[1] - bounds.minZ], [dz, bounds.maxZ - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r); else hi = Math.min(hi, r);
    if (lo > hi) return null;
  }
  if (hi - lo <= 1e-12) return null;
  return [[a[0] + dx * lo, a[1] + dz * lo], [a[0] + dx * hi, a[1] + dz * hi]];
}

function numericTag(value) {
  if (finite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*(?:m|metres?|meters?))?$/i.test(text)) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function booleanTag(value) {
  if (value === undefined || value === null || value === '') return { value: false, valid: true };
  if (value === true || value === 1) return { value: true, valid: true };
  if (value === false || value === 0) return { value: false, valid: true };
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['yes', 'true', '1'].includes(text)) return { value: true, valid: true };
    if (['no', 'false', '0'].includes(text)) return { value: false, valid: true };
  }
  return { value: false, valid: false };
}

function normalizeMetadata(record, sourceIndex, diagnostics, widths, laneWidth) {
  const raw = plain(record.properties) ? record.properties : {};
  const p = plain(raw.tags) ? { ...raw.tags, ...raw } : raw;
  const diagnostic = (code, message) => diagnostics.push({ index: sourceIndex, sourceId: record.sourceId ?? null, code, message });

  const explicitClass = p.class ?? p.roadClass ?? p.road_class;
  const highway = typeof p.highway === 'string' ? p.highway.trim().toLowerCase() : null;
  let cls = null;
  if (typeof explicitClass === 'string' && CLASSES.has(explicitClass.trim().toLowerCase())) cls = explicitClass.trim().toLowerCase();
  else if (explicitClass !== undefined && explicitClass !== null && explicitClass !== '') diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_CLASS, 'unsupported road class; using metadata fallback');
  if (!cls && highway) {
    if (ARTERIAL.has(highway)) cls = 'arterial';
    else if (COLLECTOR.has(highway)) cls = 'collector';
    else if (LOCAL.has(highway)) cls = 'local';
    else diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_CLASS, 'unsupported highway value; using local fallback');
  } else if (!cls && p.highway !== undefined && p.highway !== null && !highway) {
    diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_CLASS, 'invalid highway value; using local fallback');
  }
  cls ||= 'local';

  let width = null;
  if (p.width !== undefined && p.width !== null && p.width !== '') {
    const parsed = numericTag(p.width);
    if (parsed !== null && parsed > 0) width = parsed;
    else diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_WIDTH, 'width must be a positive number; using lanes or class fallback');
  }
  if (width === null && p.lanes !== undefined && p.lanes !== null && p.lanes !== '') {
    const lanes = numericTag(p.lanes);
    if (lanes !== null && lanes > 0) width = lanes * laneWidth;
    else diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_LANES, 'lanes must be a positive number; using class fallback');
  }
  width ??= widths[cls];

  const bridgeResult = booleanTag(p.bridge);
  const tunnelResult = booleanTag(p.tunnel);
  if (!bridgeResult.valid) diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_BRIDGE, 'invalid bridge value; using false');
  if (!tunnelResult.valid) diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_TUNNEL, 'invalid tunnel value; using false');
  const bridge = bridgeResult.value, tunnel = tunnelResult.value;

  const explicitLevel = p.level !== undefined && p.level !== null && p.level !== '' ? p.level : p.layer;
  let level;
  if (explicitLevel !== undefined && explicitLevel !== null && explicitLevel !== '') {
    level = numericTag(explicitLevel);
    if (level === null) {
      diagnostic(IMPORT_DIAGNOSTIC_CODES.INVALID_LEVEL, 'level/layer must be numeric; using bridge/tunnel fallback');
      level = undefined;
    }
  }
  if (level === undefined) level = bridge ? 1 : tunnel ? -1 : 0;
  if (Object.is(level, -0)) level = 0;

  return { cls, width, bridge, tunnel, level, faceEligible: !bridge && !tunnel && level === 0 };
}

function componentDiagnostics(graph, diagnostics) {
  const edgeComponent = new Int32Array(graph.edges.length).fill(-1);
  const components = [];
  for (let seed = 0; seed < graph.edges.length; seed++) {
    if (edgeComponent[seed] !== -1 || graph.edges[seed].removed) continue;
    const id = components.length, edges = [], nodes = new Set(), stack = [seed];
    edgeComponent[seed] = id;
    while (stack.length) {
      const edgeId = stack.pop(), edge = graph.edges[edgeId];
      edges.push(edgeId); nodes.add(edge.a); nodes.add(edge.b);
      for (const node of [edge.a, edge.b]) for (const next of graph.adj[node]) {
        if (!graph.edges[next].removed && edgeComponent[next] === -1) { edgeComponent[next] = id; stack.push(next); }
      }
    }
    edges.sort((a, b) => a - b);
    components.push({ id, firstEdge: edges[0], edges, nodes });
  }
  let main = -1;
  for (let i = 0; i < components.length; i++) if (main < 0 || components[i].edges.length > components[main].edges.length) main = i;
  if (main >= 0) components[main].main = true;
  for (const component of components) if (component.id !== main) {
    const sourceIndexes = [...new Set(component.edges.map(edge => graph.edges[edge].sourceIndex))].sort((a, b) => a - b);
    diagnostics.push({
      index: sourceIndexes[0] ?? null, sourceId: graph.edges[component.firstEdge].sourceId ?? null,
      code: IMPORT_DIAGNOSTIC_CODES.DISCONNECTED_COMPONENT,
      message: `drivable component with ${component.edges.length} edge(s) is disconnected from the largest component`,
      component: component.id, edgeCount: component.edges.length, sourceIndexes,
    });
  }
  return components;
}

/**
 * Convert normalized local line records into a deterministic, level-aware
 * RoadGraph. `roadId` is the stable string "<sourceIndex>:<sourcePart>".
 */
export function importRoadGraph(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!plain(options)) throw new TypeError('options must be an object');
  const bounds = boundsOf(options);
  const quantum = optionNumber(options.quantum ?? options.quantization, QUANTUM, 'quantum', { positive: true });
  const snapTolerance = optionNumber(options.snapTolerance, quantum / 2 + 1e-9, 'snapTolerance');
  const laneWidth = optionNumber(options.laneWidth, 3.5, 'laneWidth', { positive: true });
  const suppliedWidths = options.widths || options.classWidths || options.defaultWidths || {};
  if (!plain(suppliedWidths)) throw new TypeError('widths must be an object');
  const widths = {};
  for (const cls of CLASSES) widths[cls] = optionNumber(suppliedWidths[cls], BASE_WIDTHS[cls], `widths.${cls}`, { positive: true });
  const diagnostics = [], segments = [];
  const q = value => Math.round(value / quantum) * quantum;
  const qx = value => Math.max(Math.ceil(bounds.minX / quantum) * quantum, Math.min(Math.floor(bounds.maxX / quantum) * quantum, q(value)));
  const qz = value => Math.max(Math.ceil(bounds.minZ / quantum) * quantum, Math.min(Math.floor(bounds.maxZ / quantum) * quantum, q(value)));

  records.forEach((record, arrayIndex) => {
    const sourceIndex = Number.isInteger(record?.index) ? record.index : arrayIndex;
    const sourceId = record?.sourceId ?? null;
    if (!plain(record) || record.geometry?.type !== 'line' || !Array.isArray(record.geometry.parts)) {
      diagnostics.push({ index: sourceIndex, sourceId, code: IMPORT_DIAGNOSTIC_CODES.NON_LINE_RECORD, message: 'record is not normalized line geometry' });
      return;
    }
    const metadata = normalizeMetadata(record, sourceIndex, diagnostics, widths, laneWidth);
    record.geometry.parts.forEach((part, sourcePart) => {
      if (!Array.isArray(part) || part.length < 2 || part.some(point => !Array.isArray(point) || point.length < 2 || !finite(point[0]) || !finite(point[1]))) {
        diagnostics.push({ index: sourceIndex, sourceId, sourcePart, code: IMPORT_DIAGNOSTIC_CODES.INVALID_LINE_PART, message: 'line part must contain at least two finite [x, z] points' });
        return;
      }
      let clippedCount = 0;
      for (let sourceSegment = 0; sourceSegment < part.length - 1; sourceSegment++) {
        const clipped = clipSegment(part[sourceSegment], part[sourceSegment + 1], bounds);
        if (!clipped) continue;
        clippedCount++;
        const a = [qx(clipped[0][0]), qz(clipped[0][1])], b = [qx(clipped[1][0]), qz(clipped[1][1])];
        if (a[0] === b[0] && a[1] === b[1]) {
          diagnostics.push({ index: sourceIndex, sourceId, sourcePart, sourceSegment, code: IMPORT_DIAGNOSTIC_CODES.ZERO_LENGTH, message: 'clipped segment collapsed during quantization' });
          continue;
        }
        segments.push({ a, b, cuts: [{ t: 0, p: a }, { t: 1, p: b }], sourceIndex, sourceId, sourcePart, sourceSegment, roadId: `${sourceIndex}:${sourcePart}`, ...metadata });
      }
      if (clippedCount === 0) diagnostics.push({ index: sourceIndex, sourceId, sourcePart, code: IMPORT_DIAGNOSTIC_CODES.EMPTY_AFTER_CLIP, message: 'line part has no segment inside the viewport' });
    });
  });

  // Compute topology before mutating the graph. Besides proper crossings,
  // endpoint-on-segment cuts cover T junctions and collinear partial overlap.
  const addCut = (segment, t, p) => segment.cuts.push({ t: Math.max(0, Math.min(1, t)), p: [qx(p[0]), qz(p[1])] });
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (a.level !== b.level) continue;
    const crossing = segIntersect(a.a[0], a.a[1], a.b[0], a.b[1], b.a[0], b.a[1], b.b[0], b.b[1]);
    if (crossing) {
      const p = [crossing.x, crossing.z]; addCut(a, crossing.t, p); addCut(b, crossing.u, p);
    }
    for (const [point, owner, other] of [[a.a, a, b], [a.b, a, b], [b.a, b, a], [b.b, b, a]]) {
      const d = pointSegDist(point[0], point[1], other.a[0], other.a[1], other.b[0], other.b[1]);
      if (d.d <= snapTolerance) { const t = point === owner.a ? 0 : 1; addCut(owner, t, point); addCut(other, d.t, point); }
    }
  }

  const graph = new RoadGraph(options.cellSize === undefined ? 24 : optionNumber(options.cellSize, 24, 'cellSize', { positive: true }));
  const nodeIds = new Map(), edgeKeys = new Map();
  const nodeAt = (point, level) => {
    const key = `${point[0]},${point[1]},${level}`;
    if (!nodeIds.has(key)) nodeIds.set(key, graph.addNode(point[0], point[1], { level }));
    return nodeIds.get(key);
  };
  let candidateSubsegments = 0, duplicateSegments = 0;
  for (const segment of segments) {
    segment.cuts.sort((a, b) => a.t - b.t || a.p[0] - b.p[0] || a.p[1] - b.p[1]);
    const cuts = segment.cuts.filter((cut, index, all) => index === 0 || cut.p[0] !== all[index - 1].p[0] || cut.p[1] !== all[index - 1].p[1]);
    for (let i = 0; i < cuts.length - 1; i++) {
      const p = cuts[i].p, r = cuts[i + 1].p;
      if (p[0] === r[0] && p[1] === r[1]) continue;
      candidateSubsegments++;
      const a = nodeAt(p, segment.level), b = nodeAt(r, segment.level);
      const key = a < b ? `${segment.level}:${a}:${b}` : `${segment.level}:${b}:${a}`;
      if (edgeKeys.has(key)) {
        duplicateSegments++;
        diagnostics.push({ index: segment.sourceIndex, sourceId: segment.sourceId, sourcePart: segment.sourcePart, sourceSegment: segment.sourceSegment, code: IMPORT_DIAGNOSTIC_CODES.DUPLICATE_SEGMENT, message: 'same-level subsegment duplicates earlier source geometry', retainedEdge: edgeKeys.get(key) });
        continue;
      }
      const edge = graph.addEdge(a, b, segment);
      edgeKeys.set(key, edge);
    }
  }

  const components = componentDiagnostics(graph, diagnostics);
  const lineRecords = records.filter(record => plain(record) && record.geometry?.type === 'line' && Array.isArray(record.geometry.parts));
  const disconnectedEdges = components.filter(component => !component.main).reduce((sum, component) => sum + component.edges.length, 0);
  const stats = {
    records: records.length,
    lineRecords: lineRecords.length,
    skippedRecords: records.length - lineRecords.length,
    sourceParts: lineRecords.reduce((sum, record) => sum + record.geometry.parts.length, 0),
    sourceSegments: segments.length,
    candidateSubsegments,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    duplicateSegments,
    components: components.length,
    roadComponents: components.length,
    disconnectedComponents: Math.max(0, components.length - 1),
    disconnectedEdges,
    diagnostics: diagnostics.length,
  };
  return { graph, diagnostics, stats };
}

export default importRoadGraph;
