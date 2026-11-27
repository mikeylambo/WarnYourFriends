import type { Audio } from './audio';
import { KNOBS, MIX, importMix, mixChanged, onMixChange, resetMix, setMix } from './mix';

/**
 * The audio mix panel (M, with ?mix=1 or ?playtest=1). One slider per level in `mix.ts`, grouped, in dB (0 = as the
 * code plays it); ▶ plays a sound the way the game does. Changes apply live and stay in this browser; Copy / Save
 * export only the knobs you moved, as JSON, and Paste applies one. Send the JSON back and it becomes the defaults.
 */
export function mountMixPanel(audio: Audio): { toggle(): void } {
  const el = document.createElement('div');
  el.id = 'mix';
  el.hidden = true;
  const head = document.createElement('div');
  head.className = 'mix-head';
  head.innerHTML = '<b>MIX</b> <span>(M to hide)</span>';
  const btn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    return b;
  };
  const copy = btn('Copy');
  const save = btn('Save');
  const paste = btn('Paste');
  const reset = btn('Reset');
  head.append(copy, save, paste, reset);
  const note = document.createElement('div');
  note.className = 'mix-note';
  note.textContent = 'dB: 0 is as shipped. ▶ plays it like the game does. Music, sirens and the rotor: tune them in a live run.';
  el.append(head, note);

  const rows: { id: string; input: HTMLInputElement; show: () => void }[] = [];
  let group = '';
  for (const k of KNOBS) {
    if (k.group !== group) {
      group = k.group;
      const h = document.createElement('h4');
      h.textContent = group;
      el.append(h);
    }
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = k.label;
    const play = document.createElement('button');
    play.textContent = '▶';
    play.className = 'mix-play';
    play.disabled = !k.preview;
    play.addEventListener('click', (e) => {
      e.preventDefault();
      audio.unlock();
      if (k.preview) audio.preview(k.preview);
    });
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(k.min);
    input.max = String(k.max);
    input.step = String(k.step);
    input.value = String(MIX[k.id]);
    const out = document.createElement('output');
    const show = () => {
      const v = MIX[k.id];
      out.textContent = k.unit === 'dB' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : v.toFixed(2);
      out.classList.toggle('dirty', v !== k.def);
    };
    show();
    input.addEventListener('input', () => setMix(k.id, Number(input.value)));
    // Keep keyboard input for the game, not the slider.
    input.addEventListener('keydown', (e) => e.preventDefault());
    row.append(name, play, input, out);
    el.append(row);
    rows.push({ id: k.id, input, show });
  }
  // Redraw every row when anything changes from outside (paste, reset).
  onMixChange(() => {
    for (const r of rows) {
      r.input.value = String(MIX[r.id]);
      r.show();
    }
  });

  const json = () => JSON.stringify(mixChanged(), null, 2);
  const flash = (b: HTMLButtonElement, text: string) => {
    const was = b.textContent;
    b.textContent = text;
    setTimeout(() => (b.textContent = was), 1400);
  };
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(json()).catch(() => {});
    console.log('Mix overrides:\n' + json());
    flash(copy, Object.keys(mixChanged()).length ? 'Copied' : 'No changes');
  });
  save.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
    a.download = 'wyf-mix.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  paste.addEventListener('click', () => {
    const text = window.prompt('Paste a mix JSON (it replaces matching knobs):');
    if (!text) return;
    try {
      flash(paste, `${importMix(JSON.parse(text))} set`);
    } catch {
      flash(paste, 'Bad JSON');
    }
  });
  reset.addEventListener('click', () => resetMix());

  document.getElementById('app')!.append(el);
  return {
    toggle() {
      el.hidden = !el.hidden;
    },
  };
}
