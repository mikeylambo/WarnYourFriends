// Vehicle sheet (dev): every lane prop and police unit body, chopper view on top, side-on below.
// Open /tools/modelsheet/vehicles.html under `npx vite`; tools/shots-vehicles.mjs screenshots it.
import * as THREE from 'three';
import { propBody } from '../../src/render/highway';
import { PROP_DEFS } from '../../src/sim/track';
import { KIND_COLORS } from '../../src/render/palette';
import type { PropKind } from '../../src/sim/types';

const kinds: PropKind[] = ['car', 'van', 'foodtruck', 'cruiser', 'compact', 'scooter', 'dozer', 'cart', 'barricade', 'tollgate'];
const W = 1600, H = 900;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a3340);
scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(5, 12, 7);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 60), new THREE.MeshLambertMaterial({ color: 0x6a6270 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
kinds.forEach((kind, i) => {
  const d = PROP_DEFS[kind];
  const m = propBody({ kind, hl: d.hl, hw: d.hw }, KIND_COLORS[kind][i % KIND_COLORS[kind].length]);
  m.position.set(i * 8 - (kinds.length - 1) * 4, 0, 0);
  m.rotation.y = Math.PI / 2; // nose up the screen in the chopper view
  scene.add(m);
});
const top = new THREE.PerspectiveCamera(30, W / (H / 2), 1, 400);
top.position.set(0, 42, 34);
top.lookAt(0, 0, -2);
const side = new THREE.PerspectiveCamera(22, W / (H / 2), 1, 400);
side.position.set(0, 3.5, 66);
side.lookAt(0, 1.2, 0);
renderer.setViewport(0, H / 2, W, H / 2);
renderer.setScissor(0, H / 2, W, H / 2);
renderer.render(scene, top);
for (const o of scene.children) if ((o as THREE.Mesh).isMesh && o !== ground) o.rotation.y = 0;
renderer.setViewport(0, 0, W, H / 2);
renderer.setScissor(0, 0, W, H / 2);
renderer.render(scene, side);
(window as unknown as { ready: boolean }).ready = true;
