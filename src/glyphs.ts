import { gamepadFamily, type InputDeviceFamily, type InputGlyph, type InputGlyphRegistry } from '@slu/web-shell';

/**
 * Button labels per input family, in the shell's glyph registry. A PlayStation pad
 * (DualShock 4 / DualSense) shows L1/R1/L2/✕; Xbox and unknown pads show LB/RB/LT/A.
 * The pad's family comes from its id (the shell's own detector), checked whenever
 * a pad is the active device.
 */
export type GlyphAction = 'lanes' | 'brake' | 'shoulder' | 'ability' | 'pause' | 'accept' | 'move';

const TABLE: Record<GlyphAction, Partial<Record<InputDeviceFamily, string>>> = {
  lanes: { 'keyboard-mouse': 'A / D', xbox: '◀ ▶', playstation: '◀ ▶', nintendo: '◀ ▶', 'generic-gamepad': '◀ ▶', touch: 'Swipe' },
  brake: { 'keyboard-mouse': 'Space', xbox: 'LT', playstation: 'L2', nintendo: 'ZL', 'generic-gamepad': 'LT', touch: 'Swipe ▼ hold' },
  shoulder: { 'keyboard-mouse': 'Shift', xbox: 'RB', playstation: 'R1', nintendo: 'R', 'generic-gamepad': 'RB', touch: 'Tap ●' },
  ability: { 'keyboard-mouse': 'E', xbox: 'LB', playstation: 'L1', nintendo: 'L', 'generic-gamepad': 'LB', touch: '' },
  pause: { 'keyboard-mouse': 'Esc', xbox: 'Menu', playstation: 'Options', nintendo: '+', 'generic-gamepad': 'Start', touch: 'II' },
  accept: { 'keyboard-mouse': 'Enter', xbox: 'A', playstation: '✕', nintendo: 'B', 'generic-gamepad': 'A', touch: 'Tap' },
  move: { 'keyboard-mouse': '← →', xbox: '◀ ▶', playstation: '◀ ▶', nintendo: '◀ ▶', 'generic-gamepad': '◀ ▶', touch: '' },
};

export function registerGlyphs(registry: InputGlyphRegistry) {
  const glyphs: InputGlyph[] = [];
  for (const [action, byFamily] of Object.entries(TABLE)) {
    for (const [family, label] of Object.entries(byFamily)) glyphs.push({ action, family: family as InputDeviceFamily, label });
  }
  registry.register(glyphs);
}

/** Family of a pad from its id string ("DUALSHOCK 4 Wireless Controller", "054c-09cc-…" on Firefox). */
export function padFamily(id: string): InputDeviceFamily {
  const f = gamepadFamily(id);
  if (f !== 'generic-gamepad') return f;
  // Firefox/Linux report vendor-product hex: Sony is 054c.
  return /(^|\D)054c(\D|$)/i.test(id) ? 'playstation' : /(^|\D)045e(\D|$)/i.test(id) ? 'xbox' : f;
}
