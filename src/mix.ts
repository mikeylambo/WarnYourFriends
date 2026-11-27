/**
 * The audio mix, in one place (Mike, 2026-11-27: "give me an audio mixing panel with exportable json settings").
 *
 * Every level the Audio class applies on top of its own call volumes is a knob here, in dB (0 = as the code plays it):
 *   bus.*    the music and SFX buses (on top of the Settings sliders)
 *   music.*  the run theme, title theme, busted and sign-off songs
 *   amb.*    the three sirens, the rotor at rest and at Rampage, how quiet a far cruiser's siren gets
 *   sfx.*    one trim per recorded sound
 * `src/mixPanel.ts` edits these live (M, with ?mix=1 or ?playtest=1), keeps changes in this browser, and exports
 * only the changed knobs as JSON; a pasted export becomes the new defaults below. Pure data, no DOM beyond
 * localStorage, so it is safe to import anywhere.
 */

/** Every recorded one-shot kind (`src/assets/sfx/<kind>-<take>.mp3`). */
export const SFX_KINDS = [
  'foot', 'smash-light', 'smash-medium', 'smash-heavy', 'bounce', 'scrape', 'shoulder', 'leap', 'land',
  'whoosh', 'tierup', 'tierdown', 'banked', 'cape', 'spike', 'roadblock',
  'chain-tick', 'chain-bank', 'chain-drop', 'gear-tick', 'rampage-on', 'rampage-off', 'honk', 'whoop',
  'tell-cruiser', 'tell-cruiser-siren', 'tell-rolling', 'tell-chopper', 'tell-carrier', 'spotlight-lock',
] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

export interface MixKnob {
  id: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  def: number;
  /** 'dB' knobs are gains; 'x' is a plain 0..1 fraction. */
  unit: 'dB' | 'x';
  /** A sound the panel can play to hear this knob (the Audio method that the game itself calls). */
  preview?: string;
}

const db = (lin: number) => Math.round(20 * Math.log10(lin) * 10) / 10;
const knob = (id: string, label: string, group: string, def: number, o: Partial<MixKnob> = {}): MixKnob => ({ id, label, group, min: -40, max: 12, step: 0.5, def, unit: 'dB', ...o });

/** Knobs the pivot loop never plays (ability and Net sounds): left out of the panel, still trimmable in the JSON. */
const DEAD: SfxKind[] = ['banked', 'leap', 'shoulder'];

const SFX_GROUP: Record<string, string> = {
  'tell-cruiser': 'Police cues', 'tell-cruiser-siren': 'Police cues', 'tell-rolling': 'Police cues', 'tell-chopper': 'Police cues', 'tell-carrier': 'Police cues',
  'spotlight-lock': 'Police cues', whoop: 'Police cues', roadblock: 'Police cues', spike: 'Police cues', honk: 'Police cues',
  'chain-tick': 'Score and gear', 'chain-bank': 'Score and gear', 'chain-drop': 'Score and gear', 'gear-tick': 'Score and gear',
  'rampage-on': 'Score and gear', 'rampage-off': 'Score and gear', tierup: 'Score and gear', tierdown: 'Score and gear',
};
/** The Audio method each sound's preview button calls. */
const PREVIEW: Partial<Record<SfxKind, string>> = {
  foot: 'foot', 'smash-light': 'smash-light', 'smash-medium': 'smash-medium', 'smash-heavy': 'smash-heavy', bounce: 'bounce', scrape: 'scrape',
  whoosh: 'whoosh', tierup: 'tierup', tierdown: 'tierdown', cape: 'cape', land: 'land',
  'chain-tick': 'chain-tick', 'chain-bank': 'chain-bank', 'chain-drop': 'chain-drop', 'gear-tick': 'gear-tick', 'rampage-on': 'rampage-on', 'rampage-off': 'rampage-off',
  honk: 'honk', whoop: 'whoop', 'tell-cruiser': 'tell-cruiser', 'tell-rolling': 'tell-rolling', 'tell-chopper': 'tell-chopper', 'tell-carrier': 'tell-carrier',
  'spotlight-lock': 'spotlight-lock', roadblock: 'roadblock', spike: 'spike',
};

export const KNOBS: MixKnob[] = [
  knob('bus.music', 'Music bus', 'Buses', 0, { min: -60 }),
  knob('bus.sfx', 'SFX bus', 'Buses', 0, { min: -60 }),
  // Defaults are the 2026-11-27 measured balance (DECISIONS): theme ~-28 dBFS mean in the groove, sirens ~-28.5 each.
  knob('music.theme', 'Run theme', 'Music', db(0.6)),
  knob('music.title', 'Title theme (menus)', 'Music', db(0.55)),
  knob('music.busted', 'Busted theme', 'Music', db(0.6)),
  knob('music.signOff', 'Sign-off theme (recap)', 'Music', db(0.6)),
  knob('amb.sirenWail', 'Siren: wail', 'Ambience', db(0.75)),
  knob('amb.sirenYelp', 'Siren: yelp', 'Ambience', db(0.62)),
  knob('amb.sirenHilo', 'Siren: hi-lo', 'Ambience', db(0.56)),
  knob('amb.sirenFloor', 'Far siren floor (fraction of full)', 'Ambience', 0.4, { unit: 'x', min: 0, max: 1, step: 0.05 }),
  knob('amb.rotorRest', 'Rotor at rest', 'Ambience', db(0.32)),
  knob('amb.rotorRampage', 'Rotor at Rampage', 'Ambience', db(0.44)),
];
for (const k of SFX_KINDS) {
  if (DEAD.includes(k)) continue;
  KNOBS.push(knob(`sfx.${k}`, k, SFX_GROUP[k] ?? 'Movement and impacts', 0, { min: -30, preview: PREVIEW[k] }));
}

const STORE = 'wyf.mix.v1';
const DEFAULTS: Record<string, number> = {};
/** Current values, by knob id (and, for kinds without a knob, `sfx.<kind>` stays 0 unless imported). */
export const MIX: Record<string, number> = {};
for (const k of KNOBS) DEFAULTS[k.id] = MIX[k.id] = k.def;
for (const k of SFX_KINDS) MIX[`sfx.${k}`] ??= 0;

/** dB → gain (a 'x' knob is read straight from MIX). */
export const lin = (id: string): number => 10 ** ((MIX[id] ?? 0) / 20);

const listeners = new Set<() => void>();
/** Called whenever a knob changes (the Audio class re-applies its levels). Returns an unsubscribe. */
export function onMixChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const emit = () => listeners.forEach((cb) => cb());

/** Only the knobs moved off their defaults: this is the export. */
export function mixChanged(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(MIX)) if (MIX[id] !== (DEFAULTS[id] ?? 0)) out[id] = MIX[id];
  return out;
}

function persist() {
  try {
    const ch = mixChanged();
    if (Object.keys(ch).length) localStorage.setItem(STORE, JSON.stringify(ch));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage unavailable: the mix just won't survive a reload */
  }
}

export function setMix(id: string, v: number) {
  if (!(id in MIX) || !Number.isFinite(v)) return;
  MIX[id] = v;
  persist();
  emit();
}

/** Apply a pasted export (unknown ids and non-numbers are ignored). Returns how many knobs it set. */
export function importMix(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  let n = 0;
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (id in MIX && typeof v === 'number' && Number.isFinite(v)) {
      MIX[id] = v;
      n++;
    }
  }
  persist();
  emit();
  return n;
}

export function resetMix() {
  for (const id of Object.keys(MIX)) MIX[id] = DEFAULTS[id] ?? 0;
  persist();
  emit();
}

// This browser's saved tweaks (nothing for players: the panel is the only writer).
try {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE) : null;
  if (raw) importMix(JSON.parse(raw));
} catch {
  /* ignore a corrupt save */
}
