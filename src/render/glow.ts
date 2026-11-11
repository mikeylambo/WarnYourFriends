import * as THREE from 'three';

/**
 * Phase 0c night look: shared glow textures and materials (light pools on the
 * road, halos on lamps and car lights, siren washes). One material per look so
 * the whole world fades between night, dusk and day by changing one number.
 */

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial falloff, white on transparent (tinted by the material). */
export const radialTexture = (() => {
  let t: THREE.Texture | null = null;
  return () =>
    (t ??= canvasTexture(128, 128, (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.75)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.25)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }));
})();

/** Tight halo with a hot core, for lamp heads and car lights (a cheap bloom). */
export const haloTexture = (() => {
  let t: THREE.Texture | null = null;
  return () =>
    (t ??= canvasTexture(64, 64, (g) => {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.15, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.4, 'rgba(255,255,255,0.25)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }));
})();

/** Headlight throw on the road: a fan widening away from the car (texture +X = forward). */
export const beamTexture = (() => {
  let t: THREE.Texture | null = null;
  return () =>
    (t ??= canvasTexture(128, 64, (g) => {
      for (let x = 0; x < 128; x++) {
        const k = x / 127;
        const half = 6 + k * 26;
        const a = Math.pow(1 - k, 1.4) * 0.9;
        const grad = g.createLinearGradient(0, 32 - half, 0, 32 + half);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, `rgba(255,255,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(x, 32 - half, 1, half * 2);
      }
    }));
})();

/** Top-down chopper silhouette for its shadow (body, tail boom, skids). */
export const chopperTexture = (() => {
  let t: THREE.Texture | null = null;
  return () =>
    (t ??= canvasTexture(128, 128, (g) => {
      g.fillStyle = 'rgba(0,0,0,1)';
      g.beginPath();
      g.ellipse(64, 50, 13, 22, 0, 0, Math.PI * 2);
      g.fill();
      g.fillRect(61, 66, 6, 48);
      g.fillRect(52, 108, 24, 5);
      g.fillRect(44, 36, 3, 34);
      g.fillRect(81, 36, 3, 34);
    }));
})();

/** Two crossed rotor blades (spun at runtime). */
export const rotorTexture = (() => {
  let t: THREE.Texture | null = null;
  return () =>
    (t ??= canvasTexture(128, 128, (g) => {
      g.translate(64, 64);
      g.fillStyle = 'rgba(0,0,0,0.85)';
      for (let k = 0; k < 2; k++) {
        g.rotate(Math.PI / 2);
        g.fillRect(-62, -2.5, 124, 5);
      }
      g.beginPath();
      g.arc(0, 0, 62, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fill();
    }));
})();

const additive = (map: THREE.Texture, color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
const sprite = (color: number, opacity: number) =>
  new THREE.SpriteMaterial({ map: haloTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

/** Base opacities at full night; `setGlow(k)` scales them (night 1, dusk ~0.5, day 0). */
const BASE = new Map<THREE.Material, number>();
function reg<T extends THREE.Material>(m: T): T {
  BASE.set(m, m.opacity);
  return m;
}

export const GLOW = {
  lampPool: reg(additive(radialTexture(), 0xff9440, 0.42)),
  lampHalo: reg(sprite(0xffb060, 0.95)),
  headPool: reg(additive(beamTexture(), 0xfff0d0, 0.32)),
  headHalo: reg(sprite(0xfff4e0, 0.9)),
  tailHalo: reg(sprite(0xff2020, 0.55)),
  brakeHalo: reg(sprite(0xff3030, 1.0)),
  hazardHalo: reg(sprite(0xffa020, 0.95)),
  sirenRed: reg(additive(radialTexture(), 0xff1a2a, 0.2)),
  sirenBlue: reg(additive(radialTexture(), 0x2a5cff, 0.26)),
  sirenRedHalo: reg(sprite(0xff2030, 1.0)),
  sirenBlueHalo: reg(sprite(0x3060ff, 1.0)),
  spotPool: reg(additive(radialTexture(), 0xdfe8ff, 0.12)),
};

/** Siren halos stay visible by day (they're light bars), just smaller. */
const DAY_FLOOR = new Map<THREE.Material, number>([
  [GLOW.sirenRedHalo, 0.7],
  [GLOW.sirenBlueHalo, 0.7],
  [GLOW.brakeHalo, 0.6],
  [GLOW.hazardHalo, 0.6],
  [GLOW.tailHalo, 0.25],
]);

export function setGlow(k: number) {
  for (const [m, base] of BASE) {
    const floor = DAY_FLOOR.get(m) ?? 0;
    m.opacity = base * Math.max(k, floor);
    m.visible = m.opacity > 0.001;
  }
}
