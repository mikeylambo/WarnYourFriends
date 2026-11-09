export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

/** Wrap an angle to (-PI, PI]. */
export function wrap(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Signed shortest difference b - a. */
export function angleDiff(a: number, b: number): number {
  return wrap(b - a);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach factor. */
export function approach(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}
