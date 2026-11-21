/**
 * THE ENGINE DECK (Flows) AND THE POWER CORE (Tokens): what their figures do, and what their
 * gauges read. Pure, so every rule is tested without a screen. Same law as the bridge and the
 * map: ONE LOOK PER STATE.
 *
 *   engineer   call  a live run cannot go on without you
 *              work  a run is running
 *              idle  nothing is running
 *
 *   quartermaster  call  a task failed in the last FAILED_RECENT_MS (a fresh failure wants you)
 *                  work  a task is claimed or in progress
 *                  idle  nothing is being worked (queued tasks wait; they are on the gauge)
 *
 *   core       warn    the subscription quota is nearly gone (the provider says hold, or ≥ 85% used)
 *              high    burning at CORE_AT.high tokens an hour or more
 *              normal  burning at CORE_AT.normal or more
 *              low     below that, or no reading at all
 *
 *   core heat  what the quota does to the core, on top of its level — ONE LOOK PER STAGE:
 *              none    under 80% used: the core as it is
 *              amber   80–84%: the glass warms, a soft glow, a few embers
 *              orange  85–89%: orange glass, a stronger glow, more embers (the drone's alarm is `warn`)
 *              red     90% and up: red glass, a fast pulse, the core shakes, the tank turns red
 *              The glow grows evenly from 80% to 90%, so a stage is never a jump.
 */
import type { Task, Workflow } from '../../types';
import { hoursLabel } from '../../lib/subscriptionUsage';

type Run = Pick<Workflow, 'status'> & { needsAttention?: unknown; completedAt?: string | null };

export const ENGINEER_ANIMS = ['idle', 'work', 'call'] as const;
export type EngineerAnim = (typeof ENGINEER_ANIMS)[number];

const live = (r: Run) => r.status === 'running' || r.status === 'paused';

export function engineerAnim(runs: readonly Run[]): EngineerAnim {
  if (runs.some((r) => live(r) && Boolean(r.needsAttention))) return 'call';
  if (runs.some((r) => r.status === 'running')) return 'work';
  return 'idle';
}

export function flowGauges(runs: readonly Run[], now: number): { running: number; waiting: number; doneToday: number } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    running: runs.filter((r) => r.status === 'running').length,
    waiting: runs.filter((r) => live(r) && Boolean(r.needsAttention)).length,
    doneToday: runs.filter((r) => r.status === 'completed' && r.completedAt && new Date(r.completedAt).getTime() >= midnight.getTime()).length,
  };
}

/**
 * The engineer at the workflow canvas, from the one run that is open in it: the same three
 * looks as on the Flows page. `call` = the run is paused, or a step of the live run failed.
 */
export function canvasEngineerAnim(workflowStatus: string, stepStatuses: readonly string[]): EngineerAnim {
  const liveRun = workflowStatus === 'running' || workflowStatus === 'paused';
  if (!liveRun) return 'idle';
  if (workflowStatus === 'paused' || stepStatuses.includes('failed')) return 'call';
  if (stepStatuses.includes('running')) return 'work';
  return 'idle';
}

export const QUARTERMASTER_ANIMS = ['idle', 'work', 'call'] as const;
export type QuartermasterAnim = (typeof QUARTERMASTER_ANIMS)[number];
/** How long a failed task keeps calling for you. After that it is history in the list. */
export const FAILED_RECENT_MS = 6 * 60 * 60 * 1000;

type TaskLike = Pick<Task, 'status' | 'completedAt'>;
const working = (t: TaskLike) => t.status === 'claimed' || t.status === 'in_progress';

export function quartermasterAnim(tasks: readonly TaskLike[], now: number): QuartermasterAnim {
  const fresh = (t: TaskLike) => t.status === 'failed' && t.completedAt !== null && now - new Date(t.completedAt).getTime() < FAILED_RECENT_MS;
  if (tasks.some(fresh)) return 'call';
  if (tasks.some(working)) return 'work';
  return 'idle';
}

export function taskGauges(tasks: readonly TaskLike[], now: number): { queued: number; active: number; doneToday: number } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    queued: tasks.filter((t) => t.status === 'queued').length,
    active: tasks.filter(working).length,
    doneToday: tasks.filter((t) => t.status === 'done' && t.completedAt !== null && new Date(t.completedAt).getTime() >= midnight.getTime()).length,
  };
}

export const CORE_LEVELS = ['low', 'normal', 'high', 'warn'] as const;
export type CoreLevel = (typeof CORE_LEVELS)[number];
/** Tokens per hour (all four token classes, as the header counts them) at which the core steps up. */
export const CORE_AT = { normal: 1_000_000, high: 20_000_000 } as const;
/** Percent of the quota used at which the core warns, when the provider's meter does not say itself. */
export const QUOTA_WARN_PCT = 85;

export function coreLevel(s: { tokensPerHour: number; warn: boolean }): CoreLevel {
  if (s.warn) return 'warn';
  if (s.tokensPerHour >= CORE_AT.high) return 'high';
  if (s.tokensPerHour >= CORE_AT.normal) return 'normal';
  return 'low';
}

export const CORE_HEATS = ['none', 'amber', 'orange', 'red'] as const;
export type CoreHeat = (typeof CORE_HEATS)[number];
/** Percent of the quota used at which each heat stage starts. `orange` is the warning (QUOTA_WARN_PCT). */
export const HEAT_AT = { amber: 80, orange: QUOTA_WARN_PCT, red: 90 } as const;
export const HEAT_LINE: Record<Exclude<CoreHeat, 'none'>, string> = { amber: 'Core heating up', orange: 'Quota nearly gone', red: 'Core overheating' };

/** The core's heat for a quota reading: its stage, and how strong the glow is (0 at 80%, 1 from 90%). */
export function coreHeat(pct: number | null | undefined): { stage: CoreHeat; glow: number } {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct < HEAT_AT.amber) return { stage: 'none', glow: 0 };
  const glow = Math.min(1, (pct - HEAT_AT.amber) / (HEAT_AT.red - HEAT_AT.amber));
  return { stage: pct >= HEAT_AT.red ? 'red' : pct >= HEAT_AT.orange ? 'orange' : 'amber', glow: Math.round(glow * 100) / 100 };
}

/** Sent on `window` when a quota reading is logged or removed, so the core re-reads at once. */
export const USAGE_CHANGED = 'neoncore:usage-changed';

export interface Quota { pct: number; resetsIn: string | null; warn: boolean }

interface RateLike {
  usageAnchor?: { provider: string; window: string; pctUsed: number; hoursToReset: number; pace: string }[];
  subscriptionUsage?: { provider: string; pctUsed: number; daysRemaining: number | null }[];
}

/**
 * How much of the subscription is used. The provider's own meter (a logged checkpoint,
 * `pctUsed` 0..1) outranks the local estimate (`pctUsed` 0..100) — the same order the header
 * badge uses (components/BurnRate.tsx). Null when the server has neither: no tank is drawn.
 */
export function quotaOf(rate: RateLike | null | undefined): Quota | null {
  const anchor = rate?.usageAnchor?.find((a) => a.provider === 'claude' && a.window === 'weekly') ?? rate?.usageAnchor?.[0];
  if (anchor) {
    const pct = Math.round(Math.max(0, anchor.pctUsed) * 100);
    return { pct, resetsIn: hoursLabel(anchor.hoursToReset), warn: anchor.pace === 'hold' || pct >= QUOTA_WARN_PCT };
  }
  const sub = rate?.subscriptionUsage?.find((s) => s.provider === 'claude') ?? rate?.subscriptionUsage?.[0];
  if (sub) {
    const pct = Math.round(sub.pctUsed);
    return { pct, resetsIn: sub.daysRemaining === null ? null : hoursLabel(sub.daysRemaining * 24), warn: pct >= QUOTA_WARN_PCT };
  }
  return null;
}

export function compactTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
