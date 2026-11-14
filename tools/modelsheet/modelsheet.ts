/**
 * Model sheet (dev only, not in the build): the giant at each tier from the side, from
 * Chase High (behind and above) and straight down. Same GiantView and gait as the game.
 * `npm run dev`, then open /tools/modelsheet/ ; tools/modelsheet.mjs screenshots it.
 * ?t=<seconds> sets how long he runs before the freeze (the stride phase).
 */
import * as THREE from 'three';
import { GiantView } from '../../src/render/giant';
import { Gait } from '../../src/anim/gait';
import { TUNING } from '../../src/tuning';

const W = 1500, H = 900;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
const runFor = Number(new URLSearchParams(location.search).get('t') ?? 3.3);
const views = [
  { name: 'side', pos: (x: number) => new THREE.Vector3(x + 0.5, 2.2, 9) },
  { name: 'chase high', pos: (x: number) => new THREE.Vector3(x - 9, 9, 1.5) },
  { name: 'top down', pos: (x: number) => new THREE.Vector3(x + 0.01, 13, 0) },
];
const labels = document.getElementById('l')!;
const cells: { scene: THREE.Scene; cam: THREE.PerspectiveCamera }[] = [];
for (let tier = 0; tier < 3; tier++) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd8d2c4);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8070, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-4, 10, 6);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 40), new THREE.MeshLambertMaterial({ color: 0xbdb5a3 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const giant = new GiantView();
  for (const o of giant.objects) scene.add(o);
  const gait = new Gait();
  const T = TUNING.tiers[tier];
  const speed = T.topSpeed;
  const stepLen = speed / T.cadence;
  let x = 0, stepPos = 0;
  const dt = 1 / 60;
  for (let t = 0; t < runFor; t += dt) {
    x += speed * dt;
    stepPos += (speed * dt) / stepLen;
    const gf = gait.update({ x, z: 0, fx: 1, fz: 0, speed, stepPos, stepLen, tier, dt });
    giant.update(dt, { x, z: 0, heading: 0, travel: 0, lateralVel: 0, speed, tier, braking: false, stumble: 0, stepPos }, gf);
  }
  scene.add(new THREE.AxesHelper(0.001));
  for (let v = 0; v < 3; v++) {
    const cam = new THREE.PerspectiveCamera(32, W / 3 / (H / 3), 0.1, 200);
    cam.position.copy(views[v].pos(x));
    if (v === 2) cam.up.set(1, 0, 0);
    cam.lookAt(x - (tier ? 0.6 : 0.2), 1.7, 0);
    cells.push({ scene, cam });
    const s = document.createElement('span');
    s.style.left = `${(v * W) / 3 + 8}px`;
    s.style.top = `${(tier * H) / 3 + 6}px`;
    s.textContent = `${T.name} · ${views[v].name}`;
    labels.append(s);
  }
}
cells.forEach((c, i) => {
  const v = i % 3, tier = Math.floor(i / 3);
  const x = (v * W) / 3, y = H - ((tier + 1) * H) / 3;
  renderer.setViewport(x, y, W / 3, H / 3);
  renderer.setScissor(x + 1, y + 1, W / 3 - 2, H / 3 - 2);
  renderer.render(c.scene, c.cam);
});
(window as unknown as { __SHEET: boolean }).__SHEET = true;
