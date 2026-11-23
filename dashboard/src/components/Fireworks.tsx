/**
 * FIREWORKS — a feature was marked done (lib/celebrate.ts). Rockets rise from the bottom of the
 * screen and burst against a dimmed screen (a night sky), a banner names the feature, and the "delivered" cue plays. Over everything,
 * never in the way of a click, gone after FIREWORKS_MS. With reduced motion: the banner only.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { CELEBRATE_EVENT, type Celebration } from '../lib/celebrate';
import { playCue } from '../lib/sound/engine';

export const FIREWORKS_MS = 5600;
const COLOURS = ['#3FB4FF', '#34D36B', '#F5C542', '#FF8A3D', '#8FE3D9', '#FF7A6A', '#9CCBFF'];
/** Where each rocket bursts (fractions of the screen) and when it goes up (s). */
export const ROCKETS = [
  { x: 0.14, y: 0.30, at: 0 }, { x: 0.82, y: 0.24, at: 0.25 }, { x: 0.48, y: 0.16, at: 0.55 },
  { x: 0.30, y: 0.38, at: 0.95 }, { x: 0.66, y: 0.34, at: 1.25 }, { x: 0.22, y: 0.18, at: 1.7 }, { x: 0.76, y: 0.42, at: 2.05 },
];
export const SPARKS = 28;
const RISE_S = 0.75;

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Fireworks() {
  const [shown, setShown] = useState<(Celebration & { key: number }) | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Celebration>).detail;
      setShown({ name: d?.name ?? '', key: Date.now() });
      playCue('delivered');
    };
    window.addEventListener(CELEBRATE_EVENT, on);
    return () => window.removeEventListener(CELEBRATE_EVENT, on);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), FIREWORKS_MS);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  const still = reduced();
  return (
    <div key={shown.key} data-fireworks aria-live="polite" className={`fixed inset-0 z-[70] pointer-events-none overflow-hidden ${still ? '' : 'fw-night'}`}>
      {!still && ROCKETS.map((r, i) => {
        const c = COLOURS[i % COLOURS.length];
        const c2 = COLOURS[(i + 3) % COLOURS.length];
        return (
          <div key={i} data-firework={i} className="absolute" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }}>
            {/* the rocket: up from below the screen to where it bursts */}
            {/* the burst: a flash where it opens */}
            <span data-flash className="fw-flash" style={{ animationDelay: `${r.at + RISE_S}s`, background: `radial-gradient(circle, #FFFFFF 0%, ${c} 30%, transparent 70%)` }} />
            <span className="fw-rocket" style={{ '--from': `${(1 - r.y) * 100 + 4}vh`, animationDelay: `${r.at}s`, animationDuration: `${RISE_S}s`, background: c, boxShadow: `0 0 10px ${c}` } as CSSProperties} />
            {Array.from({ length: SPARKS }, (_, k) => {
              const a = (k / SPARKS) * Math.PI * 2;
              const d = 150 + (k % 4) * 30;
              const col = k % 2 ? c : c2;
              return <span key={k} data-spark className="fw-spark" style={{ '--dx': `${Math.cos(a) * d}px`, '--dy': `${Math.sin(a) * d + 24}px`, animationDelay: `${r.at + RISE_S}s`, background: col, boxShadow: `0 0 8px ${col}` } as CSSProperties} />;
            })}
          </div>
        );
      })}
      <div data-fireworks-banner className="absolute left-1/2 top-[11%] -translate-x-1/2 px-8 py-4 rounded-[18px] border border-[#F5C542]/60 bg-[rgba(8,12,24,0.9)] shadow-[0_0_40px_rgba(245,197,66,0.25)] text-center fw-banner">
        <p className="font-display text-[13px] font-bold tracking-[0.3em] uppercase text-[#FFE39A]">✦ Feature complete ✦</p>
        {shown.name && <p className="font-display text-[24px] font-semibold text-white mt-1 max-w-[70vw] truncate">{shown.name}</p>}
      </div>
    </div>
  );
}
