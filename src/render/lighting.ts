import * as THREE from 'three';
import { TUNING } from '../tuning';
import { LOOKS, type Look, type TimeOfDay } from './palette';
import { GLOW, chopperTexture, rotorTexture, setGlow, setWindows } from './glow';
import { RIM } from './toon';

/**
 * Phase 0c light rig: night by default, LIVE TIME follows the local clock.
 *
 *  - Sky, fog, hemisphere and moon/sun per look.
 *  - Sodium streetlights: glow decals on every lamp (built by the highway) plus
 *    a few real point lights moved onto the lamps nearest the giant, so he and
 *    the cars are lit as they pass under.
 *  - The news chopper: a spotlight that follows the giant (pool on the road,
 *    a faint visible beam) and a faint shadow that sometimes crosses the road.
 *  - Siren washes: one shared red/blue point light at the lead cruiser, plus a wash decal per car.
 * The light count never changes (no shader recompiles); looks only change values.
 */

export interface LampPos {
  x: number;
  y: number;
  z: number;
}
export interface SirenSource {
  x: number;
  z: number;
  active: boolean;
  /** Flash phase offset (0..1). */
  phase: number;
}

/** Day / dusk / night from a local hour (0–24). Dawn counts as dusk. */
export function timeOfDayAt(hour: number): TimeOfDay {
  const L = TUNING.look;
  if (hour >= L.dayStart && hour < L.duskStart) return 'day';
  if ((hour >= L.duskStart && hour < L.nightStart) || (hour >= L.dawnStart && hour < L.dayStart)) return 'dusk';
  return 'night';
}

export class Lighting {
  mode: TimeOfDay = 'night';
  windows = 1;
  look: Look = LOOKS.night;
  reduceFlashes = false;
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private spot = new THREE.SpotLight(0xe6eeff, 0, 140, 0.2, 0.55, 1.2);
  private lamps: THREE.PointLight[] = [];
  private sirens: THREE.PointLight[] = [];
  private beam: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  private spotPool: THREE.Mesh;
  private shadow = new THREE.Group();
  private shadowBody: THREE.Mesh;
  private shadowRotor: THREE.Mesh;
  private shadowMats: THREE.MeshBasicMaterial[] = [];
  private shadowT = Infinity;
  private shadowNext = 8;
  private shadowDir = 1;
  private spotAim = new THREE.Vector3();
  private time = 0;
  private nearBuf: (LampPos | null)[] = new Array(TUNING.look.lampLights).fill(null);
  private nearD: number[] = new Array(TUNING.look.lampLights).fill(Infinity);
  private tmp = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private scene: THREE.Scene) {
    scene.add(this.hemi, this.sun, this.spot, this.spot.target);
    for (let i = 0; i < TUNING.look.lampLights; i++) {
      const l = new THREE.PointLight(0xff9a48, 0, 26, 1.6);
      this.lamps.push(l);
      scene.add(l);
    }
    // One shared siren light at the convoy (per-pixel cost); each cruiser's own wash is a decal.
    const siren = new THREE.PointLight(0xff2030, 0, 32, 1.5);
    this.sirens.push(siren);
    scene.add(siren);

    // Visible spotlight beam: an open cone, bright at the ground, fading toward the chopper.
    const cone = new THREE.ConeGeometry(1, 1, 28, 1, true);
    cone.translate(0, -0.5, 0); // apex at the origin, base at y = −1
    const col: number[] = [];
    const p = cone.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = Math.min(1, -p.getY(i));
      col.push(k, k, k);
    }
    cone.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xcfdcff, vertexColors: true, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(cone, this.beamMat);
    this.beam.frustumCulled = false;
    const disc = new THREE.PlaneGeometry(1, 1);
    disc.rotateX(-Math.PI / 2);
    this.spotPool = new THREE.Mesh(disc, GLOW.spotPool);
    this.spotPool.renderOrder = 2;
    scene.add(this.beam, this.spotPool);

    // Chopper shadow: body + spinning rotor, normal blending, very faint.
    const mk = (tex: THREE.Texture) => {
      const m = new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
      this.shadowMats.push(m);
      return new THREE.Mesh(disc, m);
    };
    this.shadowBody = mk(chopperTexture());
    this.shadowBody.scale.set(9, 1, 9);
    this.shadowRotor = mk(rotorTexture());
    this.shadowRotor.scale.set(11, 1, 11);
    this.shadowRotor.position.y = 0.01;
    this.shadow.add(this.shadowBody, this.shadowRotor);
    this.shadow.position.y = 0.09;
    this.shadow.visible = false;
    scene.add(this.shadow);
    this.setMode('night');
  }

  setMode(mode: TimeOfDay) {
    this.mode = mode;
    const L = (this.look = LOOKS[mode]);
    this.scene.background = new THREE.Color(L.sky);
    this.scene.fog = new THREE.Fog(L.fog, L.fogNear, L.fogFar);
    this.hemi.color.setHex(L.hemiSky);
    this.hemi.groundColor.setHex(L.hemiGround);
    this.hemi.intensity = L.hemi;
    this.sun.color.setHex(L.sunColor);
    this.sun.intensity = L.sun;
    this.sun.position.set(...L.sunPos);
    RIM.strength.value = L.rim;
    setGlow(L.glow);
    setWindows(L.windows);
    this.windows = L.windows;
    this.beamMat.opacity = 0.035 * L.glow;
    this.beam.visible = L.glow > 0;
    for (const m of this.shadowMats) m.opacity = L.shadow;
  }

  update(dt: number, o: { giantX: number; giantZ: number; travel: number; speed: number; camera: THREE.Camera; lamps: LampPos[]; sirens: SirenSource[]; facing?: number }) {
    const L = this.look;
    const T = TUNING.look;
    this.time += dt;

    // Nearest lamps get the real lights (only lamps within reach matter).
    // Partial selection without allocating: the N nearest lamps.
    const best = this.nearBuf;
    best.fill(null);
    const bestD = this.nearD;
    bestD.fill(Infinity);
    for (const l of o.lamps) {
      const d = (l.x - o.giantX) ** 2 + (l.z - o.giantZ) ** 2;
      for (let k = 0; k < best.length; k++) {
        if (d < bestD[k]) {
          for (let j = best.length - 1; j > k; j--) {
            best[j] = best[j - 1];
            bestD[j] = bestD[j - 1];
          }
          best[k] = l;
          bestD[k] = d;
          break;
        }
      }
    }
    this.lamps.forEach((light, i) => {
      const n = best[i];
      light.intensity = n ? L.lamp : 0;
      if (n) light.position.set(n.x, n.y - 0.4, n.z);
    });

    // Chopper spotlight: from high and to the side of the camera (the chopper isn't the lens), aimed at the giant with lag and a little hand-held wander.
    const cam = o.camera.position;
    const fx = Math.cos(o.travel);
    const fz = Math.sin(o.travel);
    const sideX = -fz;
    const sideZ = fx;
    if ((o.facing ?? 1) > 0) {
      this.spot.position.set(cam.x + sideX * 16 - fx * 4, cam.y + 14, cam.z + sideZ * 16 - fz * 4);
    } else {
      // Head-On: backlight. The beam comes from beyond him (over the convoy), so the faces the
      // camera sees fall into shadow and he reads as a silhouette on the lit pool.
      this.spot.position.set(o.giantX - fx * 40 + sideX * 10, 45, o.giantZ - fz * 40 + sideZ * 10);
    }
    const w = T.spotWander;
    // Centre the pool just past him as the camera sees it (ahead when behind him, behind him head-on),
    // so on screen he is always a dark shape on the lit pool.
    const lead = (o.facing ?? 1) > 0 ? 0.6 + o.speed * 0.08 : -(1.5 + o.speed * 0.15);
    const aimX = o.giantX + fx * lead + Math.sin(this.time * 0.7) * w;
    const aimZ = o.giantZ + fz * lead + Math.sin(this.time * 0.53 + 1.7) * w;
    const k = 1 - Math.exp(-dt / T.spotLag);
    if (this.spotAim.lengthSq() === 0) this.spotAim.set(aimX, 0, aimZ);
    else this.spotAim.lerp(this.tmp.set(aimX, 0, aimZ), dt > 0 ? k : 1);
    this.spot.target.position.copy(this.spotAim);
    const dist = this.spot.position.distanceTo(this.spotAim);
    this.spot.angle = Math.atan((T.spotRadius * 1.25) / dist);
    this.spot.intensity = L.spot;
    this.spotPool.position.set(this.spotAim.x, 0.07, this.spotAim.z);
    this.spotPool.scale.set(T.spotRadius * 2.4, 1, T.spotRadius * 2.4);
    this.spotPool.visible = L.glow > 0;
    // Beam: apex at the chopper, base on the pool.
    const dir = this.tmp.copy(this.spot.position).sub(this.spotAim);
    const len = dir.length();
    this.beam.position.copy(this.spot.position);
    this.beam.quaternion.setFromUnitVectors(this.up, dir.divideScalar(len));
    this.beam.scale.set(T.spotRadius * 0.75, len, T.spotRadius * 0.75);

    // Siren washes: alternate red/blue per cruiser. Reduce Flashes: slow, soft alternation.
    const hz = this.reduceFlashes ? T.sirenHz * 0.35 : T.sirenHz;
    const active = o.sirens.filter((s) => s.active);
    const light = this.sirens[0];
    if (!active.length) light.intensity = 0;
    else {
      // Placed at the lead cruiser (nearest the giant), flashing with it; brighter with more cars behind.
      const lead = active.reduce((a, b) => ((a.x - o.giantX) ** 2 + (a.z - o.giantZ) ** 2 <= (b.x - o.giantX) ** 2 + (b.z - o.giantZ) ** 2 ? a : b));
      const ph = (this.time * hz + lead.phase) % 1;
      const red = ph < 0.5;
      light.color.setHex(red ? 0xff1a2a : 0x2a50ff);
      const pulse = this.reduceFlashes ? 0.75 + 0.25 * Math.cos(ph * Math.PI * 4) : 0.55 + 0.45 * Math.abs(Math.sin(ph * Math.PI * 2));
      light.intensity = L.siren * pulse * (red ? 1 : 1.3) * (1 + 0.25 * (active.length - 1));
      light.position.set(lead.x, 2.2, lead.z);
    }

    // Faint chopper shadow crossing the road now and then.
    this.shadowNext -= dt;
    if (this.shadowT === Infinity && this.shadowNext <= 0) {
      this.shadowT = 0;
      this.shadowDir = Math.random() < 0.5 ? -1 : 1;
      this.shadowNext = T.chopperShadowEvery[0] + Math.random() * (T.chopperShadowEvery[1] - T.chopperShadowEvery[0]);
    }
    if (this.shadowT !== Infinity) {
      const dur = 3.2;
      this.shadowT += dt;
      const u = this.shadowT / dur;
      if (u >= 1) {
        this.shadowT = Infinity;
        this.shadow.visible = false;
      } else {
        // Ahead of the giant, sweeping across the road while keeping pace.
        const ahead = 22 + o.speed * 0.8;
        const across = (u - 0.5) * 60 * this.shadowDir;
        this.shadow.visible = L.shadow > 0;
        this.shadow.position.x = o.giantX + fx * ahead + sideX * across;
        this.shadow.position.z = o.giantZ + fz * ahead + sideZ * across;
        this.shadow.rotation.y = -Math.atan2(sideZ * this.shadowDir, sideX * this.shadowDir) - Math.PI / 2;
        this.shadowRotor.rotation.y += dt * 40;
        const fade = Math.min(1, u * 6, (1 - u) * 6);
        for (const m of this.shadowMats) m.opacity = L.shadow * fade;
      }
    }
  }
}
