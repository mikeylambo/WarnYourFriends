/**
 * Dev only: compare candidate run clips on the giant, eight moments of one cycle each, side view.
 * /tools/modelsheet/clips.html?f=<glb>,<glb>  (GLBs as served by the dev server, e.g. /meshy_output/...)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const files = (new URLSearchParams(location.search).get('f') ?? '').split(',').filter(Boolean);
const N = 8, W = 1600, rowH = 230, H = rowH * files.length, cw = W / N;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c') as HTMLCanvasElement, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setScissorTest(true);
const labels = document.getElementById('l')!;
const info: string[] = [];
for (let r = 0; r < files.length; r++) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(r % 2 ? 0xd2ccbe : 0xd8d2c4);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8070, 2));
  const gltf = await new GLTFLoader().loadAsync(files[r]);
  const root = gltf.scene;
  root.rotation.y = Math.PI / 2;
  scene.add(root);
  const clip = gltf.animations[0];
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const hipsTrack = clip.tracks.find((t) => t.name.startsWith('Hips') && t.name.endsWith('.position'));
  info.push(`${files[r].split('/').pop()}: ${clip.duration.toFixed(3)}s, hips position track: ${hipsTrack ? 'yes' : 'no'}`);
  for (let i = 0; i < N; i++) {
    mixer.setTime((clip.duration * i) / N);
    root.updateMatrixWorld(true);
    const hips = root.getObjectByName('Hips')!.getWorldPosition(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(30, cw / rowH, 0.01, 200);
    cam.position.set(hips.x + 0.3, 1.9, hips.z + 9);
    cam.lookAt(hips.x, 1.5, hips.z);
    const px = i * cw, py = H - (r + 1) * rowH;
    renderer.setViewport(px, py, cw, rowH);
    renderer.setScissor(px + 1, py + 1, cw - 2, rowH - 2);
    renderer.render(scene, cam);
  }
  const s = document.createElement('span');
  s.style.left = '6px';
  s.style.top = `${r * rowH + 4}px`;
  s.textContent = files[r].split('/').pop()!;
  labels.append(s);
}
console.log(info.join('\n'));
(window as unknown as { __SHEET: boolean }).__SHEET = true;
