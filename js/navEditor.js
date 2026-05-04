/* ══════════════════════════════════════════════════════════
   NavEditor — in-scene waypoint graph editor
   ══════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';

const NODE_COLOR    = 0x22c55e;
const SEL_COLOR     = 0xfbbf24;
const NODE_RADIUS   = 0.012;
const NODE_Y_OFFSET = 0.02;
const EDGE_Y_OFFSET = 0.018;

function _closestOnSeg(px, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return {
    x: ax + t * dx,
    y: ay + t * (by - ay),
    z: az + t * dz,
    dist: Math.hypot(px - (ax + t * dx), pz - (az + t * dz)),
  };
}

export class NavEditor {
  constructor(scene, graph) {
    this._scene  = scene;
    this._graph  = graph;

    this.active     = false;
    this.tool       = 'node';
    this._edgeWidth = 1;

    this._group    = new THREE.Group();
    this._scene.add(this._group);

    this._spheres        = {};
    this._edgeLines      = [];
    this._selectedSet    = new Set();  // multi-select (node tool)
    this._connectPending = null;       // first node picked in connect tool

    this._undoStack = [];
    this._redoStack = [];
    this._moveStart = null;  // { [id]: {x,y,z} } — batched WASD undo
    this._moveTimer = null;

    this._rebuild();
    this.setActive(false);
  }

  /* ── Public API ─────────────────────────────────────────── */

  setActive(bool) {
    this.active = bool;
    this._group.visible = bool;
    this._deselect();
    this._updateStatus();
  }

  setTool(t) {
    this.tool = t;
    this._deselect();
    this._updateUI();
  }

  setEdgeWidth(w) {
    this._edgeWidth = Math.max(1, Math.min(3, w));
    this._updateUI();
  }

  handleFloorHit(point) {
    if (this.tool !== 'node') return;
    this._deselect();

    const splitEdge = this._findNearestEdge(point.x, point.z, 0.02);
    const pos = splitEdge ? splitEdge.snap : { x: point.x, y: point.y, z: point.z };
    const id  = this._graph.addNode(pos.x, pos.y, pos.z);
    this._addSphere(id);

    if (splitEdge) {
      const { from, to, width } = splitEdge;
      this._graph.removeEdge(from, to);
      this._graph.addEdge(from, id, width);
      this._graph.addEdge(id, to, width);
      this._rebuildEdges();
      this._pushUndo({
        undo: () => {
          this._graph.removeEdge(from, id);
          this._graph.removeEdge(id, to);
          this._graph.removeNode(id);
          this._removeSphere(id);
          this._graph.addEdge(from, to, width);
          this._rebuildEdges();
        },
        redo: () => {
          this._graph.addNode(pos.x, pos.y, pos.z, id);
          this._addSphere(id);
          this._graph.removeEdge(from, to);
          this._graph.addEdge(from, id, width);
          this._graph.addEdge(id, to, width);
          this._rebuildEdges();
        },
      });
    } else {
      this._pushUndo({
        undo: () => { this._graph.removeNode(id); this._removeSphere(id); this._rebuildEdges(); },
        redo: () => { this._graph.addNode(pos.x, pos.y, pos.z, id); this._addSphere(id); },
      });
    }
    this._updateStatus();
  }

  handleNodeClick(nodeId) {
    if (this.tool === 'delete') {
      const node       = { ...this._graph.nodes[nodeId] };
      const savedEdges = Object.values(this._graph.edges)
        .filter(e => e.from === nodeId || e.to === nodeId)
        .map(e => ({ from: e.from, to: e.to, width: e.width || 1 }));

      this._removeSphere(nodeId);
      this._graph.removeNode(nodeId);
      this._rebuildEdges();
      this._pushUndo({
        undo: () => {
          this._graph.addNode(node.x, node.y, node.z, nodeId);
          this._addSphere(nodeId);
          savedEdges.forEach(e => this._graph.addEdge(e.from, e.to, e.width));
          this._rebuildEdges();
        },
        redo: () => {
          this._graph.removeNode(nodeId);
          this._removeSphere(nodeId);
          this._rebuildEdges();
        },
      });
      this._updateStatus();
      return;
    }

    if (this.tool === 'connect') {
      if (this._connectPending === null) {
        this._connectPending = nodeId;
        this._setColor(nodeId, SEL_COLOR);
      } else if (this._connectPending === nodeId) {
        this._setColor(nodeId, NODE_COLOR);
        this._connectPending = null;
      } else {
        const a = this._connectPending, b = nodeId;
        const hadEdge  = this._graph.hasEdge(a, b);
        const oldWidth = hadEdge ? this._graph.getEdgeWidth(a, b) : null;
        const newWidth = this._edgeWidth;
        if (hadEdge) {
          this._graph.removeEdge(a, b);
        } else {
          this._graph.addEdge(a, b, newWidth);
        }
        this._setColor(a, NODE_COLOR);
        this._connectPending = null;
        this._rebuildEdges();
        this._pushUndo({
          undo: () => {
            hadEdge ? this._graph.addEdge(a, b, oldWidth) : this._graph.removeEdge(a, b);
            this._rebuildEdges();
          },
          redo: () => {
            hadEdge ? this._graph.removeEdge(a, b) : this._graph.addEdge(a, b, newWidth);
            this._rebuildEdges();
          },
        });
        this._updateStatus();
      }
      return;
    }

    // node tool — toggle in multi-select
    if (this._selectedSet.has(nodeId)) {
      this._selectedSet.delete(nodeId);
      this._setColor(nodeId, NODE_COLOR);
    } else {
      this._selectedSet.add(nodeId);
      this._setColor(nodeId, SEL_COLOR);
    }
    this._updateStatus();
  }

  /* set selection from outside (box selection in app.js) */
  selectNodes(ids) {
    this._deselect();
    for (const id of ids) {
      if (this._graph.nodes[id]) {
        this._selectedSet.add(id);
        this._setColor(id, SEL_COLOR);
      }
    }
    this._updateStatus();
  }

  deleteSelected() {
    if (this._selectedSet.size === 0) return;
    const toDelete = [...this._selectedSet];

    // collect all edges touching any selected node, deduplicated
    const edgeMap = new Map();
    for (const nodeId of toDelete) {
      for (const e of Object.values(this._graph.edges)) {
        if (e.from === nodeId || e.to === nodeId) {
          const key = [e.from, e.to].sort().join('|');
          edgeMap.set(key, { from: e.from, to: e.to, width: e.width || 1 });
        }
      }
    }
    const savedEdges = [...edgeMap.values()];
    const savedNodes = toDelete.map(id => ({ id, ...this._graph.nodes[id] }));

    for (const nodeId of toDelete) {
      this._removeSphere(nodeId);
      this._graph.removeNode(nodeId);
    }
    this._selectedSet.clear();
    this._rebuildEdges();

    this._pushUndo({
      undo: () => {
        for (const { id, x, y, z } of savedNodes) {
          this._graph.addNode(x, y, z, id);
          this._addSphere(id);
        }
        savedEdges.forEach(e => this._graph.addEdge(e.from, e.to, e.width));
        this._rebuildEdges();
      },
      redo: () => {
        for (const { id } of savedNodes) {
          this._graph.removeNode(id);
          this._removeSphere(id);
        }
        this._rebuildEdges();
      },
    });
    this._updateStatus();
  }

  clearAll() {
    const savedNodes  = JSON.parse(JSON.stringify(this._graph.nodes));
    const savedEdges  = JSON.parse(JSON.stringify(this._graph.edges));
    const savedNextId = this._graph._nextId;

    this._graph.clear();
    for (const id of Object.keys(this._spheres)) this._removeSphere(id);
    this._rebuildEdges();
    this._pushUndo({
      undo: () => {
        this._graph.nodes   = savedNodes;
        this._graph.edges   = savedEdges;
        this._graph._nextId = savedNextId;
        this._graph._save();
        this._rebuild();
      },
      redo: () => {
        this._graph.clear();
        for (const id of Object.keys(this._spheres)) this._removeSphere(id);
        this._rebuildEdges();
      },
    });
    this._updateStatus();
  }

  getNodeMeshes() { return Object.values(this._spheres); }

  /* ── Undo / Redo ────────────────────────────────────────── */
  undo() {
    const entry = this._undoStack.pop();
    if (!entry) return;
    entry.undo();
    this._redoStack.push(entry);
    this._updateStatus();
    this._updateUndoButtons();
  }

  redo() {
    const entry = this._redoStack.pop();
    if (!entry) return;
    entry.redo();
    this._undoStack.push(entry);
    this._updateStatus();
    this._updateUndoButtons();
  }

  /* ── WASD move (all selected nodes) ────────────────────── */
  moveSelected(dx, dz) {
    if (this._selectedSet.size === 0) return;
    const ids = [...this._selectedSet];

    if (!this._moveStart) {
      this._moveStart = {};
      for (const id of ids) {
        const n = this._graph.nodes[id];
        if (n) this._moveStart[id] = { x: n.x, y: n.y, z: n.z };
      }
    }
    clearTimeout(this._moveTimer);

    for (const id of ids) {
      const node = this._graph.nodes[id];
      if (!node) continue;
      node.x += dx; node.z += dz;
      const mesh = this._spheres[id];
      if (mesh) mesh.position.set(node.x, node.y + NODE_Y_OFFSET, node.z);
    }
    this._graph._save();
    this._rebuildEdges();

    const origStart = { ...this._moveStart };
    this._moveTimer = setTimeout(() => {
      const currPos = {};
      for (const id of ids) {
        const n = this._graph.nodes[id];
        if (n) currPos[id] = { x: n.x, z: n.z };
      }
      this._pushUndo({
        undo: () => {
          for (const id of ids) {
            const n = this._graph.nodes[id]; if (!n) continue;
            const orig = origStart[id]; if (!orig) continue;
            n.x = orig.x; n.z = orig.z;
            const m = this._spheres[id]; if (m) m.position.set(orig.x, orig.y + NODE_Y_OFFSET, orig.z);
          }
          this._graph._save(); this._rebuildEdges();
        },
        redo: () => {
          for (const id of ids) {
            const n = this._graph.nodes[id]; if (!n) continue;
            const curr = currPos[id]; if (!curr) continue;
            n.x = curr.x; n.z = curr.z;
            const m = this._spheres[id]; if (m) m.position.set(curr.x, n.y + NODE_Y_OFFSET, curr.z);
          }
          this._graph._save(); this._rebuildEdges();
        },
      });
      this._moveStart = null;
    }, 400);
  }

  _pushUndo(entry) {
    this._undoStack.push(entry);
    this._redoStack = [];
    this._updateUndoButtons();
  }

  /* ── Sphere helpers ─────────────────────────────────────── */
  _addSphere(id) {
    const node = this._graph.nodes[id];
    if (!node) return;
    const geo  = new THREE.SphereGeometry(NODE_RADIUS, 10, 10);
    const mat  = new THREE.MeshBasicMaterial({ color: NODE_COLOR });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(node.x, node.y + NODE_Y_OFFSET, node.z);
    mesh.userData.nodeId = id;
    this._spheres[id] = mesh;
    this._group.add(mesh);
  }

  _removeSphere(id) {
    const mesh = this._spheres[id];
    if (!mesh) return;
    mesh.geometry.dispose(); mesh.material.dispose();
    this._group.remove(mesh);
    delete this._spheres[id];
  }

  _setColor(id, color) {
    const mesh = this._spheres[id];
    if (mesh) mesh.material.color.setHex(color);
  }

  _deselect() {
    for (const id of this._selectedSet) this._setColor(id, NODE_COLOR);
    this._selectedSet.clear();
    if (this._connectPending !== null) {
      this._setColor(this._connectPending, NODE_COLOR);
      this._connectPending = null;
    }
  }

  /* ── Edge lines (per-width colors) ─────────────────────── */
  _rebuildEdges() {
    for (const l of this._edgeLines) {
      l.geometry.dispose(); l.material.dispose(); this._group.remove(l);
    }
    this._edgeLines = [];

    const edges = Object.values(this._graph.edges);
    const nodes = this._graph.nodes;
    if (!edges.length) return;

    const smallPts = [], mainPts = [];
    for (const e of edges) {
      const na = nodes[e.from], nb = nodes[e.to];
      if (!na || !nb) continue;
      const seg = [na.x, na.y + EDGE_Y_OFFSET, na.z, nb.x, nb.y + EDGE_Y_OFFSET, nb.z];
      if ((e.width || 1) >= 2) mainPts.push(...seg);
      else smallPts.push(...seg);
    }

    const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
    const add = (pts, linewidth, color, opacity) => {
      if (!pts.length) return;
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pts);
      const mat = new LineMaterial({ color, linewidth, transparent: true, opacity, depthTest: false, resolution: res });
      const line = new LineSegments2(geo, mat);
      this._group.add(line);
      this._edgeLines.push(line);
    };

    add(smallPts, 1.5, 0xffffff, 0.60);
    add(mainPts,  3.5, 0x22d3ee, 0.90);
  }

  /* ── Full rebuild from persisted graph ──────────────────── */
  _rebuild() {
    for (const id of Object.keys(this._spheres)) this._removeSphere(id);
    for (const id of Object.keys(this._graph.nodes)) this._addSphere(id);
    this._rebuildEdges();
    this._updateStatus();
  }

  /* ── Nearest edge for snap-split ───────────────────────── */
  _findNearestEdge(x, z, threshold) {
    const nodes = this._graph.nodes;
    let best = null, bestDist = threshold;
    for (const e of Object.values(this._graph.edges)) {
      const na = nodes[e.from], nb = nodes[e.to];
      if (!na || !nb) continue;
      const snap = _closestOnSeg(x, z, na.x, na.y, na.z, nb.x, nb.y, nb.z);
      if (snap.dist < bestDist) { bestDist = snap.dist; best = { ...e, snap }; }
    }
    return best;
  }

  /* ── UI sync ────────────────────────────────────────────── */
  _updateStatus() {
    const el = document.getElementById('nav-ed-status');
    if (el) {
      const sel = this._selectedSet.size;
      el.textContent = `${this._graph.nodeCount()} titik · ${this._graph.edgeCount()} jalur${sel ? ` · ${sel} dipilih` : ''}`;
    }
    const singleId = this._selectedSet.size === 1 ? [...this._selectedSet][0] : null;
    window._navNodeSelected?.(singleId, this._graph);
  }

  _updateUI() {
    ['node','connect','delete'].forEach(t => {
      const btn = document.getElementById(`ned-${t}`);
      if (btn) btn.classList.toggle('active', btn.dataset.tool === this.tool);
    });
    const widthRow = document.getElementById('nav-ed-width-row');
    if (widthRow) widthRow.style.display = this.tool === 'connect' ? 'flex' : 'none';
    this._updateWidthButtons();
  }

  _updateWidthButtons() {
    [1, 2].forEach(w => {
      const btn = document.getElementById(`ned-w${w}`);
      if (btn) btn.classList.toggle('active', w === this._edgeWidth);
    });
  }

  _updateUndoButtons() {
    const u = document.getElementById('ned-undo');
    const r = document.getElementById('ned-redo');
    if (u) u.disabled = this._undoStack.length === 0;
    if (r) r.disabled = this._redoStack.length === 0;
  }
}
