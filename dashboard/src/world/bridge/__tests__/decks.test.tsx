import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const data = vi.hoisted(() => ({ runs: [] as unknown[], rate: null as Record<string, unknown> | null }));
vi.mock('../../../lib/api', () => ({ api: {
  getWorkflows: () => Promise.resolve(data.runs),
  getBurnRate: () => (data.rate ? Promise.resolve(data.rate) : Promise.reject(new Error('no rate'))),
  getGoalProjects: () => Promise.resolve([]),
} }));

import { ENGINEER_ANIMS, engineerAnim, flowGauges, CORE_LEVELS, CORE_AT, coreLevel, quotaOf, compactTokens } from '../deckState';
import { EngineerPost, FlowGauges, CorePost, TokenGauges, QuartermasterPost, TaskGauges, deckProps, DECK_VIEWS } from '../Decks';
import { QUARTERMASTER_ANIMS, quartermasterAnim, taskGauges, FAILED_RECENT_MS } from '../deckState';
import type { Task } from '../../../types';
import { DECK_ART } from '../bridge.generated';

const STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
const run = (status: (typeof STATUSES)[number], over: { needsAttention?: unknown; completedAt?: string } = {}) => ({ id: `r-${status}-${Math.random()}`, status, needsAttention: null as unknown, ...over });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
afterEach(() => { cleanup(); data.runs = []; data.rate = null; });

/**
 * THE OTHER DECKS. Flows is the engine deck (an engineer and his helper), Tokens is the power
 * core (the reactor and the drone). Same rules as the bridge: drawn sheets only, and ONE LOOK
 * PER STATE — what the character is doing is what the records say.
 */
describe('the engineer (Flows)', () => {
  it('has one look per state — for every run status, with and without something waiting on you', () => {
    expect([...ENGINEER_ANIMS]).toEqual(['idle', 'work', 'call']);
    expect(engineerAnim([])).toBe('idle');
    for (const status of STATUSES) for (const waiting of [false, true]) {
      const anim = engineerAnim([run(status, { needsAttention: waiting ? { reason: 'x' } : null })]);
      const live = status === 'running' || status === 'paused';
      // A live run that needs you outranks everything; a running one is work; the rest is standing by.
      expect(anim, `${status}/${waiting}`).toBe(live && waiting ? 'call' : status === 'running' ? 'work' : 'idle');
    }
    // One run that needs you is enough, however many others are just running.
    expect(engineerAnim([run('running'), run('running'), run('paused', { needsAttention: { reason: 'x' } })])).toBe('call');
  });

  it('counts running, waiting on you, and finished today', () => {
    const now = new Date('2026-11-19T15:00:00').getTime();
    const runs = [
      run('running'), run('running', { needsAttention: { reason: 'x' } }), run('paused', { needsAttention: { reason: 'x' } }),
      run('completed', { completedAt: '2026-11-19T09:00:00' }), run('completed', { completedAt: '2026-11-18T23:00:00' }),
      run('failed', { completedAt: '2026-11-19T10:00:00' }), run('pending'), run('cancelled', { needsAttention: { reason: 'x' } }),
    ];
    expect(flowGauges(runs, now)).toEqual({ running: 2, waiting: 2, doneToday: 1 });
    expect(flowGauges([], now)).toEqual({ running: 0, waiting: 0, doneToday: 0 });
  });

  it('shows the state and the three readings on the page', async () => {
    data.runs = [run('running'), run('completed', { completedAt: new Date().toISOString() })];
    const post = render(<><EngineerPost /><FlowGauges /></>);
    await flush();
    expect(post.container.querySelector<HTMLElement>('[data-deck-state]')!.dataset.deckState).toBe('work');
    const read = [...post.container.querySelectorAll<HTMLElement>('[data-gauge]')].map((e) => `${e.dataset.gauge}=${e.querySelector('[data-gauge-value]')!.textContent}`);
    expect(read).toEqual(['running=1', 'waiting=0', 'done=1']);
  });
});

describe('the power core (Tokens)', () => {
  it('burns in step with the hourly rate, and warns when the quota is nearly gone — at and around every threshold', () => {
    expect([...CORE_LEVELS]).toEqual(['low', 'normal', 'high', 'warn']);
    for (const [rate, want] of [[0, 'low'], [CORE_AT.normal - 1, 'low'], [CORE_AT.normal, 'normal'], [CORE_AT.high - 1, 'normal'], [CORE_AT.high, 'high'], [CORE_AT.high * 50, 'high']] as const) {
      expect(coreLevel({ tokensPerHour: rate, warn: false }), String(rate)).toBe(want);
      expect(coreLevel({ tokensPerHour: rate, warn: true }), `${rate} + warning`).toBe('warn');
    }
  });

  it('reads the quota from the provider\'s own meter first, the local estimate second, and says nothing when there is neither', () => {
    const anchor = (over: Record<string, unknown>) => ({ provider: 'claude', window: 'weekly', pctUsed: 0.65, hoursToReset: 10, pace: 'ok', ...over });
    expect(quotaOf({ usageAnchor: [anchor({})], subscriptionUsage: [{ provider: 'claude', pctUsed: 20, daysRemaining: 3 }] })).toEqual({ pct: 65, resetsIn: '10h', warn: false });
    for (const [over, warn] of [[{ pace: 'watch' }, false], [{ pace: 'hold' }, true], [{ pctUsed: 0.9 }, true], [{ pctUsed: 0.84 }, false]] as const) {
      expect(quotaOf({ usageAnchor: [anchor(over)] })!.warn, JSON.stringify(over)).toBe(warn);
    }
    expect(quotaOf({ subscriptionUsage: [{ provider: 'claude', pctUsed: 91, daysRemaining: 2 }] })).toEqual({ pct: 91, resetsIn: '2.0d', warn: true });
    expect(quotaOf({ subscriptionUsage: [{ provider: 'claude', pctUsed: 40, daysRemaining: null }] })).toEqual({ pct: 40, resetsIn: null, warn: false });
    for (const none of [{}, { usageAnchor: [], subscriptionUsage: [] }, null]) expect(quotaOf(none)).toBeNull();
    expect([0, 999, 1500, 33_700_000, 808_700_000, 2_400_000_000].map(compactTokens)).toEqual(['0', '999', '1.5K', '33.7M', '808.7M', '2.4B']);
  });

  it('shows the rate, the quota tank and the readings — and nothing invented when the server has no answer', async () => {
    data.rate = { tokensPerHour: 33_700_000, tokensPerDay: 808_700_000, costPerDay: 412, activeCartridges: 5, samples: 10, usageAnchor: [{ provider: 'claude', window: 'weekly', pctUsed: 0.65, hoursToReset: 10, pace: 'ok' }] };
    const live = render(<><CorePost /><TokenGauges /></>);
    await flush();
    expect(live.container.querySelector<HTMLElement>('[data-deck-state]')!.dataset.deckState).toBe('high');
    expect(live.container.querySelector('[data-core-rate]')!.textContent).toBe('33.7M TOK / HR');
    const tank = live.container.querySelector<HTMLElement>('[data-quota-tank]')!;
    expect(tank.dataset.quotaTank).toBe('65');
    expect(tank.querySelector<HTMLElement>('[data-quota-fill]')!.style.height, 'the tank holds what is LEFT').toBe('35%');
    const read = [...live.container.querySelectorAll<HTMLElement>('[data-gauge]')].map((e) => `${e.dataset.gauge}=${e.querySelector('[data-gauge-value]')!.textContent}`);
    expect(read).toEqual(['day=808.7M', 'cost=$412', 'cartridges=5']);
    live.unmount();

    data.rate = null;
    const blank = render(<><CorePost /><TokenGauges /></>);
    await flush();
    expect(blank.container.querySelector<HTMLElement>('[data-deck-state]')!.dataset.deckState).toBe('low');
    expect(blank.container.querySelector('[data-core-rate]')!.textContent).toBe('NO READING');
    expect(blank.container.querySelector('[data-quota-tank]')).toBeNull();
    expect([...blank.container.querySelectorAll('[data-gauge-value]')].map((e) => e.textContent)).toEqual(['—', '—', '—']);
  });
});

describe('the quartermaster (Tasks)', () => {
  const TASK_STATUSES = ['queued', 'claimed', 'in_progress', 'done', 'failed', 'cancelled'] as const;
  const now = new Date('2026-11-19T15:00:00').getTime();
  const task = (status: (typeof TASK_STATUSES)[number], completedAt: string | null = null): Task => ({
    id: `t-${status}-${Math.random()}`, title: status, prompt: '', projectId: null, status, assignedAgentId: null,
    priority: 0, result: '', error: '', createdAt: '2026-11-19T08:00:00', claimedAt: null, completedAt,
  });

  it('has one look per state — for every task status, and a failure only while it is recent', () => {
    expect([...QUARTERMASTER_ANIMS]).toEqual(['idle', 'work', 'call']);
    expect(quartermasterAnim([], now)).toBe('idle');
    const recent = new Date(now - FAILED_RECENT_MS + 60_000).toISOString();
    const old = new Date(now - FAILED_RECENT_MS - 60_000).toISOString();
    const want: Record<(typeof TASK_STATUSES)[number], string> = { queued: 'idle', claimed: 'work', in_progress: 'work', done: 'idle', failed: 'call', cancelled: 'idle' };
    for (const status of TASK_STATUSES) expect(quartermasterAnim([task(status, recent)], now), status).toBe(want[status]);
    // A failure from long ago is history, not a call for you.
    expect(quartermasterAnim([task('failed', old)], now)).toBe('idle');
    expect(quartermasterAnim([task('failed', null)], now)).toBe('idle');
    // A fresh failure outranks work in progress.
    expect(quartermasterAnim([task('in_progress'), task('failed', recent)], now)).toBe('call');
  });

  it('counts what is queued, what is being worked, and what was finished today', () => {
    const tasks = [task('queued'), task('queued'), task('claimed'), task('in_progress'), task('done', '2026-11-19T09:00:00'), task('done', '2026-11-18T23:00:00'), task('failed', '2026-11-19T10:00:00'), task('cancelled', '2026-11-19T10:00:00')];
    expect(taskGauges(tasks, now)).toEqual({ queued: 2, active: 2, doneToday: 1 });
    expect(taskGauges([], now)).toEqual({ queued: 0, active: 0, doneToday: 0 });
  });

  it('shows the state and the three readings on the page', () => {
    const tasks = [task('queued'), task('in_progress'), task('done', new Date().toISOString())];
    const post = render(<><QuartermasterPost tasks={tasks} /><TaskGauges tasks={tasks} /></>);
    expect(post.container.querySelector<HTMLElement>('[data-deck-state]')!.dataset.deckState).toBe('work');
    const read = [...post.container.querySelectorAll<HTMLElement>('[data-gauge]')].map((e) => `${e.dataset.gauge}=${e.querySelector('[data-gauge-value]')!.textContent}`);
    expect(read).toEqual(['queued=1', 'active=1', 'done=1']);
  });
});

describe('every deck', () => {
  it.each(DECK_VIEWS.map((v) => ({ v })))('$v: is inside the .bridge scope, and its figure is a drawn sheet or nothing', async ({ v }) => {
    expect(deckProps(v).className).toBe('bridge');
    const sheetName = { projects: 'captain', workflows: 'engineer', tokens: 'core', tasks: 'quartermaster' }[v];
    const sheet = DECK_ART.sheets[sheetName];
    if (sheet) {
      expect(deckProps(v).style?.backgroundImage ?? '').toContain('/world/bridge/');
      for (const r of Object.values(sheet.rows)) expect(r.frames).toBeGreaterThanOrEqual(2);
    }
    const view = render(<><EngineerPost /><CorePost /><QuartermasterPost tasks={[]} /></>);
    await flush();
    expect(view.container.querySelectorAll('svg, canvas')).toHaveLength(0);
    for (const fig of view.container.querySelectorAll<HTMLElement>('[data-deck-sprite] > div')) expect(fig.style.backgroundImage).toMatch(/\/world\/bridge\/[a-z]+\.png/);
  });
});
