/**
 * THE FEATURES HUD — the feature banners, along the bottom of the map instead of on it.
 *
 * One banner per feature being built, in EVERY sector, as they looked on the map: ✦ its name, its
 * stage (3/8), "needs you" when its pipeline waits on a person, and its seven badges (milestones.ts),
 * with its project's colour (and name, when pointed at). Those that need you first, then the
 * furthest along. A click opens the feature. The bar hides and comes back (remembered in this
 * browser), and closed it still says how many are running and how many need you.
 */
import { useState } from 'react';
import type { ActiveFeature, Goal } from '../types';
import { projectHash } from '../lib/projectSelection';
import { plateOrder } from './FeaturePlates';
import { badgesFor, FEATURE_BADGES } from './milestones';
import { KIT, type KitName } from './kit';

export const HUD_KEY = 'neoncore.world.hud';
function readOpen(): boolean { try { return window.localStorage.getItem(HUD_KEY) !== 'closed'; } catch { return true; } }

export function FeatureHud({ features, projects, goals }: {
  features: readonly ActiveFeature[];
  projects: readonly { id: string; name: string; color?: string }[];
  /** The features' records: what each banner's badges are lit from. */
  goals: readonly Goal[];
}) {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (v: boolean) => { setOpenState(v); try { window.localStorage.setItem(HUD_KEY, v ? 'open' : 'closed'); } catch { /* not remembered */ } };
  const list = plateOrder(features);
  const needs = list.filter((f) => f.needsYou).length;
  const project = new Map(projects.map((p) => [p.id, p]));
  return (
    <div data-feature-hud data-open={open || undefined}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-hud w-[min(1100px,calc(100%-560px))] min-w-[300px] flex flex-col items-center gap-1.5 pointer-events-none [&>*]:pointer-events-auto">
      {open && (
        // No height cap and no scroll: the panel is as tall as its features (asked for, 2026-11-23).
        // It grows UP from the toggle, so the map is covered only by what is actually running.
        <div data-feature-hud-panel className="max-w-full rounded-[16px] glass-dark bg-[rgba(10,16,32,0.92)] shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-md p-2.5">
          {list.length === 0 ? (
            <p data-feature-hud-empty className="text-[12px] text-gray-400 px-2 py-1">Nothing is being built right now.</p>
          ) : (
            <div className="flex flex-wrap justify-center gap-2">
              {list.map((f) => {
                const p = project.get(f.projectId);
                const color = p?.color || '#5AAEFF';
                const earned = badgesFor(goals.filter((g) => g.id === f.goalId), f.projectId);
                const needs = !!f.needsYou;
                return (
                  <button key={f.pilotId} type="button" data-hud-feature={f.goalId} data-needs-you={needs ? '' : undefined}
                    onClick={() => { window.location.hash = projectHash(f.projectId, f.goalId); }}
                    title={[p?.name, f.name, f.stage ? `stage ${f.stage.position}/${f.stage.total}: ${f.stage.title}` : '', f.branch ? `branch ${f.branch}` : '', f.needsYou].filter(Boolean).join(' · ')}
                    className={`group relative w-[248px] text-left rounded-[12px] pl-3.5 pr-3 py-2 flex flex-col gap-1.5 overflow-hidden transition-[transform,box-shadow] hover:-translate-y-0.5 ${needs ? 'panel-ask hover:shadow-[0_0_30px_rgba(255,138,61,0.3)]' : 'panel-live hover:shadow-[0_0_30px_rgba(59,139,255,0.3)]'}`}>
                    {/* The project's colour, as an edge — the same colour as its banner on the map. */}
                    <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />
                    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-gray-500">
                      <span className="truncate">{p?.name}</span>
                      {needs
                        ? <span className="ml-auto shrink-0 rounded-full border border-ember-500/60 bg-ember-500/[0.12] px-1.5 text-ember-300 font-semibold tracking-[0.08em]">needs you</span>
                        : f.stage && <span className="ml-auto shrink-0 font-mono tabular-nums text-gray-400 tracking-normal">· {f.stage.position}/{f.stage.total}</span>}
                    </span>
                    <span className="text-[13px] font-semibold leading-snug text-gray-100 line-clamp-2">
                      <span className={needs ? 'text-ember-300' : 'text-neon-400'}>✦</span> {f.name}
                      {needs && f.stage && <span className="font-mono text-[11px] font-normal text-gray-400"> · {f.stage.position}/{f.stage.total}</span>}
                    </span>
                    {f.stage && (
                      <span aria-hidden="true" className="flex gap-[3px]">
                        {Array.from({ length: f.stage.total }, (_, i) => (
                          <span key={i} className={`h-[4px] flex-1 rounded-full ${i < f.stage!.position ? (needs ? 'bg-ember-400 shadow-[0_0_6px_rgba(255,138,61,0.6)]' : 'bg-neon-400 shadow-[0_0_6px_rgba(90,174,255,0.6)]') : 'bg-white/[0.08]'}`} />
                        ))}
                      </span>
                    )}
                    <span className="flex items-center gap-[3px]" aria-label={`${earned} of ${FEATURE_BADGES.length} steps earned`}>
                      {FEATURE_BADGES.map((b, i) => (
                        <img key={b.step} data-badge={b.step} data-earned={i < earned} src={KIT[b.sprite as KitName].src} alt={i < earned ? b.label : ''}
                          className="h-[18px] w-[18px] object-contain" style={{ opacity: i < earned ? 1 : 0.18, filter: i < earned ? undefined : 'grayscale(1)' }} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <button type="button" data-feature-hud-toggle aria-expanded={open} onClick={() => setOpen(!open)}
        className="h-8 px-3.5 rounded-full glass-dark bg-[rgba(10,16,32,0.92)] shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[12px] font-semibold text-gray-200 hover:text-white inline-flex items-center gap-2">
        <span className="text-neon-400">✦</span>Features in progress
        <span className="tabular-nums text-gray-400">{list.length}</span>
        {needs > 0 && <span className="text-ember-300">· {needs} needs you</span>}
        <span aria-hidden="true" className={`text-gray-400 text-[10px] transition-transform ${open ? '' : 'rotate-180'}`}>▼</span>
      </button>
    </div>
  );
}
