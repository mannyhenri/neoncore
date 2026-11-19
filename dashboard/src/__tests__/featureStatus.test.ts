import { describe, it, expect } from 'vitest';
import { featureStatus, nextUp, anyInFlight, TONE_PILL, TONE_DOT, type FeatureTone } from '../lib/featureStatus';

/**
 * Every pilot phase maps to a row label, a tone and a next action (V6 drop). Set-based over the
 * phases the server reports, so a new phase without a mapping falls through visibly.
 */
type G = Parameters<typeof featureStatus>[0];
const pilot = (phase: string, extra: Record<string, unknown> = {}) =>
  ({ status: 'active', health: null, pilot: { phase, stagesDone: 1, stagesTotal: 4, ...extra } }) as unknown as G;

const CASES: { name: string; goal: G; key: string; needsYou: boolean }[] = [
  { name: 'never started', goal: { status: 'active', health: null, pilot: null } as unknown as G, key: 'backlog', needsYou: false },
  { name: 'achieved', goal: { status: 'achieved', health: null, pilot: null } as unknown as G, key: 'done', needsYou: false },
  { name: 'scoping', goal: pilot('scoping'), key: 'thinking', needsYou: false },
  { name: 'planner failed', goal: pilot('planning', { plannerFailed: true }), key: 'stuck', needsYou: true },
  { name: 'clarifying', goal: pilot('clarifying'), key: 'questions', needsYou: true },
  { name: 'proposed', goal: pilot('proposed'), key: 'plan', needsYou: true },
  { name: 'staffing', goal: pilot('staffing'), key: 'repos', needsYou: true },
  { name: 'running', goal: pilot('running'), key: 'running', needsYou: false },
  { name: 'running, awaiting review', goal: pilot('running', { awaitingReview: true }), key: 'review', needsYou: true },
  { name: 'paused', goal: pilot('paused'), key: 'paused', needsYou: true },
  { name: 'completed', goal: pilot('completed'), key: 'finished', needsYou: true },
  { name: 'cancelled', goal: pilot('cancelled'), key: 'cancelled', needsYou: false },
];

describe('featureStatus', () => {
  it.each(CASES)('$name → $key', ({ goal, key, needsYou }) => {
    const s = featureStatus(goal);
    expect(s.key).toBe(key);
    expect(s.needsYou).toBe(needsYou);
    expect(s.label.length).toBeGreaterThan(0);
    expect(s.action.length).toBeGreaterThan(0);
  });

  it('running shows stage progress as a fraction and in its label', () => {
    const s = featureStatus(pilot('running'));
    expect(s.progress).toBe(0.25);
    expect(s.label).toBe('Running · 1/4');
  });

  it('every tone has a Night Glass pill and dot (no old purple)', () => {
    for (const t of ['idle', 'working', 'you', 'bad', 'done'] as FeatureTone[]) {
      expect(TONE_PILL[t]).toBeTruthy();
      expect(TONE_DOT[t]).toBeTruthy();
    }
    expect(TONE_PILL.you).toMatch(/ember/);
    expect(TONE_PILL.working).toMatch(/neon/);
  });

  it('nextUp is the first feature not started; anyInFlight ignores backlog, done and cancelled', () => {
    const list = [CASES[1].goal, pilot('cancelled'), CASES[0].goal, pilot('running')];
    expect(nextUp(list)).toBe(CASES[0].goal);
    expect(anyInFlight([CASES[0].goal, CASES[1].goal, pilot('cancelled')])).toBe(false);
    expect(anyInFlight([CASES[0].goal, pilot('clarifying')])).toBe(true);
  });
});
