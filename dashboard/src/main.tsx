import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

/**
 * THE WAY OUT OF DEMO MODE THAT DOES NOT NEED THE APP TO RENDER.
 *
 * Demo mode's only exits were the banner button and the Settings checkbox — both INSIDE the
 * app. When a bad demo response crashed the first render, the screen went blank and every exit
 * went with it. A recovery control that lives inside the thing it recovers is not one.
 *
 *     http://your-neoncore/?demo=off     ?demo=on to hand someone a demo link
 *
 * ── WHY App IS IMPORTED DYNAMICALLY, WHICH IS THE WHOLE POINT ─────────────────────────
 * The first version of this file had `import App from './App'` at the top and called the
 * override below it, with a comment claiming it ran "before any component". It did not.
 * ES module imports are HOISTED: `./App` — and through it `lib/api`, which reads the demo flag
 * ONCE at module load — was fully evaluated before a single statement in this file executed.
 * So `?demo=off` dutifully cleared storage a moment after the decision had already been made,
 * and the page came back in demo mode anyway. Exactly the hoisting trap
 * server/test/helpers/isolated-db.ts was written to warn about: "the assignment looks first in
 * the source and executes last."
 *
 * The override has to run before the module graph that reads the flag is evaluated, and a
 * static import makes that impossible. Hence `await import('./App')` AFTER it.
 */
function applyDemoOverrideFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('demo');
    if (wanted !== 'on' && wanted !== 'off') return;

    if (wanted === 'on') localStorage.setItem('neoncore.demoMode', '1');
    else localStorage.removeItem('neoncore.demoMode');

    // Strip it, so a bookmark or a refresh cannot silently re-apply the flag — a URL that
    // keeps re-enabling demo mode would be a second trap.
    params.delete('demo');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } catch {
    /* Storage blocked, or an exotic URL. Not being able to force the flag is not a reason to
       stop the app from booting. */
  }
}

applyDemoOverrideFromUrl();

// Only now, with the flag settled, is the module graph that reads it allowed to load.
//
// `.then` rather than top-level await: the build targets chrome87/safari14, where TLA is not
// available, and vite refuses the bundle outright. The ordering guarantee is identical — the
// dynamic import is not evaluated until this statement runs.
void import('./App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
