import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeView, engineView, cargoView, coreView, DECK_FIGURES } from '../world/deckLogic';
import type { Goal } from '../types';
import type { BurnRate } from '../api';

/**
 * THE DECK FIGURES ON THE PHONE: one look per state, the same looks as the dashboard, and never
 * a look the art has no row for.
 *
 * No renderer in this suite, so what is asserted is the logic (every state of every deck) and
 * the art (every look a deck can take is a drawn row of a bundled sheet).
 */
const ROOT = path.join(import.meta.dirname, '..', '..');
const GEN = fs.readFileSync(path.join(ROOT, 'src/world/art.generated.ts'), 'utf8');
const NOW = new Date('2026-11-20T15:00:00Z').getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const goal = (over: Record<string, unknown>) => ({ id: 'g', name: 'G', status: 'active', health: null, targetDate: '', progress: null, ...over }) as unknown as Goal;

describe('deck figures', () => {
  it.each(Object.entries(DECK_FIGURES).map(([deck, f]) => ({ deck, ...f })))('$deck: its sheet is bundled and has a drawn row for every look it can take', ({ sheet, anims }) => {
    const entry = GEN.match(new RegExp(`\\n  ${sheet}: \\{ source: require\\('\\.\\./\\.\\./(assets/world/decks/${sheet}\\.png)'\\), frameW: ([\\d.]+), frameH: ([\\d.]+), cols: (\\d+), rowCount: (\\d+), rows: \\{ (.*?) \\} \\},`));
    expect(entry, `${sheet} is not in art.generated.ts`).not.toBeNull();
    expect(fs.existsSync(path.join(ROOT, entry![1]))).toBe(true);
    const rows = Object.fromEntries([...entry![6].matchAll(/(\w+): \{ row: (\d+), frames: (\d+) \}/g)].map((m) => [m[1], { row: Number(m[2]), frames: Number(m[3]) }]));
    for (const a of anims) {
      expect(rows[a], `${sheet} has no "${a}" row`).toBeDefined();
      expect(rows[a].row).toBeLessThan(Number(entry![5]));
      expect(rows[a].frames).toBeGreaterThan(0);
      expect(rows[a].frames).toBeLessThanOrEqual(Number(entry![4]));
    }
  });

  it('the captain: needs-you outranks a late date, which outranks under way, which outranks idle', () => {
    const cases: [string, Goal[], string, string][] = [
      ['no goals', [], 'idle', 'quiet'],
      ['only achieved goals', [goal({ status: 'achieved' })], 'idle', 'quiet'],
      ['a goal under way', [goal({})], 'log', 'live'],
      ['a late goal', [goal({ schedule: { targetDate: '2020-01-01', state: 'overdue', detail: '' } })], 'worry', 'ember'],
      ['a blocked goal', [goal({ health: { reason: 'decision', blockedRuns: 1 } })], 'call', 'ember'],
      ['blocked AND late', [goal({ schedule: { targetDate: '2020-01-01', state: 'overdue', detail: '' } }), goal({ health: { reason: 'failed', blockedRuns: 2 } })], 'call', 'ember'],
    ];
    for (const [label, goals, anim, tone] of cases) {
      const v = bridgeView(goals);
      expect([v.anim, v.tone], label).toEqual([anim, tone]);
      expect(DECK_FIGURES.bridge.anims, label).toContain(v.anim);
      expect(v.readouts).toHaveLength(3);
      expect(v.readouts[0].value).toBe(String(goals.length));
    }
  });

  it('the engineer: a run that needs you outranks a running one', () => {
    const run = (status: string, extra: Record<string, unknown> = {}) => ({ status, completedAt: null, ...extra }) as Parameters<typeof engineView>[0][number];
    const cases: [string, ReturnType<typeof run>[], string, [string, string, string]][] = [
      ['nothing', [], 'idle', ['0', '0', '0']],
      ['one running', [run('running')], 'work', ['1', '0', '0']],
      ['one running, one waiting on you', [run('running'), run('paused', { needsAttention: { reason: 'decision' } })], 'call', ['1', '1', '0']],
      ['finished today and long ago', [run('completed', { completedAt: iso(60_000) }), run('completed', { completedAt: iso(5 * 86_400_000) })], 'idle', ['0', '0', '1']],
      ['a finished run that once needed you', [run('completed', { needsAttention: { reason: 'x' }, completedAt: iso(60_000) })], 'idle', ['0', '0', '1']],
    ];
    for (const [label, runs, anim, values] of cases) {
      const v = engineView(runs, NOW);
      expect(v.anim, label).toBe(anim);
      expect(v.readouts.map((r) => r.value), label).toEqual(values);
      expect(DECK_FIGURES.engine.anims).toContain(v.anim);
    }
  });

  it('the quartermaster: a fresh failure calls, an old one does not', () => {
    const t = (status: string, completedAt: string | null = null) => ({ status, completedAt }) as Parameters<typeof cargoView>[0][number];
    const cases: [string, ReturnType<typeof t>[], string][] = [
      ['nothing', [], 'idle'],
      ['queued only', [t('queued')], 'idle'],
      ['one in progress', [t('in_progress'), t('queued')], 'work'],
      ['failed an hour ago', [t('failed', iso(3_600_000)), t('in_progress')], 'call'],
      ['failed yesterday', [t('failed', iso(30 * 3_600_000)), t('claimed')], 'work'],
    ];
    for (const [label, tasks, anim] of cases) {
      const v = cargoView(tasks, NOW);
      expect(v.anim, label).toBe(anim);
      expect(DECK_FIGURES.cargo.anims).toContain(v.anim);
    }
  });

  it('the core: no reading is low, the burn steps it up, and a nearly spent quota warns over everything', () => {
    const burn = (tokensPerHour: number, extra: Record<string, unknown> = {}) => ({ tokensPerHour, tokensPerDay: 0, costPerDay: 0, activeCartridges: 1, days: 7, ...extra }) as unknown as BurnRate;
    const cases: [string, BurnRate | null, string, string][] = [
      ['no reading', null, 'low', 'No reading'],
      ['a trickle', burn(50_000), 'low', '50.0K tokens / hour'],
      ['normal', burn(2_000_000), 'normal', '2.0M tokens / hour'],
      ['high', burn(34_000_000), 'high', '34.0M tokens / hour'],
      ['quota nearly gone', burn(34_000_000, { usageAnchor: [{ provider: 'claude', window: 'weekly', pctUsed: 0.9, hoursToReset: 5, pace: 'watch' }] }), 'warn', 'Quota 90% used'],
      ['the provider says hold', burn(10, { usageAnchor: [{ provider: 'claude', window: 'weekly', pctUsed: 0.4, hoursToReset: 5, pace: 'hold' }] }), 'warn', 'Quota 40% used'],
    ];
    for (const [label, b, anim, line] of cases) {
      const v = coreView(b);
      expect([v.anim, v.line], label).toEqual([anim, line]);
      expect(DECK_FIGURES.core.anims).toContain(v.anim);
    }
  });

  it('every screen with a deck shows its post', () => {
    const screens: [string, string][] = [['GoalsScreen', 'BridgePost'], ['WorkflowsScreen', 'EnginePost'], ['TasksScreen', 'CargoPost'], ['TokensScreen', 'CorePost']];
    for (const [screen, post] of screens) {
      const src = fs.readFileSync(path.join(ROOT, 'src/screens', `${screen}.tsx`), 'utf8');
      expect(src, `${screen} does not render <${post}>`).toMatch(new RegExp(`<${post}\\b`));
    }
  });
});
