import type { SimInput } from './sim/types';

export type Device = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

/**
 * §8 controls across KBM, gamepad and touch, folded into one SimInput per tick.
 * Steering: A/D rotate (relative), or absolute direction from mouse, left stick
 * or a left-half touch drag. Brake: Space / LT / hold left thumb still 0.15s.
 * Shoulder Check: Shift / LMB / RB / right button. Pause: Esc / Start / icon.
 */
export class Input {
  device: Device = 'keyboard';
  private keys = new Set<string>();
  private shoulderEdge = false;
  private pauseEdge = false;
  private mouse = { x: 0, y: 0, active: false, lastMove: 0 };
  private touch: { id: number; sx: number; sy: number; x: number; y: number; still: number; lastX: number; lastY: number } | null = null;
  private padPrev = { rb: false, start: false };
  private padConnected = false;
  onPadDisconnect: (() => void) | null = null;
  onAnyInput: (() => void) | null = null;
  /** Screen position of the giant (CSS px), for mouse-direction steering. */
  giantScreen = { x: 0, y: 0 };

  constructor(el: HTMLElement, shoulderBtn: HTMLElement, pauseBtn: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.shoulderEdge = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pauseEdge = true;
      if (e.code === 'KeyA' || e.code === 'KeyD' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        this.mouse.active = false;
      }
      if (e.code === 'Space') e.preventDefault();
      this.device = 'keyboard';
      this.onAnyInput?.();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.mouse.x;
      const dy = e.clientY - this.mouse.y;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      if (Math.hypot(dx, dy) > 2) {
        this.mouse.active = true;
        this.device = 'mouse';
      }
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.shoulderEdge = true;
      }
      this.onAnyInput?.();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouchEnd(e));
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
    shoulderBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.shoulderEdge = true;
      this.device = 'touch';
      this.onAnyInput?.();
    }, { passive: false });
    pauseBtn.addEventListener('click', () => (this.pauseEdge = true));

    window.addEventListener('gamepaddisconnected', () => {
      this.padConnected = false;
      this.onPadDisconnect?.(); // §8 controller disconnect auto-pauses
    });
  }

  private onTouchStart(e: TouchEvent) {
    e.preventDefault();
    this.device = 'touch';
    this.onAnyInput?.();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth / 2 && !this.touch) {
        this.touch = { id: t.identifier, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, still: 0, lastX: t.clientX, lastY: t.clientY };
      }
    }
  }
  private onTouchMove(e: TouchEvent) {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.touch && t.identifier === this.touch.id) {
        this.touch.x = t.clientX;
        this.touch.y = t.clientY;
      }
    }
  }
  private onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (this.touch && t.identifier === this.touch.id) this.touch = null;
    }
  }

  /** Virtual stick state for the touch overlay. */
  get touchStick() {
    return this.touch;
  }

  consumePause(): boolean {
    const p = this.pauseEdge;
    this.pauseEdge = false;
    this.pollPad(true);
    const p2 = this.pauseEdge;
    this.pauseEdge = false;
    return p || p2;
  }

  private pad: { aim: number | null; brake: boolean } = { aim: null, brake: false };

  private pollPad(pauseOnly = false) {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) {
      this.pad = { aim: null, brake: false };
      return;
    }
    this.padConnected = true;
    const start = !!gp.buttons[9]?.pressed;
    if (start && !this.padPrev.start) this.pauseEdge = true;
    this.padPrev.start = start;
    if (pauseOnly) return;
    const rb = !!gp.buttons[5]?.pressed;
    if (rb && !this.padPrev.rb) this.shoulderEdge = true;
    this.padPrev.rb = rb;
    const lx = gp.axes[0] ?? 0;
    const ly = gp.axes[1] ?? 0;
    const mag = Math.hypot(lx, ly);
    const lt = (gp.buttons[6]?.value ?? 0) > 0.3;
    // Screen up is world -Z, screen right is +X: stick maps straight onto (x, z).
    this.pad = { aim: mag > 0.3 ? Math.atan2(ly, lx) : null, brake: lt };
    if (mag > 0.3 || lt || rb) {
      this.device = 'gamepad';
      this.onAnyInput?.();
    }
  }

  get gamepadConnected() {
    return this.padConnected;
  }

  /** Build this tick's input. dt is the sim tick length. */
  sample(dt: number): SimInput {
    this.pollPad();
    let turn = 0;
    let aim: number | null = null;
    let brake = false;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) turn -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) turn += 1;
    if (this.keys.has('Space')) brake = true;

    if (this.mouse.active && turn === 0) {
      const dx = this.mouse.x - this.giantScreen.x;
      const dy = this.mouse.y - this.giantScreen.y;
      // Dead zone around the giant so a resting cursor doesn't jitter the heading.
      if (Math.hypot(dx, dy) > 40) aim = Math.atan2(dy, dx);
    }

    if (this.pad.aim !== null) aim = this.pad.aim;
    if (this.pad.brake) brake = true;

    if (this.touch) {
      const t = this.touch;
      const dx = t.x - t.sx;
      const dy = t.y - t.sy;
      if (Math.hypot(dx, dy) > 14) {
        aim = Math.atan2(dy, dx);
        t.still = 0;
      } else {
        // §46 working default: hold the thumb still for 0.15s to brake.
        t.still += dt;
        if (t.still >= 0.15) brake = true;
      }
    }

    const shoulder = this.shoulderEdge;
    this.shoulderEdge = false;
    return { turn, aim, brake, shoulder };
  }
}
