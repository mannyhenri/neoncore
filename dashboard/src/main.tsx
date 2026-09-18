import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * THE WAY OUT OF DEMO MODE THAT DOES NOT NEED THE APP TO RENDER.
 *
 * Demo mode's only exits were the banner button and the Settings checkbox — both INSIDE the
 * app. When a bad demo response crashed the first render, the screen went blank and every exit
 * went with it: "I'm unable to restore it." A recovery control that lives inside the thing it
 * recovers is not a recovery control.
 *
 * So this runs BEFORE React, before any component, before anything that can throw:
 *
 *     http://your-neoncore/?demo=off
 *
 * It also accepts ?demo=on, which is how you would hand someone a demo link.
 *
 * The query string is then removed from the URL so a bookmark or a refresh does not silently
 * re-apply it — a URL that keeps re-enabling demo mode would be a second trap.
 */
function applyDemoOverrideFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('demo');
    if (wanted !== 'on' && wanted !== 'off') return;

    if (wanted === 'on') localStorage.setItem('neoncore.demoMode', '1');
    else localStorage.removeItem('neoncore.demoMode');

    params.delete('demo');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } catch {
    /* Storage blocked, or an exotic URL. Not being able to force the flag is not a reason to
       stop the app from booting. */
  }
}

applyDemoOverrideFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
