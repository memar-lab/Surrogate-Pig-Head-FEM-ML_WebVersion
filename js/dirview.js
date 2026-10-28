// Small 3D pig brain (the MPS mesh) that shows the selected impact direction as a rotation arrow.
// Frame used here: +X toward the viewer, Y to the right, +Z up (right-handed).
import * as THREE from "three";

export const DIRECTION_TEXT = {
  Axial: "Axial: the head rotates about the vertical axis, from left to right.",
  Sagittal: "Sagittal: the head rotates in the side plane, from bottom to top.",
  Coronal: "Coronal: the head rotates in the front plane, tilting to the sides.",
};

const ORANGE = 0xd85a30;
const RING_R = 3.7;

// Long (anterior-posterior) axis of the brain mesh, from its principal component. The picture is drawn looking down this axis.
const AP = new THREE.Vector3(0.5666831, 0.8093131, -0.1545399);

/** Brain surface (the same mesh as the MPS view) in the view frame: +X toward the viewer, Y to the viewer's right, +Z up; radius ~3.2. */
function brainGeometry(brain) {
  const V = brain.arrays.V, tris = brain.arrays.tris;
  const up = new THREE.Vector3(0, 0, 1).addScaledVector(AP, -AP.z).normalize();
  const right = up.clone().cross(AP);
  const P = new Float32Array(V.length);
  for (let i = 0; i < V.length; i += 3) {
    P[i] = V[i] * AP.x + V[i + 1] * AP.y + V[i + 2] * AP.z;
    P[i + 1] = V[i] * right.x + V[i + 1] * right.y + V[i + 2] * right.z;
    P[i + 2] = V[i] * up.x + V[i + 1] * up.y + V[i + 2] * up.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(tris), 1));
  g.computeBoundingSphere();
  const { center, radius } = g.boundingSphere;
  g.translate(-center.x, -center.y, -center.z);
  g.scale(3.2 / radius, 3.2 / radius, 3.2 / radius);
  g.computeVertexNormals();
  return g;
}

export class DirectionView {
  constructor(host, brainPromise) {
    this.host = host;
    this.direction = "Sagittal";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(13, -2, 2.4);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb4b9c1, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(6, -4, 8);
    this.scene.add(sun);
    this.arrow = new THREE.Group();
    this.scene.add(this.arrow);
    this.rings = this.makeRings();
    this.scene.add(this.rings);
    this.ready = brainPromise.then((brain) => {
      this.mesh = new THREE.Mesh(brainGeometry(brain), new THREE.MeshLambertMaterial({ color: 0xd3d6db }));
      this.scene.add(this.mesh);
      this.setTheme(document.documentElement.dataset.theme === "dark");
      this.setDirection(this.direction);
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  makeRings() {
    const group = new THREE.Group();
    this.ringMat = new THREE.LineDashedMaterial({ color: 0x8a94a3, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.8 });
    for (const normal of ["z", "y", "x"]) {
      const pts = [];
      for (let i = 0; i <= 120; i++) pts.push(this.pointOnRing(normal, (i / 120) * Math.PI * 2));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.ringMat);
      line.computeLineDistances();
      group.add(line);
    }
    return group;
  }

  /** Point at angle a on the ring whose plane is perpendicular to the given axis. a = 0 is +X (toward the viewer) or +Z for the x-ring. */
  pointOnRing(normal, a) {
    const c = Math.cos(a) * RING_R, s = Math.sin(a) * RING_R;
    if (normal === "z") return new THREE.Vector3(c, s, 0); // axial ring: horizontal
    if (normal === "y") return new THREE.Vector3(c, 0, s); // sagittal ring: side plane
    return new THREE.Vector3(0, s, c); // coronal ring: front plane (a = 0 at the top)
  }

  setTheme(dark) {
    this.ringMat.color.set(dark ? 0x7d8aa0 : 0x7f8896);
    if (this.mesh) this.mesh.material.color.set(dark ? 0xb4bac4 : 0xd3d6db);
    this.render();
  }

  /** Screen-space direction (+1/-1) of motion along the ring at angle a for increasing angle. */
  screenSign(normal, a, axis) {
    const p0 = this.pointOnRing(normal, a), p1 = this.pointOnRing(normal, a + 0.05);
    this.camera.updateMatrixWorld();
    const s0 = p0.clone().project(this.camera), s1 = p1.clone().project(this.camera);
    const d = axis === "right" ? s1.x - s0.x : s1.y - s0.y;
    return d >= 0 ? 1 : -1;
  }

  setDirection(name) {
    this.direction = name;
    this.arrow.clear();
    // ring plane, arc centre angle, and which way the arrow must appear to move on screen
    const spec = {
      Axial: { normal: "z", mid: -Math.PI / 2, towards: "right" },
      Sagittal: { normal: "y", mid: 0, towards: "up" },
      Coronal: { normal: "x", mid: 0, towards: "right" },
    }[name];
    if (!spec) { this.render(); return; }
    this.camera.updateMatrixWorld();
    const sign = this.screenSign(spec.normal, spec.mid, spec.towards);
    const half = name === "Coronal" ? 1.3 : 0.95; // radians either side of the centre
    const pts = [];
    for (let i = 0; i <= 48; i++) pts.push(this.pointOnRing(spec.normal, spec.mid + sign * (-half + (2 * half * i) / 48)));
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.09, 10),
      new THREE.MeshBasicMaterial({ color: ORANGE }),
    );
    const tip = pts[pts.length - 1], prev = pts[pts.length - 3];
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 18), new THREE.MeshBasicMaterial({ color: ORANGE }));
    cone.position.copy(tip);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(prev).normalize());
    this.arrow.add(tube, cone);
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
}
