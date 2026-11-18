import * as THREE from 'three';
import { TUNING } from '../tuning';

/**
 * Impact effects (review #64/#65): smoke and dust puffs, metal sparks, tyre skid marks. All pooled, nothing
 * allocated per effect; presentation only (reads nothing from the sim). Cosmetic randomness uses Math.random.
 */

function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function skidTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.25, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0.9)');
  g.fillStyle = grad;
  g.fillRect(3, 0, 3, 64);
  g.fillRect(10, 0, 3, 64);
  return new THREE.CanvasTexture(c);
}

type Puff = { sprite: THREE.Sprite; t: number; life: number; size0: number; size1: number; vx: number; vy: number; vz: number; alpha: number };
type Spark = { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number; life: number; g: number; ember: boolean };
type Skid = { mesh: THREE.Mesh; t: number };

export class Vfx {
  readonly group = new THREE.Group();
  private puffs: Puff[] = [];
  private puffNext = 0;
  private sparks: Spark[] = [];
  private sparkNext = 0;
  private sparkGeo: THREE.BufferGeometry;
  private sparkPos: Float32Array;
  private sparkCol: Float32Array;
  private skids: Skid[] = [];
  private lines: { t: number; life: number; b: number }[] = [];
  private lineNext = 0;
  private lineGeo: THREE.BufferGeometry;
  private linePos: Float32Array;
  private lineCol: Float32Array;
  private skidNext = 0;
  /** Reduce Flashes: sparks dimmer and fewer. */
  reduceFlashes = false;

  constructor() {
    const V = TUNING.vfx;
    const tex = puffTexture();
    for (let i = 0; i < V.puffMax; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      sprite.visible = false;
      this.group.add(sprite);
      this.puffs.push({ sprite, t: 1, life: 1, size0: 1, size1: 1, vx: 0, vy: 0, vz: 0, alpha: 0 });
    }
    // Sparks: one line-segment buffer, a short streak each (one draw call for all of them).
    this.sparkPos = new Float32Array(V.sparkMax * 6);
    this.sparkCol = new Float32Array(V.sparkMax * 6);
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(this.sparkGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;
    this.group.add(lines);
    for (let i = 0; i < V.sparkMax; i++) this.sparks.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 1, life: 0, g: 18, ember: false });
    // Speed lines: world-space streaks beside his path that the camera sweeps past (one draw call).
    this.linePos = new Float32Array(V.speedLineMax * 6);
    this.lineCol = new Float32Array(V.speedLineMax * 6);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    const speed = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    speed.frustumCulled = false;
    this.group.add(speed);
    for (let i = 0; i < V.speedLineMax; i++) this.lines.push({ t: 1, life: 0, b: 0 });
    // Skid marks: flat decals on the road that fade out.
    const skidMat = skidTexture();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < V.skidMax; i++) {
      const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: skidMat, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      mesh.visible = false;
      this.group.add(mesh);
      this.skids.push({ mesh, t: Infinity });
    }
  }

  /** Smoke or dust: `n` soft puffs that swell, drift up and fade. */
  puff(x: number, y: number, z: number, n: number, color: number, size: number, life: number, alpha = 0.6, spread = 1.2) {
    for (let k = 0; k < n; k++) {
      const p = this.puffs[this.puffNext];
      this.puffNext = (this.puffNext + 1) % this.puffs.length;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      p.sprite.position.set(x + Math.cos(a) * r, y + Math.random() * 0.6, z + Math.sin(a) * r);
      (p.sprite.material as THREE.SpriteMaterial).color.setHex(color);
      p.t = 0;
      p.life = life * (0.75 + Math.random() * 0.5);
      p.size0 = size * (0.5 + Math.random() * 0.3);
      p.size1 = size * (1.4 + Math.random() * 0.6);
      p.vx = Math.cos(a) * 0.8;
      p.vz = Math.sin(a) * 0.8;
      p.vy = 0.6 + Math.random() * 0.8;
      p.alpha = alpha;
      p.sprite.visible = true;
    }
  }

  /** Metal sparks thrown along (dirX, dirZ), with gravity. */
  spark(x: number, y: number, z: number, dirX: number, dirZ: number, n: number) {
    const count = this.reduceFlashes ? Math.ceil(n / 2) : n;
    for (let k = 0; k < count; k++) {
      const s = this.sparks[this.sparkNext];
      this.sparkNext = (this.sparkNext + 1) % this.sparks.length;
      const sp = 6 + Math.random() * 10;
      const a = (Math.random() - 0.5) * 2.2;
      const c = Math.cos(a), si = Math.sin(a);
      s.x = x;
      s.y = y;
      s.z = z;
      s.vx = (dirX * c - dirZ * si) * sp;
      s.vz = (dirZ * c + dirX * si) * sp;
      s.vy = 2 + Math.random() * 5;
      s.t = 0;
      s.life = 0.25 + Math.random() * 0.35;
      s.g = 18;
      s.ember = false;
    }
  }

  /** Rampage aura: embers lifting off him (`r` m around him), orange-hot, drifting up. */
  ember(x: number, y: number, z: number, r: number, n: number) {
    for (let k = 0; k < n; k++) {
      const s = this.sparks[this.sparkNext];
      this.sparkNext = (this.sparkNext + 1) % this.sparks.length;
      const a = Math.random() * Math.PI * 2;
      s.x = x + Math.cos(a) * r * (0.6 + Math.random() * 0.4);
      s.y = y * (0.2 + Math.random() * 0.8);
      s.z = z + Math.sin(a) * r * (0.6 + Math.random() * 0.4);
      s.vx = Math.cos(a) * 0.8;
      s.vz = Math.sin(a) * 0.8;
      s.vy = 2.5 + Math.random() * 2.5;
      s.g = -1.5; // rises a touch faster as it goes
      s.ember = true;
      s.t = 0;
      s.life = 0.45 + Math.random() * 0.4;
    }
  }

  /** A speed line: a streak `len` m along (dirX, dirZ) at (x, y, z). */
  speedLine(x: number, y: number, z: number, dirX: number, dirZ: number, len: number, bright: number) {
    const i = this.lineNext;
    this.lineNext = (this.lineNext + 1) % this.lines.length;
    const o = i * 6;
    this.linePos[o] = x;
    this.linePos[o + 1] = y;
    this.linePos[o + 2] = z;
    this.linePos[o + 3] = x - dirX * len;
    this.linePos[o + 4] = y;
    this.linePos[o + 5] = z - dirZ * len;
    this.lines[i].t = 0;
    this.lines[i].life = 0.22 + Math.random() * 0.12;
    this.lines[i].b = bright;
  }

  /** Two tyre streaks on the road at (x, z), along `yaw`, `len` m long. */
  skid(x: number, z: number, yaw: number, len: number) {
    const s = this.skids[this.skidNext];
    this.skidNext = (this.skidNext + 1) % this.skids.length;
    s.mesh.position.set(x, 0.03, z);
    s.mesh.rotation.y = -yaw + Math.PI / 2;
    s.mesh.scale.set(1.7, 1, len);
    s.t = 0;
    s.mesh.visible = true;
  }

  update(dt: number) {
    const V = TUNING.vfx;
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const sz = p.size0 + (p.size1 - p.size0) * Math.sqrt(k);
      p.sprite.scale.set(sz, sz, 1);
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.alpha * (1 - k) * Math.min(1, k * 8);
    }
    const dim = this.reduceFlashes ? 0.5 : 1;
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      const o = i * 6;
      if (s.t >= s.life) {
        this.sparkCol.fill(0, o, o + 6);
        continue;
      }
      s.t += dt;
      s.vy -= s.g * dt;
      s.x += s.vx * dt;
      s.y = Math.max(0.05, s.y + s.vy * dt);
      s.z += s.vz * dt;
      const tail = 0.06;
      this.sparkPos[o] = s.x;
      this.sparkPos[o + 1] = s.y;
      this.sparkPos[o + 2] = s.z;
      this.sparkPos[o + 3] = s.x - s.vx * tail;
      this.sparkPos[o + 4] = s.y - s.vy * tail;
      this.sparkPos[o + 5] = s.z - s.vz * tail;
      const f = Math.max(0, 1 - s.t / s.life) * dim;
      // Sparks run white-gold to orange; embers are redder.
      this.sparkCol[o] = f;
      this.sparkCol[o + 1] = (s.ember ? 0.45 : 0.75) * f;
      this.sparkCol[o + 2] = (s.ember ? 0.1 : 0.35) * f;
      this.sparkCol[o + 3] = 0.6 * f;
      this.sparkCol[o + 4] = (s.ember ? 0.12 : 0.25) * f;
      this.sparkCol[o + 5] = 0.05 * f;
    }
    (this.sparkGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      const o = i * 6;
      if (l.t >= l.life) {
        if (this.lineCol[o + 1] !== 0 || this.lineCol[o + 4] !== 0) this.lineCol.fill(0, o, o + 6);
        continue;
      }
      l.t += dt;
      const k = l.t / l.life;
      const f = Math.sin(Math.min(1, k) * Math.PI) * l.b;
      this.lineCol[o] = this.lineCol[o + 1] = this.lineCol[o + 2] = f;
      this.lineCol[o + 3] = this.lineCol[o + 4] = this.lineCol[o + 5] = f * 0.15;
    }
    (this.lineGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    for (const s of this.skids) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      const k = s.t / V.skidLife;
      if (k >= 1) {
        s.mesh.visible = false;
        continue;
      }
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = V.skidAlpha * (1 - k * k);
    }
  }

  /** A new broadcast: clear everything in flight. */
  reset() {
    for (const p of this.puffs) p.sprite.visible = false;
    for (const s of this.sparks) s.t = s.life = 0;
    this.sparkCol.fill(0);
    for (const s of this.skids) s.mesh.visible = false;
    for (const l of this.lines) l.t = l.life = 0;
    this.lineCol.fill(0);
  }
}
