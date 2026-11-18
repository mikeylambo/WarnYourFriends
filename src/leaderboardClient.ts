import { TUNING } from './tuning';
import { cleanName, type BoardMode, type Submission } from './leaderboard/verify';

/**
 * The recap's leaderboard panel. Posts the run's inputs to /api/leaderboard (the server re-plays
 * them) and shows the top rows with the player's own. Name and player id live in this browser.
 * Fails quietly: no network or no store just hides the panel.
 */
const NAME_KEY = 'wyf.lb.name';
const PLAYER_KEY = 'wyf.lb.player';
const API = '/api/leaderboard';

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

function playerId(): string {
  let id = store(PLAYER_KEY);
  if (!id || !/^[a-z0-9]{16,32}$/.test(id)) {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    id = store(PLAYER_KEY, [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 24)) ?? '';
  }
  return id;
}

const SECRET_KEY = 'wyf.lb.secret';
/** This browser's private key: the server lets only it post for (and rename) this player id. */
function secret(): string {
  let s = store(SECRET_KEY);
  if (!s || !/^[a-z0-9]{24,64}$/.test(s)) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    s = store(SECRET_KEY, [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 40)) ?? '';
  }
  return s;
}

/**
 * Roads the station issues (only issued roads rank). One is fetched ahead so a broadcast never waits for it;
 * offline or local, there is none and the broadcast runs on a road of its own (it plays the same, unranked).
 */
let issued: number | null = null;
let fetching = false;
export function prefetchSeed() {
  if (issued !== null || fetching) return;
  fetching = true;
  fetch(`${API}?ticket=1&player=${playerId()}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { seed?: unknown } | null) => {
      if (b && Number.isSafeInteger(b.seed)) issued = b.seed as number;
    })
    .catch(() => {})
    .finally(() => (fetching = false));
}
/** The issued road for a fresh broadcast (and fetch the next), or null. */
export function takeSeed(): number | null {
  const s = issued;
  issued = null;
  prefetchSeed();
  return s;
}

type Row = { rank: number; name: string; score: number; you?: boolean };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x: number) => Math.round(x).toLocaleString();

function rows(top: Row[], you: { rank: number; score: number } | null): string {
  const list = top.map((r) => `<li class="${r.you ? 'you' : ''}"><i>${r.rank}</i><span>${esc(r.name)}</span><b>${n(r.score)}</b></li>`);
  if (you && !top.some((r) => r.you)) list.push(`<li class="you gap"><i>${you.rank}</i><span>${esc(store(NAME_KEY) ?? 'You')}</span><b>${n(you.score)}</b></li>`);
  return list.length ? `<ol>${list.join('')}</ol>` : `<p class="empty">No scores yet. Be the first on air.</p>`;
}

/**
 * Mount the panel into `el`. `sub` is the finished broadcast (null: nothing to post, e.g. debug flags on).
 * With a saved name it posts straight away; the first time, it asks for one.
 */
export function mountBoard(el: HTMLElement, mode: BoardMode, sub: Submission | null, why?: string) {
  const title = mode === 'run' ? 'Full Broadcast board' : 'Single Segment board';
  const head = (right = '') => `<div class="hd">${title}<span>${right}</span></div>`;
  const player = playerId();
  let posted = false;

  const show = (top: Row[], you: { rank: number; score: number } | null, note = '') => {
    if (!el.isConnected) return;
    el.innerHTML = `${head(you ? `#${you.rank}` : '')}${rows(top, you)}${form()}${note ? `<p class="note">${esc(note)}</p>` : ''}`;
    wire();
  };
  const form = () =>
    !sub || posted
      ? why && !posted
        ? `<p class="note">${esc(why)}</p>`
        : ''
      : `<form class="post"><input name="n" maxlength="${TUNING.leaderboard.nameMax}" placeholder="Your name" autocomplete="nickname" spellcheck="false" value="${esc(store(NAME_KEY) ?? '')}" /><button class="go">Post score</button></form>`;

  const post = async (name: string) => {
    if (!sub) return;
    el.classList.add('busy');
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sub, player, secret: secret(), name }) });
      const body = (await r.json().catch(() => ({}))) as { top?: Row[]; rank?: number; best?: number; score?: number; error?: string };
      if (!r.ok) {
        const msg = body.error === 'name' ? 'That name can’t go on air. Try another.' : body.error === 'seed' ? 'This road wasn’t issued by the station (were you offline?), so it can’t be ranked.' : body.error === 'guided' ? 'The guided broadcast ranks once. Your next one counts.' : body.error === 'mismatch' || body.error === 'unfinished' ? 'The replay didn’t check out, so it wasn’t posted.' : 'Couldn’t reach the board. Try again in a moment.';
        if (body.error === 'name') store(NAME_KEY, '');
        const note = el.querySelector('.note') ?? el.appendChild(Object.assign(document.createElement('p'), { className: 'note' }));
        note.textContent = msg;
        return;
      }
      posted = true;
      store(NAME_KEY, name);
      show(body.top ?? [], body.rank ? { rank: body.rank, score: body.best ?? 0 } : null, body.best && body.score !== undefined && body.best > body.score ? `Your best stays at ${n(body.best)}.` : '');
    } catch {
      const note = el.querySelector('.note') ?? el.appendChild(Object.assign(document.createElement('p'), { className: 'note' }));
      note.textContent = 'Couldn’t reach the board. Try again in a moment.';
    } finally {
      el.classList.remove('busy');
    }
  };

  const wire = () => {
    const f = el.querySelector<HTMLFormElement>('form.post');
    if (!f) return;
    const input = f.querySelector('input')!;
    // Typing a name must not drive the recap (arrow/WASD focus moves, R, Esc): keep keys inside the field.
    for (const t of ['keydown', 'keyup', 'keypress'] as const) input.addEventListener(t, (e) => e.key !== 'Enter' && e.stopPropagation());
    f.onsubmit = (e) => {
      e.preventDefault();
      const name = cleanName(input.value);
      if (!name) {
        input.setCustomValidity(`2–${TUNING.leaderboard.nameMax} letters or numbers`);
        input.reportValidity();
        return;
      }
      void post(name);
    };
    input.oninput = () => input.setCustomValidity('');
  };

  el.innerHTML = `${head()}<p class="empty">Loading…</p>`;
  el.hidden = false;
  void (async () => {
    try {
      const r = await fetch(`${API}?mode=${mode}&player=${player}`);
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as { top: Row[]; you: { rank: number; score: number } | null };
      const saved = cleanName(store(NAME_KEY));
      if (sub && saved) {
        show(body.top, body.you);
        await post(saved);
      } else show(body.top, body.you);
    } catch {
      el.hidden = true; // no board here (local dev, offline, or not configured yet)
    }
  })();
}
