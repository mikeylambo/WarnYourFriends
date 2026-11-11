import * as THREE from 'three';

/**
 * Phase 0c silhouette test: is the giant readable as a shape against what's
 * behind him? Renders the frame as the player sees it, then a mask of the giant
 * alone, and compares the giant's pixels with a ring of background just outside
 * his outline. Reads the default framebuffer right after rendering, so it
 * measures the sRGB pixels on screen (fog, glow, rim and all).
 *
 * Thresholds (set before measuring, reported with the numbers):
 *  - heightPx ≥ 48 at a 720-line frame (§13: "identifiable as a silhouette at 48px tall")
 *  - contrast ≥ 3:1 between the giant's median and the surround's median luminance
 *    (WCAG 1.4.11 non-text contrast)
 *  - ≥ 60% of outline pixel pairs differ by ≥ 0.12 in luma (the edge reads all the way round)
 */
export interface SilhouetteResult {
  heightPx: number;
  giantLuma: number;
  surroundLuma: number;
  contrast: number;
  edgeShare: number;
  /** 'dark-on-light' when the giant is darker than his surround (the §23 value rule). */
  polarity: 'dark-on-light' | 'light-on-dark';
  pass: boolean;
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function measureSilhouette(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, giant: THREE.Object3D[]): SilhouetteResult {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const frame = new Uint8Array(w * h * 4);
  const mask = new Uint8Array(w * h * 4);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, frame);

  // Mask pass: only the giant, flat white on black, no fog.
  const keep = new Set<THREE.Object3D>(giant);
  const hidden: THREE.Object3D[] = [];
  for (const o of scene.children) if (!keep.has(o) && o.visible) {
    o.visible = false;
    hidden.push(o);
  }
  const bg = scene.background;
  const fog = scene.fog;
  const over = scene.overrideMaterial;
  scene.background = new THREE.Color(0x000000);
  scene.fog = null;
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  renderer.render(scene, camera);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, mask);
  (scene.overrideMaterial as THREE.Material).dispose();
  scene.overrideMaterial = over;
  scene.background = bg;
  scene.fog = fog;
  for (const o of hidden) o.visible = true;
  renderer.render(scene, camera);

  const inGiant = (i: number) => mask[i * 4] > 128;
  const luma = (i: number) => (0.2126 * frame[i * 4] + 0.7152 * frame[i * 4 + 1] + 0.0722 * frame[i * 4 + 2]) / 255;
  const relLum = (i: number) => 0.2126 * lin(frame[i * 4] / 255) + 0.7152 * lin(frame[i * 4 + 1] / 255) + 0.0722 * lin(frame[i * 4 + 2] / 255);

  let minY = h;
  let maxY = -1;
  let minX = w;
  let maxX = -1;
  const g: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inGiant(i)) continue;
      g.push(relLum(i));
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  if (!g.length) return { heightPx: 0, giantLuma: 0, surroundLuma: 0, contrast: 1, edgeShare: 0, polarity: 'light-on-dark', pass: false };

  // Surround: background pixels within r px of the outline (r scales with the frame).
  const r = Math.max(3, Math.round(h / 120));
  const ring: number[] = [];
  let edges = 0;
  let strong = 0;
  for (let y = Math.max(0, minY - r); y <= Math.min(h - 1, maxY + r); y++)
    for (let x = Math.max(0, minX - r); x <= Math.min(w - 1, maxX + r); x++) {
      const i = y * w + x;
      if (inGiant(i)) {
        // Outline pairs: giant pixel vs the background pixel 2px further out, 4 directions.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x1 = x + dx;
          const y1 = y + dy;
          if (x1 < 0 || y1 < 0 || x1 >= w || y1 >= h || inGiant(y1 * w + x1)) continue;
          const x2 = Math.min(w - 1, Math.max(0, x + dx * 3));
          const y2 = Math.min(h - 1, Math.max(0, y + dy * 3));
          if (inGiant(y2 * w + x2)) continue;
          edges++;
          if (Math.abs(luma(i) - luma(y2 * w + x2)) >= 0.12) strong++;
        }
        continue;
      }
      let near = false;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r) && !near; yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++)
          if (inGiant(yy * w + xx)) {
            near = true;
            break;
          }
      if (near) ring.push(relLum(i));
    }
  const median = (a: number[]) => {
    const s = a.slice().sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const gl_ = median(g);
  const bl = median(ring);
  const contrast = (Math.max(gl_, bl) + 0.05) / (Math.min(gl_, bl) + 0.05);
  const heightPx = ((maxY - minY + 1) * 720) / h;
  const edgeShare = edges ? strong / edges : 0;
  return { heightPx, giantLuma: gl_, surroundLuma: bl, contrast, edgeShare, polarity: gl_ < bl ? 'dark-on-light' : 'light-on-dark', pass: heightPx >= 48 && contrast >= 3 && edgeShare >= 0.6 };
}
