/**
 * WHAT THE DECK FIGURES DO, AND WHAT THEIR READOUTS SAY — on the phone.
 *
 * The rules are the dashboard's, imported, not copied: the captain, the engineer, the
 * quartermaster and the power core look the same on both screens because they ARE the same
 * functions (dashboard/src/world/bridge/). A copy is how this app once kept six engines a day
 * after the server dropped five. Metro follows these imports because the monorepo root is a
 * watch folder (metro.config.js); `npm run bundle:check` proves it.
 *
 * What is phone-only is here: the phone has no Projects surface, it has Goals (a project's
 * features), so the captain reads goals. Pure, so every rule is tested without a renderer.
 */
import { captainAnim, type CaptainAnim } from '../../../dashboard/src/world/bridge/captainState';
import {
  engineerAnim, flowGauges, quartermasterAnim, taskGauges, coreLevel, quotaOf, compactTokens,
  type EngineerAnim, type QuartermasterAnim, type CoreLevel,
} from '../../../dashboard/src/world/bridge/deckState';
import type { Goal, Task, Workflow } from '../types';
import type { BurnRate } from '../api';
import { scheduleLabel } from '../goalDisplay';

export interface Readout { value: string; label: string; tone?: 'live' | 'ember' | 'ok' }
export interface DeckView<A extends string> { anim: A; line: string; tone: 'live' | 'ember' | 'quiet'; readouts: Readout[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The bridge: the captain over your goals. */
export function bridgeView(goals: readonly Goal[]): DeckView<CaptainAnim> {
  const needing = goals.filter((g) => g.health).length;
  const active = goals.filter((g) => g.status === 'active');
  const late = active.some((g) => scheduleLabel(g)?.state === 'overdue');
  const anim = captainAnim({ needsYou: needing > 0, justSelected: false, deadline: late ? 'overdue' : null, underWay: active.length > 0 });
  const line = anim === 'call' ? `${plural(needing, 'goal')} need${needing === 1 ? 's' : ''} you`
    : anim === 'worry' ? 'A target date has passed'
    : anim === 'log' ? `${plural(active.length, 'goal')} under way`
    : 'Nothing under way';
  return {
    anim, line, tone: anim === 'call' || anim === 'worry' ? 'ember' : anim === 'log' ? 'live' : 'quiet',
    readouts: [
      { value: String(goals.length), label: 'GOALS' },
      { value: String(active.length), label: 'UNDER WAY', tone: active.length ? 'live' : undefined },
      { value: String(goals.filter((g) => g.status === 'achieved').length), label: 'ACHIEVED', tone: 'ok' },
    ],
  };
}

type RunLike = Pick<Workflow, 'status' | 'completedAt'> & { needsAttention?: unknown };

/** The engine deck: the engineer over your workflow runs. */
export function engineView(runs: readonly RunLike[], now: number): DeckView<EngineerAnim> {
  const anim = engineerAnim(runs);
  const g = flowGauges(runs, now);
  const line = anim === 'call' ? `${plural(g.waiting, 'run')} need${g.waiting === 1 ? 's' : ''} you`
    : anim === 'work' ? `${plural(g.running, 'run')} running`
    : 'Nothing running';
  return {
    anim, line, tone: anim === 'call' ? 'ember' : anim === 'work' ? 'live' : 'quiet',
    readouts: [
      { value: String(g.running), label: 'RUNNING', tone: g.running ? 'live' : undefined },
      { value: String(g.waiting), label: 'NEED YOU', tone: g.waiting ? 'ember' : undefined },
      { value: String(g.doneToday), label: 'DONE TODAY', tone: 'ok' },
    ],
  };
}

/** The cargo bay: the quartermaster over your tasks. */
export function cargoView(tasks: readonly Pick<Task, 'status' | 'completedAt'>[], now: number): DeckView<QuartermasterAnim> {
  const anim = quartermasterAnim(tasks, now);
  const g = taskGauges(tasks, now);
  const line = anim === 'call' ? 'A task failed' : anim === 'work' ? `${plural(g.active, 'task')} being worked` : 'Nothing being worked';
  return {
    anim, line, tone: anim === 'call' ? 'ember' : anim === 'work' ? 'live' : 'quiet',
    readouts: [
      { value: String(g.queued), label: 'QUEUED' },
      { value: String(g.active), label: 'ACTIVE', tone: g.active ? 'live' : undefined },
      { value: String(g.doneToday), label: 'DONE TODAY', tone: 'ok' },
    ],
  };
}

/** The power core: how hard the fleet is burning, and how much of the quota is gone. */
export function coreView(burn: BurnRate | null): DeckView<CoreLevel> {
  const quota = quotaOf(burn as Parameters<typeof quotaOf>[0]);
  const perHour = burn && Number.isFinite(burn.tokensPerHour) ? burn.tokensPerHour : 0;
  const anim = coreLevel({ tokensPerHour: perHour, warn: quota?.warn ?? false });
  const line = !burn ? 'No reading'
    : anim === 'warn' ? `Quota ${quota?.pct ?? 0}% used`
    : `${compactTokens(perHour)} tokens / hour`;
  return {
    anim, line, tone: anim === 'warn' ? 'ember' : anim === 'low' ? 'quiet' : 'live',
    readouts: [
      { value: burn ? compactTokens(perHour) : '—', label: 'TOK / HR', tone: anim === 'high' || anim === 'normal' ? 'live' : undefined },
      { value: quota ? `${quota.pct}%` : '—', label: 'QUOTA USED', tone: quota?.warn ? 'ember' : undefined },
      { value: quota?.resetsIn ?? '—', label: 'RESETS IN' },
    ],
  };
}

/** Which sheet a deck uses, and every look its figure can take — checked against the art. */
export const DECK_FIGURES = {
  bridge: { sheet: 'captain', anims: ['idle', 'call', 'worry', 'log'] },
  engine: { sheet: 'engineer', anims: ['idle', 'work', 'call'] },
  cargo: { sheet: 'quartermaster', anims: ['idle', 'work', 'call'] },
  core: { sheet: 'core', anims: ['low', 'normal', 'high', 'warn'] },
} as const;
export type DeckName = keyof typeof DECK_FIGURES;
