/**
 * THE MAP SWITCH — which map the world is on. Every theme has its home map and the ones the outfit
 * unlocks (theme.ts MAPS_BY_THEME). A map still to earn is NOT shown here — the progress chip beside
 * it (NewMapPanel) is the only sign of it. Once unlocked it appears, and travelling there moves the
 * whole crew; the choice is remembered. With only the home map open there is nothing to choose, and
 * no switch.
 */
import type { WorldMap } from './theme';

export const isOpen = (m: WorldMap, unlocked: ReadonlySet<string>) => m.requires === undefined || unlocked.has(m.requires);

export function MapSwitch({ maps, current, unlocked, onGo }: {
  maps: readonly WorldMap[];
  /** The id of the map on screen. */
  current: string;
  /** The unlock ids the outfit has earned (server lib/project-rewards.ts NEW_MAPS). */
  unlocked: ReadonlySet<string>;
  onGo: (id: string) => void;
}) {
  const open = maps.filter((m) => isOpen(m, unlocked));
  if (open.length < 2) return null;
  return (
    <div data-maps role="group" aria-label="Maps" className="flex items-stretch gap-1.5">
      {open.map((m) => {
        const on = m.id === current;
        return (
          <button key={m.id} data-map={m.id} data-current={on || undefined} aria-pressed={on}
            onClick={() => { if (!on) onGo(m.id); }} title={`${m.name} — ${m.blurb}`}
            className={`px-3 py-1.5 rounded-[10px] text-left whitespace-nowrap transition-colors ${on ? 'bg-neon-500/20 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.7)]' : 'hover:bg-white/[0.06]'}`}>
            <span className={`block font-display text-[13px] font-bold tracking-[0.1em] uppercase ${on ? 'text-neon-100' : 'text-gray-200'}`}>{m.name}</span>
            <span data-map-says className="block text-[12px] text-gray-400">{on ? 'You are here' : 'Travel here'}</span>
          </button>
        );
      })}
    </div>
  );
}
