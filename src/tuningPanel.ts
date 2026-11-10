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
const angle = (i: number) => () => TUNING.camera.angles[i] as unknown as Num;
const sect = (k: keyof typeof TUNING) => () => TUNING[k] as unknown as Num;

const KNOBS: Knob[] = [];
TUNING.tiers.forEach((t, i) => {
  const p = `tiers[${i}]`;
  KNOBS.push(
    { label: `${t.name} top speed`, obj: tier(i), key: 'topSpeed', min: 3, max: 25, step: 0.5, path: p },
    { label: `${t.name} accel`, obj: tier(i), key: 'accel', min: 1, max: 20, step: 0.5, path: p },
    { label: `${t.name} lane change s`, obj: tier(i), key: 'laneChangeTime', min: 0.08, max: 0.8, step: 0.01, path: p },
    { label: `${t.name} cadence /s`, obj: tier(i), key: 'cadence', min: 1.6, max: 2.6, step: 0.05, path: p },
    { label: `${t.name} lean °`, obj: tier(i), key: 'leanDeg', min: 0, max: 45, step: 1, path: p },
    { label: `${t.name} hip height`, obj: tier(i), key: 'hipHeight', min: 1.1, max: 1.7, step: 0.02, path: p },
    { label: `${t.name} body drop`, obj: tier(i), key: 'bodyDrop', min: 0, max: 0.5, step: 0.01, path: p },
    { label: `${t.name} cam distance ×`, obj: tier(i), key: 'cameraDistanceScale', min: 0.6, max: 1.6, step: 0.05, path: p },
  );
  if (Number.isFinite(t.tierUpAfter)) KNOBS.push({ label: `${t.name} tier-up s`, obj: tier(i), key: 'tierUpAfter', min: 0.5, max: 8, step: 0.25, path: p });
});
TUNING.camera.angles.forEach((a, i) => {
  const p = `camera.angles[${i}]`;
  KNOBS.push(
    { label: `${a.name} yaw °`, obj: angle(i), key: 'yawDeg', min: 0, max: 60, step: 1, path: p },
    { label: `${a.name} pitch °`, obj: angle(i), key: 'pitchDeg', min: 20, max: 85, step: 1, path: p },
    { label: `${a.name} distance m`, obj: angle(i), key: 'distance', min: 15, max: 120, step: 1, path: p },
    { label: `${a.name} FOV`, obj: angle(i), key: 'fov', min: 12, max: 70, step: 1, path: p },
  );
});
KNOBS.push(
  { label: 'Cam look-ahead s', obj: sect('camera'), key: 'lookAheadTime', min: 0, max: 3, step: 0.1, path: 'camera' },
  { label: 'Cam cut hold min s', obj: sect('camera'), key: 'cutMinInterval', min: 7, max: 30, step: 0.5, path: 'camera' },
  { label: 'Cam position lag s', obj: sect('camera'), key: 'positionLag', min: 0, max: 1, step: 0.05, path: 'camera' },
  { label: 'Cam look lag s', obj: sect('camera'), key: 'lookLag', min: 0, max: 1, step: 0.05, path: 'camera' },
  { label: 'Stance max m', obj: sect('gait'), key: 'stanceMaxDistance', min: 0.8, max: 3, step: 0.05, path: 'gait' },
  { label: 'Foot spread m', obj: sect('gait'), key: 'footSpread', min: 0.1, max: 0.7, step: 0.02, path: 'gait' },
  { label: 'Contact hold frames', obj: sect('gait'), key: 'contactHoldFrames', min: 0, max: 4, step: 1, path: 'gait' },
  { label: 'Footfall pulse px', obj: sect('footfall'), key: 'pulsePx', min: 0, max: 8, step: 0.5, path: 'footfall' },
  { label: 'Prop row gap min m', obj: () => TUNING.props.rowGap as unknown as Num, key: '0', min: 8, max: 60, step: 1, path: 'props.rowGap' },
  { label: 'Prop row gap max m', obj: () => TUNING.props.rowGap as unknown as Num, key: '1', min: 10, max: 90, step: 1, path: 'props.rowGap' },
  { label: 'Prop row chance', obj: sect('props'), key: 'rowChance', min: 0, max: 1, step: 0.05, path: 'props' },
  { label: 'Prop Medium weight', obj: sect('props'), key: 'mediumWeight', min: 0, max: 1, step: 0.05, path: 'props' },
  { label: 'Prop Heavy weight', obj: sect('props'), key: 'heavyWeight', min: 0, max: 1, step: 0.05, path: 'props' },
  { label: 'Bounce speed kept', obj: sect('collision'), key: 'bounceSpeedKeep', min: 0.2, max: 1, step: 0.05, path: 'collision' },
  { label: 'Brake decel', obj: sect('brake'), key: 'decel', min: 4, max: 30, step: 1, path: 'brake' },
);
// Note: prop density changes apply to road generated after the change (R restarts the run).

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

export function mountTuningPanel(): { toggle(): void } {
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
