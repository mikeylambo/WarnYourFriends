import * as THREE from 'three';
import { TUNING } from '../tuning';

/**
 * The Rampage aura (Mike, 2026-11-24: "Hercules glow / SSJ aura", gold). Presentation only: a soft gold halo and a
 * flickering flame shell drawn just behind the giant (pushed away from the camera so he stays in front and readable),
 * additive, eased in and out with the Rampage tell. Flicker is under 3 Hz in brightness; Reduce Flashes holds it still.
 */
function tex(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RampageAura {
  readonly root = new THREE.Group();
  private halo: THREE.Sprite;
  private flames: THREE.Sprite[] = [];
  private t = 0;
  private v = new THREE.Vector3();

  constructor() {
    const A = TUNING.rampageFx.aura;
    const haloTex = tex((g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,236,160,0.95)');
      r.addColorStop(0.35, 'rgba(255,196,58,0.55)');
      r.addColorStop(1, 'rgba(255,150,20,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }, 128, 128);
    // A flame tongue: wide at the base, licking up to a point, hot at the core.
    const flameTex = tex((g, w, h) => {
      const r = g.createRadialGradient(w / 2, h * 0.72, 0, w / 2, h * 0.72, w * 0.5);
      r.addColorStop(0, 'rgba(255,248,200,1)');
      r.addColorStop(0.45, 'rgba(255,200,60,0.75)');
      r.addColorStop(1, 'rgba(255,140,10,0)');
      g.fillStyle = r;
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.bezierCurveTo(w * 0.98, h * 0.45, w, h, w / 2, h);
      g.bezierCurveTo(0, h, w * 0.02, h * 0.45, w / 2, 0);
      g.fill();
    }, 64, 128);
    const mat = (map: THREE.Texture) => new THREE.SpriteMaterial({ map, color: A.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    this.halo = new THREE.Sprite(mat(haloTex));
    this.root.add(this.halo);
    for (let i = 0; i < A.flames; i++) {
      const s = new THREE.Sprite(mat(flameTex));
      s.center.set(0.5, 0);
      this.flames.push(s);
      this.root.add(s);
    }
    this.root.visible = false;
  }

  /** k: the Rampage tell 0..1. (x, z) his feet, `scale` his size, `cam` to push the aura behind him. */
  update(dt: number, k: number, x: number, z: number, scale: number, cam: THREE.Camera, still: boolean) {
    const A = TUNING.rampageFx.aura;
    this.root.visible = k > 0.01;
    if (!this.root.visible) return;
    this.t += dt;
    const h = A.height * scale;
    // Behind him from the camera's side, so the glow outlines him instead of washing over him.
    this.v.set(x, h * 0.5, z).sub(cam.position).setY(0).normalize().multiplyScalar(A.behind * scale);
    this.root.position.set(x + this.v.x, 0, z + this.v.z);
    const flick = still ? 1 : 1 + A.flicker * Math.sin(this.t * Math.PI * 2 * A.flickerHz);
    this.halo.position.y = h * 0.55;
    this.halo.scale.set(h * A.haloScale, h * A.haloScale * 1.15, 1);
    (this.halo.material as THREE.SpriteMaterial).opacity = A.haloOpacity * k * flick;
    const n = this.flames.length;
    this.flames.forEach((s, i) => {
      // Tongues fanned across his width, each licking up on its own rhythm.
      const f = n > 1 ? i / (n - 1) - 0.5 : 0;
      const lick = still ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * A.lickHz * Math.PI * 2 + i * 2.3);
      s.position.set(0, 0, 0);
      s.position.x = 0;
      s.material.rotation = -f * 0.5;
      s.center.set(0.5 - f * 1.6, 0);
      s.scale.set(h * A.flameWidth, h * (A.flameHeight + A.flameLick * lick), 1);
      (s.material as THREE.SpriteMaterial).opacity = A.flameOpacity * k * (0.7 + 0.3 * lick);
    });
  }
}
