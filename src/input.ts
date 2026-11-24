import { TUNING } from './tuning';
import type { SimInput } from './sim/types';

export type Device = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

/** Keyboard actions the player can rebind (Settings → Controls). Pause stays on Esc / P. */
export type KeyAction = 'left' | 'right' | 'brake' | 'shoulder' | 'ability' | 'ability2';
export const KEY_ACTIONS: KeyAction[] = ['left', 'right', 'brake', 'shoulder', 'ability', 'ability2'];
/** Default keys per action (the first is the one shown on screen). */
export const DEFAULT_KEYS: Record<KeyAction, string[]> = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  brake: ['Space', 'KeyS', 'ArrowDown'],
  shoulder: ['ShiftLeft', 'ShiftRight', 'KeyW'],
  ability: ['KeyE'],
  /** Abilities stack (2026-11-17): the second slot. */
  ability2: ['KeyQ'],
};
/** Keys that can't be bound (pause and menu keys). */
export const RESERVED_KEYS = ['Escape', 'KeyP', 'Enter', 'Tab'];

/** A key code as a short label ("KeyJ" → "J", "ArrowLeft" → "←", "ShiftLeft" → "Shift"). */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const arrows: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  if (arrows[code]) return arrows[code];
  return code.replace(/(Left|Right)$/, '').replace('Control', 'Ctrl').replace('Bracket', '').replace('Semicolon', ';').replace('Quote', "'").replace('Comma', ',').replace('Period', '.').replace('Slash', '/');
}

/**
 * v0.3 controls, folded into one SimInput per tick.
 *   Lane left/right: A/D, ←/→ · stick flick or d-pad · swipe left/right
 *   Brake:           S / Space · LT (L2) · swipe down and hold
 *   Rampage (was Shoulder Check):  Shift / W / LMB · RB (R1) · tap the right button
 *   Ability (§17):   E / Q · LB or Y (L1 or △) · the ability button
 *   Pause:           Esc · Start (Options) · II
 * Labels on screen follow the pad's family: src/glyphs.ts.
 * Lane presses are edges; the sim buffers (5f) and queues (one max) them.
 */
export class Input {
  device: Device = 'keyboard';
  /** id of the pad last used (for its button labels). */
  padId = '';
  private keys = new Set<string>();
  /** Effective keys per action: the defaults, or the player's one key per action (Settings → Controls). */
  keymap: Record<KeyAction, string[]> = { ...DEFAULT_KEYS };
  /** Accessibility: Brake toggles on a press instead of holding (keyboard, pad, swipe). */
  brakeToggle = false;
  /** Tap the left / right half of the screen for a lane (instead of swiping). */
  tapZones = false;
  private brakeLatch = false;
  /** Toggle mode with the brake latched on (the HUD shows BRAKE ON). */
  get brakeLatched(): boolean {
    return this.brakeToggle && this.brakeLatch;
  }
  /** While rebinding a key, gameplay input is ignored. */
  capturing = false;
  private laneEdge = 0;
  private shoulderEdge = false;
  private abilityEdge = false;
  private ability2Edge = false;
  private pauseEdge = false;
  private touch: { id: number; sx: number; sy: number; x: number; y: number; t0: number; fired: boolean; lastDir?: number } | null = null;
  private pad = { flickArmed: true, left: false, right: false, rb: false, lb: false, y: false, start: false, brake: false, cam: false };
  /** Next camera angle (Mike, 2026-11-24: C on keyboard, D-pad up or R3 on a pad, the camera button on touch). */
  private cameraEdge = false;
  onPadDisconnect: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  constructor(el: HTMLElement, shoulderBtn: HTMLElement, pauseBtn: HTMLElement, abilityBtn: HTMLElement, ability2Btn?: HTMLElement | null) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || this.capturing) return;
      this.keys.add(e.code);
      const K = this.keymap;
      if (K.left.includes(e.code)) this.laneEdge = -1;
      if (K.right.includes(e.code)) this.laneEdge = 1;
      if (K.shoulder.includes(e.code)) this.shoulderEdge = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pauseEdge = true;
      if (K.ability.includes(e.code)) this.abilityEdge = true;
      if (K.ability2.includes(e.code)) this.ability2Edge = true;
      if (K.brake.includes(e.code)) this.toggleBrake();
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.device = 'keyboard';
      this.onAnyInput?.();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.shoulderEdge = true;
      this.device = 'mouse';
      this.onAnyInput?.();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouchEnd(e));
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
    shoulderBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.shoulderEdge = true;
        this.device = 'touch';
        this.onAnyInput?.();
      },
      { passive: false },
    );
    abilityBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.abilityEdge = true;
        this.device = 'touch';
        this.onAnyInput?.();
      },
      { passive: false },
    );
    ability2Btn?.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.ability2Edge = true;
        this.device = 'touch';
        this.onAnyInput?.();
      },
      { passive: false },
    );
    pauseBtn.addEventListener('click', () => (this.pauseEdge = true));
    window.addEventListener('gamepaddisconnected', () => this.onPadDisconnect?.()); // §8 auto-pause
  }

  private onTouchStart(e: TouchEvent) {
    e.preventDefault();
    this.device = 'touch';
    this.onAnyInput?.();
    if (this.touch) return;
    const t = e.changedTouches[0];
    this.touch = { id: t.identifier, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, t0: performance.now(), fired: false };
    if (this.tapZones) {
      // One lane per tap, on touch-down (fastest); the touch then can't also fire as a swipe.
      this.laneEdge = t.clientX < window.innerWidth / 2 ? -1 : 1;
      this.touch.fired = true;
    }
  }

  private onTouchMove(e: TouchEvent) {
    e.preventDefault();
    const I = TUNING.input;
    for (const t of Array.from(e.changedTouches)) {
      const s = this.touch;
      if (!s || t.identifier !== s.id) continue;
      s.x = t.clientX;
      s.y = t.clientY;
      // Fire a lane swipe as soon as it's unambiguous, not on release: faster to act.
      const dx = s.x - s.sx;
      const dy = s.y - s.sy;
      const fast = (performance.now() - s.t0) / 1000 <= I.swipeMaxTime;
      const dir = Math.sign(dx);
      // One swipe = one lane (Mike, 2026-11-24: a single flick moved two). Without lifting the thumb, only a
      // reversal can fire again; the same direction needs a fresh touch.
      if (!this.tapZones && fast && dir !== s.lastDir && Math.abs(dx) >= I.swipeMinPx && Math.abs(dx) > Math.abs(dy) * 1.2) {
        this.laneEdge = dir;
        s.lastDir = dir;
        s.sx = s.x;
        s.sy = s.y;
        s.t0 = performance.now();
      } else if (s.lastDir && dir === s.lastDir) {
        // Keep the origin under the thumb while it carries on the same way, so a reversal is measured from the turn.
        s.sx = s.x;
        s.sy = s.y;
        s.t0 = performance.now();
      }
    }
  }

  private onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) if (this.touch && t.identifier === this.touch.id) {
      this.touch = null;
      this.touchToggled = false;
    }
  }

  /** Swipe-down-and-hold brake is active. */
  private get touchBrake(): boolean {
    const s = this.touch;
    if (!s) return false;
    const dx = s.x - s.sx;
    const dy = s.y - s.sy;
    const down = dy >= TUNING.input.swipeDownBrakePx && dy > Math.abs(dx);
    // Brake toggle: a swipe down flips it once per touch.
    if (down && this.brakeToggle && !this.touchToggled) {
      this.touchToggled = true;
      this.toggleBrake();
    }
    return down;
  }
  private touchToggled = false;

  /** A brake press in toggle mode flips the latch (hold mode ignores it). */
  private toggleBrake() {
    if (this.brakeToggle) this.brakeLatch = !this.brakeLatch;
  }

  /** A new broadcast: no brake left latched on from the last one. */
  resetLatches() {
    this.brakeLatch = false;
  }

  get touchState() {
    return this.touch ? { ...this.touch, braking: this.touchBrake } : null;
  }

  consumeCamera(): boolean {
    this.pollPad();
    const c = this.cameraEdge;
    this.cameraEdge = false;
    return c;
  }
  /** Keyboard C and the touch camera button. */
  pressCamera() {
    this.cameraEdge = true;
  }

  consumePause(): boolean {
    this.pollPad();
    const p = this.pauseEdge;
    this.pauseEdge = false;
    return p;
  }

  private pollPad() {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) {
      this.pad.brake = false;
      return;
    }
    const I = TUNING.input;
    const P = this.pad;
    const pressed = (i: number) => !!gp!.buttons[i]?.pressed;
    const start = pressed(9);
    if (start && !P.start) this.pauseEdge = true;
    P.start = start;
    const rb = pressed(5);
    if (rb && !P.rb) this.shoulderEdge = true;
    P.rb = rb;
    const lb = pressed(4);
    if (lb && !P.lb) this.abilityEdge = true;
    P.lb = lb;
    // The second ability slot: Y (Triangle).
    const y = pressed(3);
    if (y && !P.y) this.ability2Edge = true;
    P.y = y;
    const cam = pressed(12) || pressed(11);
    if (cam && !P.cam) this.cameraEdge = true;
    P.cam = cam;
    // Stick flick: one lane per flick; re-arms when the stick comes back.
    const lx = gp.axes[0] ?? 0;
    if (P.flickArmed && Math.abs(lx) >= I.flickThreshold) {
      this.laneEdge = Math.sign(lx);
      P.flickArmed = false;
    } else if (!P.flickArmed && Math.abs(lx) <= I.flickRelease) {
      P.flickArmed = true;
    }
    const left = pressed(14);
    const right = pressed(15);
    if (left && !P.left) this.laneEdge = -1;
    if (right && !P.right) this.laneEdge = 1;
    P.left = left;
    P.right = right;
    const padBrake = (gp.buttons[6]?.value ?? 0) > 0.3;
    if (padBrake && !P.brake) this.toggleBrake();
    P.brake = padBrake;
    if (Math.abs(lx) > 0.3 || P.brake || rb || lb || left || right || gp.buttons.some((b) => b.pressed)) {
      this.device = 'gamepad';
      this.padId = gp.id;
      this.onAnyInput?.();
    }
  }

  sample(): SimInput {
    this.pollPad();
    const held = this.keymap.brake.some((k) => this.keys.has(k)) || this.pad.brake || this.touchBrake;
    const brake = this.capturing || (TUNING.proto.on && TUNING.proto.noBrake) ? false : this.brakeToggle ? this.brakeLatch : held;
    if (this.capturing) this.laneEdge = 0;
    const lane = this.laneEdge;
    const shoulder = this.shoulderEdge;
    const ability = this.abilityEdge;
    const ability2 = this.ability2Edge;
    this.laneEdge = 0;
    this.shoulderEdge = false;
    this.abilityEdge = false;
    this.ability2Edge = false;
    return { lane, brake, shoulder, ability, ...(ability2 ? { ability2 } : {}) };
  }
}
