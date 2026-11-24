import * as THREE from 'three';

/**
 * Ground textures (art pass, 2026-11-24): asphalt, grass verge, paving. Each is drawn in code (no assets, no
 * credits) unless a painted one is dropped in at `src/assets/tex/<name>.webp` (or .png / .jpg): then that wins, no
 * code change. Textures are near-white greys that multiply the palette colour, so every look (night/dusk/day) and
 * the toon ramp still own the colour. Tiling: one tile covers `TILE[name]` metres.
 */
export type GroundTex = 'asphalt' | 'verge' | 'paving';
export const TILE: Record<GroundTex, number> = { asphalt: 8, verge: 10, paving: 4 };

const painted = import.meta.glob('../assets/tex/*.{webp,png,jpg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const cache = new Map<GroundTex, THREE.Texture>();

/** Seeded noise for the code-drawn tiles (cosmetic; the same every load). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw(name: GroundTex, g: CanvasRenderingContext2D, S: number) {
  const r = rng(name.length * 977);
  const speck = (n: number, lo: number, hi: number, size: [number, number]) => {
    for (let i = 0; i < n; i++) {
      const v = Math.round(lo + r() * (hi - lo));
      g.fillStyle = `rgb(${v},${v},${v})`;
      const s = size[0] + r() * (size[1] - size[0]);
      g.fillRect(r() * S, r() * S, s, s);
    }
  };
  if (name === 'asphalt') {
    g.fillStyle = 'rgb(236,236,236)';
    g.fillRect(0, 0, S, S);
    speck(4000, 218, 255, [1, 2]);
    // Patches: a slightly different pour, square-cut, the road's history.
    for (let i = 0; i < 1; i++) {
      g.fillStyle = `rgba(200,200,200,${0.12 + r() * 0.08})`;
      g.fillRect(r() * S * 0.8, r() * S * 0.8, S * (0.12 + r() * 0.2), S * (0.08 + r() * 0.15));
    }
    // Hairline cracks (dark, thin, wandering): read as texture from the chopper, never as lane marks.
    g.strokeStyle = 'rgba(140,140,140,0.35)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      let x = r() * S;
      let y = r() * S;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        x += (r() - 0.5) * S * 0.12;
        y += r() * S * 0.08;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  } else if (name === 'verge') {
    g.fillStyle = 'rgb(232,232,232)';
    g.fillRect(0, 0, S, S);
    // Clumps of grass: soft blotches and blades, toon-flat.
    for (let i = 0; i < 90; i++) {
      const v = Math.round(210 + r() * 40);
      g.fillStyle = `rgba(${v},${v},${v},0.3)`;
      g.beginPath();
      g.ellipse(r() * S, r() * S, 6 + r() * 18, 4 + r() * 10, r() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    speck(900, 205, 255, [1, 2]);
  } else {
    // Paving: square slabs with dark joints, a few cracked or stained.
    g.fillStyle = 'rgb(240,240,240)';
    g.fillRect(0, 0, S, S);
    const n = 4;
    const c = S / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const v = Math.round(215 + r() * 35);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(i * c + 2, j * c + 2, c - 4, c - 4);
      }
    g.strokeStyle = 'rgb(150,150,150)';
    g.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      g.beginPath();
      g.moveTo(i * c, 0);
      g.lineTo(i * c, S);
      g.moveTo(0, i * c);
      g.lineTo(S, i * c);
      g.stroke();
    }
    speck(800, 190, 250, [1, 2]);
  }
}

export function groundTexture(name: GroundTex): THREE.Texture {
  const hit = cache.get(name);
  if (hit) return hit;
  let tex: THREE.Texture;
  const file = Object.keys(painted).find((k) => k.split('/').pop()!.split('.')[0] === name);
  if (file) tex = new THREE.TextureLoader().load(painted[file]);
  else {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    draw(name, c.getContext('2d')!, S);
    tex = new THREE.CanvasTexture(c);
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(name, tex);
  return tex;
}
