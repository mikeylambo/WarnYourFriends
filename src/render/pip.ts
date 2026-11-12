import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';

/**
 * Phase 2 viewer video: a bystander's phone (an overpass, a window) ahead of the giant,
 * handheld, filming him as he charges past (he whips by and the phone pans to
 * follow). Rendered into a small viewport over the #pip frame for ~3s.
 * Presentation only; cosmetic randomness.
 */
export class ViewerVideo {
  readonly camera = new THREE.PerspectiveCamera(40, 128 / 220, 0.5, 500);
  private t = 0;
  private cooldown = 0;
  private spot = new THREE.Vector3();
  private shake = new THREE.Vector3();
  private shakeV = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(private frame: HTMLElement) {}

  get active(): boolean {
    return this.t > 0;
  }

  reset() {
    this.t = 0;
    this.cooldown = 4;
    this.frame.hidden = true;
  }

  /** A big moment: roll viewer video if the story is big enough and we haven't just shown one. */
  trigger(sim: Sim, ratingsTier: number, force = false) {
    const C = TUNING.coverage;
    if (!force && (this.cooldown > 0 || ratingsTier < C.pipTier || !sim.live)) return;
    const g = sim.giant;
    const ahead = 9 + g.speed * 0.55;
    const s = g.s + ahead;
    const w = sim.track.widthAt(s);
    const left = Math.random() < 0.5;
    // From an overpass or a window: high enough that his lit pool fills the background at night.
    const p = sim.track.posAt(s, left ? -4 : w + 4, { x: 0, z: 0 });
    this.spot.set(p.x, 6 + Math.random() * 3, p.z);
    this.t = C.pipTime;
    this.look.set(0, 0, 0);
    this.cooldown = C.pipGap;
    this.frame.hidden = false;
  }

  update(dt: number, giant: { x: number; z: number }) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.t <= 0) return;
    this.t -= dt;
    if (this.t <= 0) {
      this.frame.hidden = true;
      return;
    }
    // Handheld: a springy wobble, plus the operator flinching as he passes.
    this.shakeV.x += (Math.random() - 0.5) * 6 * dt - this.shake.x * 8 * dt;
    this.shakeV.y += (Math.random() - 0.5) * 6 * dt - this.shake.y * 8 * dt;
    this.shake.addScaledVector(this.shakeV, dt * 4);
    this.camera.position.copy(this.spot).add(this.shake);
    this.look.lerp(new THREE.Vector3(giant.x, 2.2, giant.z), this.look.lengthSq() === 0 ? 1 : Math.min(1, dt * 7));
    this.camera.lookAt(this.look);
  }

  /** Draw over the #pip frame (call after the main render). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    if (this.t <= 0) return;
    const r = this.frame.getBoundingClientRect();
    const H = renderer.domElement.clientHeight;
    const x = r.left + 2;
    const y = H - r.bottom + 2;
    const w = r.width - 4;
    const h = r.height - 4;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const prev = renderer.autoClear;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.autoClear = true;
    renderer.render(scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, H);
    renderer.autoClear = prev;
  }
}
