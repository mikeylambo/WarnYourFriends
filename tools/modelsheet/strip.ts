/**
 * Stride strip (dev only): one tier, eight moments across a stride (one full left+right cycle),
 * from the side and from Chase High. For judging the run cycle on the Meshy model frame by frame.
 * /tools/modelsheet/strip.html?tier=2[&greybox=1]
 */
import * as THREE from 'three';
import { GiantView } from '../../src/render/giant';
import { Gait } from '../../src/anim/gait';
import { TUNING } from '../../src/tuning';

const q = new URLSearchParams(location.search);
const tier = Number(q.get('tier') ?? 2);
const greybox = q.get('greybox') === '1';
const N = 8, W = 1600, H = 560, cw = W / N, ch = H / 2;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8d2c4);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8070, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-4, 10, 6);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 40), new THREE.MeshLambertMaterial({ color: 0xbdb5a3 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const giant = new GiantView();
for (const o of giant.objects) scene.add(o);
if (!greybox) await giant.ready;
const gait = new Gait();
const T = TUNING.tiers[tier];
const speed = T.topSpeed, stepLen = speed / T.cadence, dt = 1 / 60;
let x = 0, stepPos = 0, t = 0;
const step = (secs: number) => {
  for (let k = 0; k < Math.round(secs / dt); k++) {
    x += speed * dt;
    stepPos += (speed * dt) / stepLen;
    t += dt;
    const gf = gait.update({ x, z: 0, fx: 1, fz: 0, speed, stepPos, stepLen, tier, dt });
    giant.update(dt, { x, z: 0, heading: 0, travel: 0, lateralVel: 0, speed, tier, braking: false, stumble: 0, stepPos }, gf);
  }
};
step(3);
const cycle = 2 / T.cadence; // two steps = one full stride cycle
const labels = document.getElementById('l')!;
for (let i = 0; i < N; i++) {
  if (i) step(cycle / N);
  for (let v = 0; v < 2; v++) {
    const cam = new THREE.PerspectiveCamera(30, cw / ch, 0.1, 200);
    cam.position.set(v === 0 ? x + 0.5 : x - 9, v === 0 ? 2.0 : 9, v === 0 ? 10 : 1.5);
    cam.lookAt(x - (v ? 0.6 : 0), 1.6, 0);
    const px = i * cw, py = H - (v + 1) * ch;
    renderer.setViewport(px, py, cw, ch);
    renderer.setScissor(px + 1, py + 1, cw - 2, ch - 2);
    renderer.render(scene, cam);
  }
  const s = document.createElement('span');
  s.style.left = `${i * cw + 6}px`;
  s.style.top = '4px';
  s.textContent = `${Math.round((i / N) * 100)}%`;
  labels.append(s);
}
(window as unknown as { __SHEET: boolean }).__SHEET = true;
