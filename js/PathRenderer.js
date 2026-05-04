/* ══════════════════════════════════════════════════════════
   PathRenderer — Line2 (screen-space width) path + endpoint markers
   ══════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { Line2 }        from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const LINE_WIDTH       = 4;           // screen pixels
const DASH_SPEED       = 0.12;        // higher = faster traveling light
const SPHERE_RADIUS    = 0.022;
const COLOR_START      = 0x22c55e;
const COLOR_END        = 0x6366f1;
const COLOR_GRADIENT_A = new THREE.Color(0x6366f1);
const COLOR_GRADIENT_B = new THREE.Color(0x22d3ee);

export class PathRenderer {
  constructor(scene) {
    this._scene  = scene;
    this._group  = new THREE.Group();
    this._scene.add(this._group);

    this._line        = null;
    this._sphereStart = null;
    this._sphereEnd   = null;
    this._t = 0;
  }

  render(positions) {
    this.clear();
    if (!positions || positions.length < 2) return;

    const pts = positions.map(p => new THREE.Vector3(p.x, p.y + 0.025, p.z));

    // ── Line2 — exact path, screen-space width, always on top ──
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap(p => [p.x, p.y, p.z]));

    const tmp = new THREE.Color();
    const colorArr = [];
    for (let i = 0; i < pts.length; i++) {
      tmp.lerpColors(COLOR_GRADIENT_A, COLOR_GRADIENT_B, i / (pts.length - 1));
      colorArr.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setColors(colorArr);

    const mat = new LineMaterial({
      linewidth:    LINE_WIDTH,
      vertexColors: true,
      transparent:  true,
      opacity:      0.92,
      depthTest:    false,
      depthWrite:   false,
      resolution:   new THREE.Vector2(window.innerWidth, window.innerHeight),
      dashed:       true,
      dashSize:     0.06,
      gapSize:      0.03,
      dashOffset:   0,
    });

    this._line = new Line2(geo, mat);
    this._line.computeLineDistances();
    this._group.add(this._line);

    // ── Pulse spheres ────────────────────────────────────────
    this._sphereStart = this._makeSphere(pts[0],              COLOR_START);
    this._sphereEnd   = this._makeSphere(pts[pts.length - 1], COLOR_END);
    this._group.add(this._sphereStart, this._sphereEnd);
  }

  update(dt) {
    this._t += dt;

    // traveling dash animation
    if (this._line) {
      this._line.material.dashOffset -= dt * DASH_SPEED;
    }

    const pulse = Math.abs(Math.sin(this._t * 3.5));
    for (const s of [this._sphereStart, this._sphereEnd]) {
      if (!s) continue;
      s.scale.setScalar(0.7 + 0.6 * pulse);
      s.material.opacity = 0.5 + 0.5 * pulse;
    }
  }

  clear() {
    for (const child of [...this._group.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      this._group.remove(child);
    }
    this._line = null; this._sphereStart = null; this._sphereEnd = null;
  }

  dispose() { this.clear(); this._scene.remove(this._group); }

  _makeSphere(position, color) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SPHERE_RADIUS, 12, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    mesh.position.copy(position);
    return mesh;
  }
}
