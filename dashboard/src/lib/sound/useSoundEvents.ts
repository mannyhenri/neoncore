/**
 * WHAT HAPPENED → WHICH CUE. Watches the records the app already holds and plays one cue per
 * KIND of thing that just happened (cues.ts says which, and whether it may sound).
 *
 * What was already true when the page opened is not news: every watcher starts from what it
 * first sees and only reports what is new after that.
 */
import { useEffect, useRef } from 'react';
import type { Agent, PermissionRequest, StuckAlert, Task, WorkflowNotification } from '../../types';
import { api } from '../api';
import { coreHeat, quotaOf, USAGE_CHANGED } from '../../world/bridge/deckState';
import { cueForNotification, type Cue } from './cues';
import { playCue, playUi, startSound, uiSoundFor } from './engine';

export interface SoundWatch {
  agents: readonly Pick<Agent, 'id' | 'status'>[];
  pendingPermissions: readonly Pick<PermissionRequest, 'id'>[];
  stuckAlerts: readonly Pick<StuckAlert, 'agentId'>[];
  workflowNotifications: readonly (Pick<WorkflowNotification, 'id' | 'title'> & { kind?: string })[];
  tasks: readonly Pick<Task, 'id' | 'status'>[];
  /** Features delivered, per project. */
  delivered: ReadonlyMap<string, number>;
  /** Percent of the Claude quota used; null when there is no reading. */
  quotaPct: number | null;
}

/** The cues a change from `prev` to `next` calls for — each kind at most once. Pure. */
export function cuesFor(prev: SoundWatch, next: SoundWatch): Cue[] {
  const out = new Set<Cue>();
  const fresh = <T,>(a: readonly T[], b: readonly T[], id: (x: T) => string) => { const had = new Set(a.map(id)); return b.filter((x) => !had.has(id(x))); };

  if (fresh(prev.pendingPermissions, next.pendingPermissions, (p) => p.id).length > 0) out.add('needs-you');
  if (fresh(prev.stuckAlerts, next.stuckAlerts, (s) => s.agentId).length > 0) out.add('stuck');
  for (const n of fresh(prev.workflowNotifications, next.workflowNotifications, (x) => x.id)) out.add(cueForNotification(n));

  const was = new Map(prev.agents.map((a) => [a.id, a.status]));
  for (const a of next.agents) {
    const before = was.get(a.id);
    if (before === undefined) { if (a.status !== 'offline') out.add('launched'); continue; }
    if (before === 'offline' && a.status !== 'offline') out.add('launched');
    if ((before === 'working' || before === 'background') && a.status === 'idle') out.add('turn-finished');
  }

  const taskWas = new Map(prev.tasks.map((t) => [t.id, t.status]));
  for (const t of next.tasks) {
    const before = taskWas.get(t.id);
    if (before === undefined || before === t.status) continue;
    if (t.status === 'failed') out.add('failed');
    if (t.status === 'done') out.add('turn-finished');
  }

  for (const [project, n] of next.delivered) {
    const before = prev.delivered.get(project);
    if (before !== undefined && n > before) out.add('delivered');
  }

  const red = (pct: number | null) => coreHeat(pct).stage === 'red';
  if (red(next.quotaPct) && !red(prev.quotaPct) && prev.quotaPct !== null) out.add('quota');
  return [...out];
}

type Live = Omit<SoundWatch, 'delivered' | 'quotaPct'>;

/** Mount once, at the top of the app. */
export function useSoundEvents(live: Live): void {
  const prev = useRef<SoundWatch | null>(null);
  const polled = useRef<{ delivered: Map<string, number>; quotaPct: number | null; ready: boolean }>({ delivered: new Map(), quotaPct: null, ready: false });
  const liveRef = useRef(live);
  liveRef.current = live;

  const check = () => {
    if (!polled.current.ready) return;
    const next: SoundWatch = { ...liveRef.current, delivered: polled.current.delivered, quotaPct: polled.current.quotaPct };
    const before = prev.current;
    prev.current = next;
    if (!before) return;
    for (const cue of cuesFor(before, next)) playCue(cue);
  };

  // The engine, and the interface sounds: one listener for every button, tab and switch.
  useEffect(() => {
    const stop = startSound();
    const onClick = (e: MouseEvent) => { const id = uiSoundFor(e.target as Element | null); if (id) playUi(id); };
    document.addEventListener('click', onClick, { capture: true });
    return () => { stop(); document.removeEventListener('click', onClick, { capture: true }); };
  }, []);

  // Deliveries and the quota are not pushed to the page: ask, every half minute and whenever a reading is logged.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [projects, rate] = await Promise.all([api.getGoalProjects().catch(() => null), api.getBurnRate(7).catch(() => null)]);
      if (!alive) return;
      if (Array.isArray(projects)) polled.current.delivered = new Map(projects.map((p) => [p.id, p.featuresDone ?? 0]));
      polled.current.quotaPct = quotaOf(rate as never)?.pct ?? null;
      polled.current.ready = true;
      check();
    };
    void load();
    const t = setInterval(load, 30_000);
    window.addEventListener(USAGE_CHANGED, load);
    return () => { alive = false; clearInterval(t); window.removeEventListener(USAGE_CHANGED, load); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sig = [
    live.agents.map((a) => `${a.id}=${a.status}`).join(','), live.pendingPermissions.map((p) => p.id).join(','), live.stuckAlerts.map((s) => s.agentId).join(','),
    live.workflowNotifications.map((n) => n.id).join(','), live.tasks.map((t) => `${t.id}=${t.status}`).join(','),
  ].join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(check, [sig]);
}
