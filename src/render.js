// Shared three.js viewer: scene, orthographic camera, controls, render loop.
// Renderers (solid.js, ink.js) only populate viewer.world from a CityModel.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(viewport) {
    this.viewport = viewport;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 4000);
    this.camera.position.set(720, 720, 720);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .055;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 35, 0);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = .75;
    this.controls.minZoom = .45;
    this.controls.maxZoom = 4.5;
    this.controls.saveState();

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x59606a, 2.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sun.position.set(420, 700, 240);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -650; this.sun.shadow.camera.right = 650;
    this.sun.shadow.camera.top = 650; this.sun.shadow.camera.bottom = -650;
    this.scene.add(this.sun);

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.timer = new THREE.Timer();
    this.animation = null;
    const loop = time => {
      requestAnimationFrame(loop);
      this.timer.update();
      this.animation?.(time / 1000);
      this.controls.update(this.timer.getDelta());
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  clearWorld() {
    this.setAnimation(null);
    while (this.world.children.length) {
      const o = this.world.children.pop();
      o.traverse?.(n => {
        if (n.geometry) n.geometry.dispose?.();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m.dispose?.());
      });
    }
  }

  // Install one renderer-owned per-frame update. The callback receives time
  // since installation, so rerendering restarts motion without mutating the
  // deterministic CityModel.
  setAnimation(update) {
    if (!update) { this.animation = null; return; }
    const start = performance.now() / 1000;
    this.animation = now => update(Math.max(0, now - start));
  }

  setFrustum(aspect) {
    const view = 920;
    this.camera.left = -view * aspect / 2;
    this.camera.right = view * aspect / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.setFrustum(w / h);
  }

  fit() {
    this.camera.zoom = window.innerWidth < 720 ? .72 : 1.0;
    this.camera.position.set(720, 720, 720);
    this.controls.target.set(0, 45, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // Render the current scene once at an explicit pixel size (for exports),
  // then restore the on-screen setup.
  renderToSize(w, h) {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.setFrustum(w / h);
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    const restore = () => this.resize();
    return { canvas, restore };
  }
}

export function mat(color, rough = .86) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: .04 });
}

export function addBox(group, spec, material, y = 0) {
  const geo = new THREE.BoxGeometry(spec.w, spec.h ?? 1, spec.d);
  const m = new THREE.Mesh(geo, material);
  m.position.set(spec.x + spec.w / 2, y + (spec.h ?? 1) / 2, spec.z + spec.d / 2);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

// One BufferGeometry for many flat polygons (roads, parks, blocks…) lying in
// the XZ plane at height y. Triangulated with earcut via ShapeUtils; concave
// simple polygons are fine. Keeps ground fills to one draw call per layer.
export function flatPolygonsGeometry(polys, y = 0) {
  const pos = [], idx = [];
  let base = 0;
  for (const poly of polys) {
    if (!poly || poly.length < 3) continue;
    const contour = poly.map(p => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [x, z] of poly) pos.push(x, y, z);
    for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
    base += poly.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function polygonMesh(polys, material, y = 0) {
  const m = new THREE.Mesh(flatPolygonsGeometry(polys, y), material);
  m.receiveShadow = true;
  return m;
}
