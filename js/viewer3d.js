// WebGL replacement for backend/visualize.py: spatial MPS (element surface) and MAS (axon fibres) views.
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { parseFEMB } from "./models.js";

export const MPS_RANGE = [0.0, 0.5];
export const MAS_RANGE = [0.0, 0.15];

// matplotlib's "jet" colormap, as piecewise-linear segments (x, y).
const JET = {
  r: [[0, 0], [0.35, 0], [0.66, 1], [0.89, 1], [1, 0.5]],
  g: [[0, 0], [0.125, 0], [0.375, 1], [0.64, 1], [0.91, 0], [1, 0]],
  b: [[0, 0.5], [0.11, 1], [0.34, 1], [0.65, 0], [1, 0]],
};
function interp(seg, x) {
  for (let i = 1; i < seg.length; i++) {
    if (x <= seg[i][0]) {
      const [x0, y0] = seg[i - 1], [x1, y1] = seg[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return seg[seg.length - 1][1];
}
export function jet(t) {
  const x = Math.min(1, Math.max(0, Number.isNaN(t) ? 0 : t));
  return [interp(JET.r, x), interp(JET.g, x), interp(JET.b, x)];
}
export function jetCSS(t) {
  const [r, g, b] = jet(t);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

let meshPromise = null;
/** Brain surface + fibre geometry, loaded once. `fetchBuffer(url)` resolves an ArrayBuffer. */
export function loadMeshes(fetchBuffer) {
  if (!meshPromise) {
    meshPromise = Promise.all([fetchBuffer("data/mesh/brain.bin"), fetchBuffer("data/mesh/fibers.bin")])
      .then(([b, f]) => ({ brain: parseFEMB(b), fibers: parseFEMB(f) }))
      .catch((e) => { meshPromise = null; throw e; });
  }
  return meshPromise;
}

let brainPromise = null;
/** Brain surface only (for the direction picture), loaded once. */
export function loadBrainMesh(fetchBuffer) {
  if (!brainPromise) brainPromise = fetchBuffer("data/mesh/brain.bin").then(parseFEMB).catch((e) => { brainPromise = null; throw e; });
  return brainPromise;
}

export class SpatialViewer {
  /**
   * @param {HTMLElement} host    element that will contain the canvas
   * @param {"MPS"|"MAS"} kind
   * @param {object} meshes       result of loadMeshes()
   */
  constructor(host, kind, meshes) {
    this.host = host;
    this.kind = kind;
    this.range = kind === "MPS" ? MPS_RANGE : MAS_RANGE;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.localClippingEnabled = true;
    this.materials = [];
    this.cuts = { x: null, y: null, z: null }; // per axis: a THREE.Plane while that cut is active
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.setTheme(document.documentElement.dataset.theme === "dark");
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    this.camera.up.set(0, 0, 1); // data are z-up; the default camera looks from +x, like matplotlib elev=0, azim=0

    const { brain, fibers } = meshes;
    const V = brain.arrays.V, tris = brain.arrays.tris, quadOfTri = brain.arrays.quadOfTri, faceElem = brain.arrays.faceElem;
    this.faceElem = faceElem;

    const nT = tris.length / 3;
    const pos = new Float32Array(nT * 9);
    for (let i = 0; i < nT * 3; i++) {
      const v = tris[i] * 3;
      pos[i * 3] = V[v]; pos[i * 3 + 1] = V[v + 1]; pos[i * 3 + 2] = V[v + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.quadOfTri = quadOfTri;

    if (kind === "MPS") {
      this.colorAttr = new THREE.BufferAttribute(new Float32Array(nT * 9), 3);
      geo.setAttribute("color", this.colorAttr);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.materials.push(mat);
      this.scene.add(new THREE.Mesh(geo, mat));
    } else {
      const shell = new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
      this.materials.push(shell);
      this.scene.add(new THREE.Mesh(geo, shell));
      const { Vf, idx1, idx2 } = fibers.arrays;
      const nS = idx1.length;
      const lp = new Float32Array(nS * 6);
      for (let i = 0; i < nS; i++) {
        const a = idx1[i] * 3, b = idx2[i] * 3;
        lp.set([Vf[a], Vf[a + 1], Vf[a + 2], Vf[b], Vf[b + 1], Vf[b + 2]], i * 6);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
      this.lineColors = new THREE.BufferAttribute(new Float32Array(nS * 6), 3);
      lg.setAttribute("color", this.lineColors);
      const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
      this.materials.push(lineMat);
      this.scene.add(new THREE.LineSegments(lg, lineMat));
    }

    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.bbox = geo.boundingBox.clone();
    this.center = geo.boundingSphere.center.clone();
    this.radius = geo.boundingSphere.radius;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener("change", () => {
      this.render();
      if (this.peer && !this._applying) this.peer.applyView(this);
    });
    this.resetView();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  /**
   * Slice the model with a plane perpendicular to one data axis.
   * @param {"x"|"y"|"z"} axis  @param {boolean} on  @param {number} t  position across the model, 0..1  @param {boolean} flip  keep the other side
   */
  setCut(axis, on, t = 0.5, flip = false) {
    if (!on) this.cuts[axis] = null;
    else {
      const lo = this.bbox.min[axis], hi = this.bbox.max[axis], v = lo + (hi - lo) * t;
      const n = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
      // keep the side that is NOT cut away: coordinate <= v, or >= v when flipped
      this.cuts[axis] = flip ? new THREE.Plane(n, -v) : new THREE.Plane(n.negate(), v);
    }
    const planes = Object.values(this.cuts).filter(Boolean);
    for (const m of this.materials) { m.clippingPlanes = planes; m.needsUpdate = true; }
    this.render();
  }

  /** Keep this view and another one at the same camera angle, zoom and pan. */
  link(other) {
    this.peer = other;
    other.peer = this;
    other.applyView(this);
  }

  applyView(src) {
    this._applying = true;
    this.camera.position.copy(src.camera.position);
    this.controls.target.copy(src.controls.target);
    this.controls.update();
    this._applying = false;
    this.render();
  }

  defaultPose() {
    const dist = (this.radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05;
    return new THREE.Vector3(this.center.x + dist, this.center.y, this.center.z);
  }

  resetView() {
    this.camera.position.copy(this.defaultPose());
    this.controls.target.copy(this.center);
    this.controls.update();
    this.render();
  }

  /** values: Float64Array of per-element (MPS) or per-fibre (MAS) predictions. */
  setValues(values) {
    const [lo, hi] = this.range;
    const lut = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) lut.set(jet(i / 255), i * 3);
    const col = (v) => {
      const t = (v - lo) / (hi - lo);
      return Math.round(Math.min(1, Math.max(0, Number.isNaN(t) ? 0 : t)) * 255) * 3;
    };
    if (this.kind === "MPS") {
      const out = this.colorAttr.array;
      for (let tri = 0; tri < this.quadOfTri.length; tri++) {
        const k = col(values[this.faceElem[this.quadOfTri[tri]]]);
        for (let v = 0; v < 3; v++) out.set([lut[k], lut[k + 1], lut[k + 2]], tri * 9 + v * 3);
      }
      this.colorAttr.needsUpdate = true;
    } else {
      const out = this.lineColors.array;
      for (let i = 0; i < values.length; i++) {
        const k = col(values[i]);
        out.set([lut[k], lut[k + 1], lut[k + 2], lut[k], lut[k + 1], lut[k + 2]], i * 6);
      }
      this.lineColors.needsUpdate = true;
    }
    this.render();
  }

  resize() {
    const w = Math.max(50, this.host.clientWidth), h = Math.max(50, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  setTheme(dark) {
    this.dark = dark;
    this.renderer.setClearColor(dark ? 0x0d1626 : 0xffffff, 1);
    if (this.scene) this.render();
  }

  /**
   * Current view as a canvas element (for PNG export, always on a white background).
   * Exports always use the default camera so MPS and MAS face the same way, whatever the user has rotated on screen.
   */
  snapshot() {
    const pos = this.camera.position.clone(), target = this.controls.target.clone();
    this.camera.position.copy(this.defaultPose());
    this.camera.lookAt(this.center);
    this.renderer.setClearColor(0xffffff, 1);
    this.render();
    // restore the user's view once the caller has copied the pixels
    requestAnimationFrame(() => {
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
      this.setTheme(this.dark);
    });
    return this.renderer.domElement;
  }

  dispose() {
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
