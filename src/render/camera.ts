import * as THREE from 'three';
import { TUNING } from '../tuning';
import { approach } from '../sim/math';

/**
 * §15 news-chopper camera: top-down, 70° pitch, FOV 40, height by tier eased
 * over 0.6s, lags 0.25s, leads 3m toward heading, gentle wobble.
 * Screen-space jolts are pixel offsets via setViewOffset so they read the same
 * at any zoom.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private fx = 0;
  private fz = 0;
  private height: number = TUNING.tiers[0].cameraHeight;
  private heightFrom: number = TUNING.tiers[0].cameraHeight;
  private heightTo: number = TUNING.tiers[0].cameraHeight;
  private heightT = 1;
  private pullOut = 0;
  private shakes: { px: number; t: number; max: number }[] = [];
  private time = 0;
  reducedMotion = false;
  private w = 1;
  private h = 1;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(TUNING.camera.fov, 1, 1, 600);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  snap(x: number, z: number, tier: number) {
    this.fx = x;
    this.fz = z;
    this.height = this.heightFrom = this.heightTo = TUNING.tiers[tier].cameraHeight;
    this.heightT = 1;
  }

  setTier(tier: number) {
    const target = TUNING.tiers[tier].cameraHeight;
    if (target === this.heightTo) return;
    this.heightFrom = this.height;
    this.heightTo = target;
    this.heightT = 0;
  }

  tierUpPulse() {
    this.pullOut = TUNING.camera.tierUpPullOut;
  }

  /** Screen jolt in CSS px (§10 impact scale, §15 heavy smash jolt). */
  jolt(px: number, time: number = TUNING.camera.joltTime) {
    if (this.reducedMotion || px <= 0) return;
    this.shakes.push({ px, t: 0, max: time });
  }

  update(dt: number, x: number, z: number, travel: number) {
    const C = TUNING.camera;
    this.time += dt;
    const tx = x + Math.cos(travel) * C.lead;
    const tz = z + Math.sin(travel) * C.lead;
    const a = approach(dt, C.lag);
    this.fx += (tx - this.fx) * a;
    this.fz += (tz - this.fz) * a;

    if (this.heightT < 1) {
      this.heightT = Math.min(1, this.heightT + dt / C.heightEase);
      const e = this.heightT * this.heightT * (3 - 2 * this.heightT); // smoothstep
      this.height = this.heightFrom + (this.heightTo - this.heightFrom) * e;
    }
    this.pullOut *= Math.exp(-dt / (C.tierUpPullOutTime / 3));
    const hgt = this.height + this.pullOut;

    const pitch = (C.pitchDeg * Math.PI) / 180;
    const back = hgt / Math.tan(pitch);
    this.camera.position.set(this.fx, hgt, this.fz + back);
    this.camera.lookAt(this.fx, 0, this.fz);
    if (!this.reducedMotion) {
      const w = (C.wobbleDeg * Math.PI) / 180;
      const ph = this.time * Math.PI * 2 * C.wobbleHz;
      this.camera.rotateX(Math.sin(ph) * w);
      this.camera.rotateY(Math.sin(ph * 0.73 + 1.3) * w);
      this.camera.rotateZ(Math.sin(ph * 0.51 + 2.1) * w * 0.6);
    }

    // Pixel shake.
    let ox = 0;
    let oy = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.t += dt;
      if (s.t >= s.max) {
        this.shakes.splice(i, 1);
        continue;
      }
      const k = 1 - s.t / s.max;
      ox += (Math.random() * 2 - 1) * s.px * k;
      oy += (Math.random() * 2 - 1) * s.px * k;
    }
    if (ox || oy) this.camera.setViewOffset(this.w, this.h, ox, oy, this.w, this.h);
    else this.camera.clearViewOffset();
  }
}
