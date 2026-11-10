import * as THREE from 'three';

/** §23 rendering recipe: flat toon shading on a 2-band ramp. */
let ramp: THREE.DataTexture | null = null;
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const data = new Uint8Array([150, 150, 150, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(data, 2, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

const cache = new Map<string, THREE.MeshToonMaterial>();
export function toon(color: number, extra: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  const key = `${color}:${JSON.stringify(extra)}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...extra })));
  return m;
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round shadow blob (§23 "soft shadow blobs"). */
let blob: THREE.Texture | null = null;
export function blobTexture(): THREE.Texture {
  return (blob ??= canvasTexture(64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }));
}

/** Ground-crack decal for Rampage footfalls (v0.3). Drawn once, procedurally. */
let crack: THREE.Texture | null = null;
export function crackTexture(): THREE.Texture {
  return (crack ??= canvasTexture(128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(30,26,36,0.85)';
    g.lineCap = 'round';
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 7; k++) {
      let x = 64;
      let y = 64;
      let a = (k / 7) * Math.PI * 2 + rnd() * 0.6;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(x, y);
      for (let i = 0; i < 6; i++) {
        a += (rnd() - 0.5) * 0.9;
        const len = 6 + rnd() * 6;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        g.lineTo(x, y);
        g.lineWidth = Math.max(1, 4 - i * 0.6);
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(30,26,36,0.5)';
    g.beginPath();
    g.arc(64, 64, 9, 0, Math.PI * 2);
    g.fill();
  }));
}
