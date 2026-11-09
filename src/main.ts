/**
 * Bootstrap. Checks the platform before loading the game so a missing
 * capability shows a message instead of leaving an inert title screen.
 *
 * Regression (DECISIONS.md 2026-11-10): without WebGL, three's renderer threw at
 * module top level before any input handler was bound. The page loaded, the
 * title showed, and the start button silently did nothing.
 */

function showFatal(title: string, body: string, detail?: string) {
  const el = document.getElementById('fatal');
  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.hidden = true;
  if (!el) {
    document.body.textContent = `${title}: ${body}`;
    return;
  }
  (el.querySelector('h2') as HTMLElement).textContent = title;
  (el.querySelector('.body') as HTMLElement).textContent = body;
  (el.querySelector('.detail') as HTMLElement).textContent = detail ?? '';
  el.hidden = false;
  document.documentElement.dataset.boot = 'failed';
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  if (!hasWebGL2()) {
    showFatal(
      'WebGL is switched off',
      'This browser could not create a WebGL 2 context, which the game needs to draw the city. ' +
        'Turn on hardware acceleration (Chrome: Settings → System → "Use graphics acceleration when available", then relaunch) ' +
        'or try another browser.',
      'Diagnostics: chrome://gpu (Chrome) or about:support (Firefox) shows whether WebGL is blocked.',
    );
    return;
  }
  try {
    await import('./game');
    document.documentElement.dataset.boot = 'ok';
  } catch (e) {
    console.error(e);
    showFatal('The broadcast failed to start', 'Something went wrong while loading the game. Reloading usually fixes it.', String((e as Error)?.message ?? e));
  }
}

void boot();
