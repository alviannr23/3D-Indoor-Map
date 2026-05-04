/* ══════════════════════════════════════════════════════════
   AStar — single-floor and multi-floor pathfinding
   ══════════════════════════════════════════════════════════ */

/**
 * Single-floor A* (backward-compatible).
 * @param {import('./NavigationGraph.js').NavigationGraph} graph
 * @param {string} startId
 * @param {string} goalId
 * @param {'fastest'|'main'} mode
 * @returns {string[]|null}
 */
export function findPath(graph, startId, goalId, mode = 'main') {
  if (!graph.nodes[startId] || !graph.nodes[goalId]) return null;
  if (startId === goalId) return [startId];

  let cost, h;

  if (mode === 'fastest') {
    cost = (a, b) => graph.dist(a, b);
    h    = (id)   => graph.dist(id, goalId);
  } else {
    const MAIN_MULT  = 0.2;
    const SMALL_MULT = 3.0;
    cost = (a, b) => {
      const w = graph.getEdgeWidth(a, b);
      return graph.dist(a, b) * (w >= 2 ? MAIN_MULT : SMALL_MULT);
    };
    h = (id) => graph.dist(id, goalId) * MAIN_MULT;
  }

  const open     = new Set([startId]);
  const cameFrom = {};
  const gScore   = {};
  const fScore   = {};

  for (const id of Object.keys(graph.nodes)) {
    gScore[id] = Infinity;
    fScore[id] = Infinity;
  }
  gScore[startId] = 0;
  fScore[startId] = h(startId);

  while (open.size > 0) {
    let current = null, bestF = Infinity;
    for (const id of open) {
      if (fScore[id] < bestF) { bestF = fScore[id]; current = id; }
    }

    if (current === goalId) return _reconstructPath(cameFrom, current);
    open.delete(current);

    for (const neighbor of graph.neighbors(current)) {
      const tentative = gScore[current] + cost(current, neighbor);
      if (tentative < gScore[neighbor]) {
        cameFrom[neighbor] = current;
        gScore[neighbor]   = tentative;
        fScore[neighbor]   = tentative + h(neighbor);
        open.add(neighbor);
      }
    }
  }

  return null;
}

/* ── Multi-floor helpers ────────────────────────────────── */

function _splitId(fullId) {
  const sep = fullId.indexOf(':');
  return [parseInt(fullId.slice(0, sep)), fullId.slice(sep + 1)];
}

function _canUseConnector(tag, fromFloor, toFloor) {
  if (!tag) return false;
  if (tag === 'escalator_up')   return toFloor > fromFloor;
  if (tag === 'escalator_down') return toFloor < fromFloor;
  return true; // lift, stairs, escalator_both
}

const CONNECTOR_COST = 30; // fixed cost per floor transition (in graph distance units)

/**
 * Multi-floor A* over an array of NavigationGraph instances.
 * Node IDs in the returned path use the format "${floorIdx}:${nodeId}".
 *
 * @param {import('./NavigationGraph.js').NavigationGraph[]} graphs
 * @param {number} startFloor
 * @param {string} startId
 * @param {number} goalFloor
 * @param {string} goalId
 * @param {'fastest'|'main'} mode
 * @returns {string[]|null}
 */
export function findPathMultiFloor(graphs, startFloor, startId, goalFloor, goalId, mode = 'main') {
  if (!graphs[startFloor]?.nodes[startId]) return null;
  if (!graphs[goalFloor]?.nodes[goalId])   return null;

  const fullStart = `${startFloor}:${startId}`;
  const fullGoal  = `${goalFloor}:${goalId}`;
  if (fullStart === fullGoal) return [fullStart];

  const MAIN_MULT  = 0.2;
  const SMALL_MULT = 3.0;

  function neighbors(fullId) {
    const [fi, id] = _splitId(fullId);
    const graph = graphs[fi];
    if (!graph) return [];
    const result = [];
    for (const nb of graph.neighbors(id)) result.push(`${fi}:${nb}`);
    const node = graph.nodes[id];
    if (node?.tag && node?.connectedTo) {
      const { floorIdx: toFi, nodeId: toId } = node.connectedTo;
      if (graphs[toFi]?.nodes[toId] && _canUseConnector(node.tag, fi, toFi)) {
        result.push(`${toFi}:${toId}`);
      }
    }
    return result;
  }

  function cost(fromFull, toFull) {
    const [fromFi, fromId] = _splitId(fromFull);
    const [toFi,   toId]   = _splitId(toFull);
    if (fromFi !== toFi) return CONNECTOR_COST;
    const graph = graphs[fromFi];
    if (mode === 'fastest') return graph.dist(fromId, toId);
    const w = graph.getEdgeWidth(fromId, toId);
    return graph.dist(fromId, toId) * (w >= 2 ? MAIN_MULT : SMALL_MULT);
  }

  const goalNode = graphs[goalFloor]?.nodes[goalId];
  function h(fullId) {
    const [fi, id] = _splitId(fullId);
    const node = graphs[fi]?.nodes[id];
    if (!node || !goalNode) return 0;
    const dx = node.x - goalNode.x, dz = node.z - goalNode.z;
    return Math.sqrt(dx * dx + dz * dz) * (mode === 'fastest' ? 1 : MAIN_MULT);
  }

  // Collect all node IDs upfront for gScore initialisation
  const allIds = [];
  for (let fi = 0; fi < graphs.length; fi++) {
    if (!graphs[fi]) continue;
    for (const id of Object.keys(graphs[fi].nodes)) allIds.push(`${fi}:${id}`);
  }

  const open     = new Set([fullStart]);
  const cameFrom = {};
  const gScore   = Object.fromEntries(allIds.map(id => [id, Infinity]));
  const fScore   = Object.fromEntries(allIds.map(id => [id, Infinity]));

  gScore[fullStart] = 0;
  fScore[fullStart] = h(fullStart);

  while (open.size > 0) {
    let current = null, bestF = Infinity;
    for (const id of open) {
      if (fScore[id] < bestF) { bestF = fScore[id]; current = id; }
    }

    if (current === fullGoal) return _reconstructPath(cameFrom, current);
    open.delete(current);

    for (const neighbor of neighbors(current)) {
      const tentative = gScore[current] + cost(current, neighbor);
      const prev = gScore[neighbor] ?? Infinity;
      if (tentative < prev) {
        cameFrom[neighbor] = current;
        gScore[neighbor]   = tentative;
        fScore[neighbor]   = tentative + h(neighbor);
        open.add(neighbor);
      }
    }
  }

  return null;
}

function _reconstructPath(cameFrom, current) {
  const path = [current];
  while (cameFrom[current] !== undefined) {
    current = cameFrom[current];
    path.unshift(current);
  }
  return path;
}
