/* ══════════════════════════════════════════════════════════
   NavigationGraph — waypoint graph for indoor pathfinding
   Persisted in localStorage under 'imap_navgraph'
   ══════════════════════════════════════════════════════════ */

export class NavigationGraph {
  constructor(lsKey = 'imap_navgraph') {
    this._lsKey = lsKey;
    this.nodes = {}; // id → { id, x, y, z }
    this.edges = {}; // sortedKey → { from, to, width }
    this._nextId = 1;
    this._load();
  }

  /* ── Node management ───────────────────────────────────── */
  addNode(x, y, z, forcedId = null) {
    let id;
    if (forcedId !== null) {
      id = String(forcedId);
      const n = parseInt(id, 10);
      if (!isNaN(n) && n >= this._nextId) this._nextId = n + 1;
    } else {
      id = String(this._nextId++);
    }
    this.nodes[id] = { id, x, y, z };
    this._save();
    return id;
  }

  removeNode(id) {
    if (!this.nodes[id]) return;
    delete this.nodes[id];
    for (const key of Object.keys(this.edges)) {
      const e = this.edges[key];
      if (e.from === id || e.to === id) delete this.edges[key];
    }
    this._save();
  }

  /* ── Edge management ───────────────────────────────────── */
  _edgeKey(a, b) {
    return a < b ? `${a}__${b}` : `${b}__${a}`;
  }

  addEdge(a, b, width = 1) {
    if (a === b) return;
    if (!this.nodes[a] || !this.nodes[b]) return;
    const key = this._edgeKey(a, b);
    this.edges[key] = { from: a, to: b, width: Math.max(1, Math.min(3, width)) };
    this._save();
  }

  removeEdge(a, b) {
    delete this.edges[this._edgeKey(a, b)];
    this._save();
  }

  hasEdge(a, b) {
    return Boolean(this.edges[this._edgeKey(a, b)]);
  }

  getEdgeWidth(a, b) {
    return this.edges[this._edgeKey(a, b)]?.width || 1;
  }

  setEdgeWidth(a, b, width) {
    const e = this.edges[this._edgeKey(a, b)];
    if (e) { e.width = Math.max(1, Math.min(3, width)); this._save(); }
  }

  /* ── Cross-floor connector ─────────────────────────────── */
  setNodeTag(id, tag) {
    const node = this.nodes[id];
    if (!node) return;
    if (tag) node.tag = tag; else delete node.tag;
    this._save();
  }

  setNodeConnector(id, targetFloorIdx, targetNodeId) {
    const node = this.nodes[id];
    if (!node) return;
    node.connectedTo = { floorIdx: targetFloorIdx, nodeId: String(targetNodeId) };
    this._save();
  }

  clearNodeConnector(id) {
    const node = this.nodes[id];
    if (!node) return;
    delete node.connectedTo;
    this._save();
  }

  neighbors(id) {
    const result = [];
    for (const e of Object.values(this.edges)) {
      if (e.from === id) result.push(e.to);
      else if (e.to === id) result.push(e.from);
    }
    return result;
  }

  /* ── Distance & cost ───────────────────────────────────── */
  dist(a, b) {
    const na = this.nodes[a], nb = this.nodes[b];
    if (!na || !nb) return Infinity;
    const dx = na.x - nb.x, dz = na.z - nb.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Edge cost weighted by width.
   * widthWeight 0 = pure distance, 1 = wide roads strongly preferred.
   * Wide roads get a cost multiplier of 1/sqrt(width) so width=2 → 30% cheaper.
   */
  edgeCost(a, b, widthWeight = 0) {
    const d = this.dist(a, b);
    const w = this.getEdgeWidth(a, b);
    const multiplier = 1 - widthWeight * (1 - 1 / Math.sqrt(w));
    return d * multiplier;
  }

  nearest(x, z) {
    let bestId = null, bestD = Infinity;
    for (const node of Object.values(this.nodes)) {
      const dx = node.x - x, dz = node.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestId = node.id; }
    }
    return bestId;
  }

  /* ── Counts ────────────────────────────────────────────── */
  nodeCount() { return Object.keys(this.nodes).length; }
  edgeCount() { return Object.keys(this.edges).length; }

  /* ── Reset ─────────────────────────────────────────────── */
  clear() {
    this.nodes = {};
    this.edges = {};
    this._nextId = 1;
    this._save();
  }

  /* ── Persistence ───────────────────────────────────────── */
  _save() {
    try {
      localStorage.setItem(this._lsKey, JSON.stringify({
        nodes:  this.nodes,
        edges:  this.edges,
        nextId: this._nextId,
      }));
    } catch (e) {
      console.warn('[NavGraph] _save failed:', e);
    }
    // Push ke Supabase (fire-and-forget)
    import('./db.js').then(({ saveNavGraph }) =>
      saveNavGraph(this._lsKey, this.nodes, this.edges, this._nextId)
    ).catch(() => {});
  }

  _load() {
    try {
      const raw = localStorage.getItem(this._lsKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.nodes   = data.nodes  || {};
      this.edges   = data.edges  || {};
      this._nextId = data.nextId || 1;
    } catch (e) {
      console.warn('[NavGraph] _load failed:', e);
    }
  }

  /** Load dari Supabase (dipanggil saat startup jika ada data di DB) */
  async loadFromDB() {
    try {
      const { fetchNavGraph, saveNavGraph } = await import('./db.js');
      const row = await fetchNavGraph(this._lsKey);
      if (!row) {
        // DB kosong → migrate data localStorage ke Supabase
        if (Object.keys(this.nodes).length > 0) {
          saveNavGraph(this._lsKey, this.nodes, this.edges, this._nextId).catch(() => {});
        }
        return;
      }
      this.nodes   = row.nodes   || {};
      this.edges   = row.edges   || {};
      this._nextId = row.next_id || 1;
      // Sync ke localStorage juga
      localStorage.setItem(this._lsKey, JSON.stringify({
        nodes: this.nodes, edges: this.edges, nextId: this._nextId,
      }));
    } catch (e) {
      console.warn('[NavGraph] loadFromDB failed:', e);
    }
  }
}
