import { TUNING } from './tuning';
import type { SimInput } from './sim/types';

export type Device = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

/**
 * v0.3 controls, folded into one SimInput per tick.
 *   Lane left/right: A/D, ←/→ · stick flick or d-pad · swipe left/right
 *   Brake:           S / Space · LT · swipe down and hold
 *   Shoulder Check:  Shift / W / LMB · RB · tap the right button
 *   Ability (§17):   E / Q · LB or Y · the ability button
 *   Pause:           Esc · Start · II
 * Lane presses are edges; the sim buffers (5f) and queues (one max) them.
 */
export class Input {
  device: Device = 'keyboard';
  private keys = new Set<string>();
  private laneEdge = 0;
  private shoulderEdge = false;
  private abilityEdge = false;
  private pauseEdge = false;
  private touch: { id: number; sx: number; sy: number; x: number; y: number; t0: number; fired: boolean } | null = null;
  private pad = { flickArmed: true, left: false, right: false, rb: false, lb: false, start: false, brake: false };
  onPadDisconnect: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;

  constructor(el: HTMLElement, shoulderBtn: HTMLElement, pauseBtn: HTMLElement, abilityBtn: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') this.laneEdge = -1;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') this.laneEdge = 1;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyW') this.shoulderEdge = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pauseEdge = true;
      if (e.code === 'KeyE' || e.code === 'KeyQ') this.abilityEdge = true;
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
      if (!s.fired && fast && Math.abs(dx) >= I.swipeMinPx && Math.abs(dx) > Math.abs(dy) * 1.2) {
        this.laneEdge = Math.sign(dx);
        s.fired = true;
        // A new swipe can start from here without lifting the thumb.
        s.sx = s.x;
        s.sy = s.y;
        s.t0 = performance.now();
        s.fired = false;
      }
    }
  }

  private onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) if (this.touch && t.identifier === this.touch.id) this.touch = null;
  }

  /** Swipe-down-and-hold brake is active. */
  private get touchBrake(): boolean {
    const s = this.touch;
    if (!s) return false;
    const dx = s.x - s.sx;
    const dy = s.y - s.sy;
    return dy >= TUNING.input.swipeDownBrakePx && dy > Math.abs(dx);
  }

  get touchState() {
    return this.touch ? { ...this.touch, braking: this.touchBrake } : null;
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
    const lb = pressed(4) || pressed(3);
    if (lb && !P.lb) this.abilityEdge = true;
    P.lb = lb;
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
    P.brake = (gp.buttons[6]?.value ?? 0) > 0.3;
    if (Math.abs(lx) > 0.3 || P.brake || rb || lb || left || right) {
      this.device = 'gamepad';
      this.onAnyInput?.();
    }
  }

  sample(): SimInput {
    this.pollPad();
    const brake = this.keys.has('Space') || this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.pad.brake || this.touchBrake;
    const lane = this.laneEdge;
    const shoulder = this.shoulderEdge;
    const ability = this.abilityEdge;
    this.laneEdge = 0;
    this.shoulderEdge = false;
    this.abilityEdge = false;
    return { lane, brake, shoulder, ability };
  }
}
