import { TUNING } from './tuning';

/**
 * Phase 0 feel-check aid: live sliders over the numbers that decide the run's
 * feel. Toggle with T (or ?tune=1). Overrides persist in localStorage for this
 * browser only; "Copy" puts the changed values on the clipboard so they can be
 * written back into tuning.ts (the source of truth, §30).
 */

type Num = Record<string, number>;

interface Knob {
  label: string;
  obj: () => Num;
  key: string;
  min: number;
  max: number;
  step: number;
  path: string;
}

const tier = (i: number) => () => TUNING.tiers[i] as unknown as Num;
const cam = () => TUNING.camera as unknown as Num;

const KNOBS: Knob[] = [];
TUNING.tiers.forEach((t, i) => {
  const p = `tiers[${i}]`;
  KNOBS.push(
    { label: `${t.name} top speed`, obj: tier(i), key: 'topSpeed', min: 3, max: 25, step: 0.5, path: p },
    { label: `${t.name} accel`, obj: tier(i), key: 'accel', min: 1, max: 20, step: 0.5, path: p },
    { label: `${t.name} turn °/s`, obj: tier(i), key: 'turnRateDeg', min: 30, max: 360, step: 5, path: p },
    { label: `${t.name} grip`, obj: tier(i), key: 'grip', min: 1, max: 30, step: 0.5, path: p },
    { label: `${t.name} turn lag s`, obj: tier(i), key: 'turnLag', min: 0, max: 0.4, step: 0.01, path: p },
    { label: `${t.name} cam height`, obj: tier(i), key: 'cameraHeight', min: 15, max: 90, step: 1, path: p },
  );
  if (Number.isFinite(t.tierUpAfter)) KNOBS.push({ label: `${t.name} tier-up s`, obj: tier(i), key: 'tierUpAfter', min: 0.5, max: 8, step: 0.25, path: p });
});
KNOBS.push(
  { label: 'Camera lead m', obj: cam, key: 'lead', min: 0, max: 20, step: 0.5, path: 'camera' },
  { label: 'Camera lag s', obj: cam, key: 'lag', min: 0, max: 1, step: 0.05, path: 'camera' },
  { label: 'Camera FOV', obj: cam, key: 'fov', min: 20, max: 70, step: 1, path: 'camera' },
  { label: 'Bounce speed kept', obj: () => TUNING.collision as unknown as Num, key: 'bounceSpeedKeep', min: 0.2, max: 1, step: 0.05, path: 'collision' },
  { label: 'Brake decel', obj: () => TUNING.brake as unknown as Num, key: 'decel', min: 4, max: 30, step: 1, path: 'brake' },
);

const STORE = 'wyf.tune.v1';
const defaults = new Map<Knob, number>(KNOBS.map((k) => [k, k.obj()[k.key]]));
const id = (k: Knob) => `${k.path}.${k.key}`;

/** Apply stored overrides. Call before the sim is built. */
export function applyStoredTuning() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const k of KNOBS) {
      const v = saved[id(k)];
      if (typeof v === 'number' && Number.isFinite(v)) k.obj()[k.key] = v;
    }
  } catch {
    /* ignore corrupt overrides */
  }
}

function changed(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KNOBS) if (k.obj()[k.key] !== defaults.get(k)) out[id(k)] = k.obj()[k.key];
  return out;
}

function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify(changed()));
  } catch {
    /* storage unavailable */
  }
}

export function mountTuningPanel(onCameraChange: () => void): { toggle(): void } {
  const el = document.createElement('div');
  el.id = 'tune';
  el.hidden = true;
  const rows: { k: Knob; input: HTMLInputElement; out: HTMLElement }[] = [];
  const head = document.createElement('div');
  head.className = 'tune-head';
  head.innerHTML = '<b>TUNING</b> <span>(T to hide)</span>';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  head.append(copy, reset);
  el.append(head);

  for (const k of KNOBS) {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = k.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(k.min);
    input.max = String(k.max);
    input.step = String(k.step);
    input.value = String(k.obj()[k.key]);
    const out = document.createElement('output');
    out.textContent = input.value;
    input.addEventListener('input', () => {
      k.obj()[k.key] = Number(input.value);
      out.textContent = input.value;
      out.classList.toggle('dirty', Number(input.value) !== defaults.get(k));
      persist();
      if (k.path === 'camera' || k.key === 'cameraHeight') onCameraChange();
    });
    // Keep keyboard input for the game, not the slider.
    input.addEventListener('keydown', (e) => e.preventDefault());
    out.classList.toggle('dirty', k.obj()[k.key] !== defaults.get(k));
    row.append(name, input, out);
    el.append(row);
    rows.push({ k, input, out });
  }

  copy.addEventListener('click', () => {
    const text = JSON.stringify(changed(), null, 2);
    void navigator.clipboard?.writeText(text).catch(() => {});
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
    console.log('Tuning overrides:\n' + text);
  });
  reset.addEventListener('click', () => {
    // Clear overrides and reload so every system starts from tuning.ts again.
    try {
      localStorage.removeItem(STORE);
    } catch {
      /* ignore */
    }
    location.reload();
  });

  document.getElementById('app')!.append(el);
  return {
    toggle() {
      el.hidden = !el.hidden;
    },
  };
}
