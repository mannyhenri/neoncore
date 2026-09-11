import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCheckpoint, anchorFromCheckpoints, tokensPerPercent, windowStartOf,
  USAGE_WINDOWS, WINDOW_LENGTH_MS, HOLD_HORIZON_HOURS, type UsageCheckpoint, type Pace,
} from '../src/lib/usage-checkpoint.js';

/**
 * The gauge anchored on what the provider actually said.
 *
 * REPORTED: "would it help to add my current claude usage at any point and then neoncore could
 * adjust based on a bunch of calculations". A checkpoint is the provider's own percentage and
 * reset time, typed in by the person who saw it. Everything here is what can honestly be
 * derived from one or two of those plus the fleet's local token count — and what cannot.
 *
 * SET-BASED over the shapes a checkpoint history can take, because each shape changes what
 * may be claimed: one reading (carry its pace), two readings (measure the exchange rate),
 * a reading whose reset has passed (roll over only if the rate is known), and none.
 */
const H = 3_600_000, D = 24 * H;
const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const PROVIDERS = ['claude', 'codex'] as const;

let n = 0;
const cp = (over: Partial<UsageCheckpoint>): UsageCheckpoint => ({
  id: `c${++n}`, provider: 'claude', window: 'weekly', pctUsed: 0.5,
  resetsAt: new Date(NOW + 3 * D).toISOString(), observedAt: new Date(NOW - 1 * D).toISOString(),
  localTokens: 1_000_000, ...over,
});

// ── validation: every way the input can be wrong ────────────────────────────────────────
test('validateCheckpoint: accepts every window and provider, and names each rejection', () => {
  for (const provider of PROVIDERS) {
    for (const window of USAGE_WINDOWS) {
      const r = validateCheckpoint(
        { provider, window, pctUsed: 62, resetsAt: new Date(NOW + WINDOW_LENGTH_MS[window] / 2).toISOString() },
        PROVIDERS, NOW,
      );
      assert.ok(r.ok, `${provider}/${window}: ${!r.ok && r.error}`);
      if (r.ok) assert.equal(r.value.pctUsed, 0.62, 'percent is stored as a fraction');
    }
  }
  const BAD: { label: string; input: Record<string, unknown>; mentions: RegExp }[] = [
    { label: 'unknown provider', input: { provider: 'gemini', pctUsed: 10, resetsAt: new Date(NOW + D).toISOString() }, mentions: /provider/ },
    { label: 'unknown window', input: { provider: 'claude', window: 'monthly', pctUsed: 10, resetsAt: new Date(NOW + D).toISOString() }, mentions: /window/ },
    { label: 'percent over 100', input: { provider: 'claude', pctUsed: 140, resetsAt: new Date(NOW + D).toISOString() }, mentions: /pctUsed/ },
    { label: 'percent not a number', input: { provider: 'claude', pctUsed: 'lots', resetsAt: new Date(NOW + D).toISOString() }, mentions: /pctUsed/ },
    { label: 'reset in the past', input: { provider: 'claude', pctUsed: 10, resetsAt: new Date(NOW - H).toISOString() }, mentions: /resetsAt/ },
    { label: 'reset further away than the window', input: { provider: 'claude', pctUsed: 10, resetsAt: new Date(NOW + 9 * D).toISOString() }, mentions: /window/ },
    { label: 'session reset further away than five hours', input: { provider: 'claude', window: 'session', pctUsed: 10, resetsAt: new Date(NOW + 7 * H).toISOString() }, mentions: /window/ },
    { label: 'observed in the future', input: { provider: 'claude', pctUsed: 10, resetsAt: new Date(NOW + D).toISOString(), observedAt: new Date(NOW + H).toISOString() }, mentions: /observedAt/ },
  ];
  const wrong: string[] = [];
  for (const b of BAD) {
    const r = validateCheckpoint(b.input, PROVIDERS, NOW);
    if (r.ok) wrong.push(`${b.label}: accepted`);
    else if (!b.mentions.test(r.error)) wrong.push(`${b.label}: error does not name the field — "${r.error}"`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

// ── the exchange rate ──────────────────────────────────────────────────────────────────
test('tokensPerPercent: measured only from two readings in the same window that both moved', () => {
  const reset = new Date(NOW + 3 * D).toISOString();
  const a = cp({ pctUsed: 0.20, localTokens: 2_000_000, observedAt: new Date(NOW - 2 * D).toISOString(), resetsAt: reset });
  const b = cp({ pctUsed: 0.50, localTokens: 5_000_000, observedAt: new Date(NOW - 1 * D).toISOString(), resetsAt: reset });
  assert.equal(tokensPerPercent([b, a]), 100_000, 'order must not matter; 3M tokens over 30 points');

  const lastWeek = cp({ pctUsed: 0.9, localTokens: 9_000_000, observedAt: new Date(NOW - 9 * D).toISOString(), resetsAt: new Date(NOW - 4 * D).toISOString() });
  assert.equal(tokensPerPercent([lastWeek, a]), null, 'readings from different windows do not make a rate');
  assert.equal(tokensPerPercent([a]), null, 'one reading is not a rate');
  const typo = cp({ pctUsed: 0.10, localTokens: 6_000_000, observedAt: new Date(NOW - 12 * H).toISOString(), resetsAt: reset });
  assert.equal(tokensPerPercent([a, b, typo]), 100_000, 'a reading that went DOWN is skipped, not averaged in');
});

// ── the anchor, over every history shape ───────────────────────────────────────────────
interface Shape {
  label: string;
  checkpoints: UsageCheckpoint[];
  sinceLatest: number;
  sinceReset: number;
  want: null | { basis: 'checkpoint' | 'rollover'; pct: [number, number]; pace: Pace; wallBeforeReset: boolean; samples: number; rate: number | null };
}
const reset = new Date(NOW + 3 * D).toISOString();          // window started 4 days ago
const SHAPES: Shape[] = [
  { label: 'no checkpoints', checkpoints: [], sinceLatest: 0, sinceReset: 0, want: null },
  {
    label: 'one reading, carried at its own pace',
    // 40% after 3 days → 13.3%/day → now (4 days in) ≈ 53%; wall in 84h, reset in 72h → reset first → ok
    checkpoints: [cp({ pctUsed: 0.40, observedAt: new Date(NOW - D).toISOString(), resetsAt: reset })],
    sinceLatest: 999_999, sinceReset: 0,
    want: { basis: 'checkpoint', pct: [0.52, 0.55], pace: 'ok', wallBeforeReset: false, samples: 1, rate: null },
  },
  {
    label: 'two readings: the measured rate moves the gauge with local tokens',
    // 20% → 50% over 3M tokens = 100k tokens per point; 1M since → +10 points = 60%
    checkpoints: [
      cp({ pctUsed: 0.20, localTokens: 2_000_000, observedAt: new Date(NOW - 2 * D).toISOString(), resetsAt: reset }),
      cp({ pctUsed: 0.50, localTokens: 5_000_000, observedAt: new Date(NOW - 1 * D).toISOString(), resetsAt: reset }),
    ],
    sinceLatest: 1_000_000, sinceReset: 0,
    // pace = 30 points/day → wall in (40/30)*24 = 32h, reset in 72h → wall first but beyond 24h → watch
    want: { basis: 'checkpoint', pct: [0.60, 0.60], pace: 'watch', wallBeforeReset: true, samples: 2, rate: 100_000 },
  },
  {
    label: 'comfortable: slow pace, reset comes first',
    // 10% after 3 days ≈ 3.3%/day → now ≈ 13%, wall in ~26d, reset in 3d → ok
    checkpoints: [cp({ pctUsed: 0.10, observedAt: new Date(NOW - D).toISOString(), resetsAt: reset })],
    sinceLatest: 0, sinceReset: 0,
    want: { basis: 'checkpoint', pct: [0.12, 0.14], pace: 'ok', wallBeforeReset: false, samples: 1, rate: null },
  },
  {
    label: 'wall within the hold horizon',
    // 90% read an hour ago after ~4 days → ~22.5%/day → wall in ~10h → hold
    checkpoints: [cp({ pctUsed: 0.90, observedAt: new Date(NOW - H).toISOString(), resetsAt: reset })],
    sinceLatest: 0, sinceReset: 0,
    want: { basis: 'checkpoint', pct: [0.90, 0.92], pace: 'hold', wallBeforeReset: true, samples: 1, rate: null },
  },
  {
    label: 'already at 100%: hold until the reset',
    checkpoints: [cp({ pctUsed: 1.0, observedAt: new Date(NOW - H).toISOString(), resetsAt: reset })],
    sinceLatest: 0, sinceReset: 0,
    want: { basis: 'checkpoint', pct: [1.0, 1.03], pace: 'hold', wallBeforeReset: true, samples: 1, rate: null },
  },
  {
    label: 'reset passed, rate known: the new window is projected from local tokens alone',
    checkpoints: [
      cp({ pctUsed: 0.20, localTokens: 2_000_000, observedAt: new Date(NOW - 6 * D).toISOString(), resetsAt: new Date(NOW - 2 * D).toISOString() }),
      cp({ pctUsed: 0.50, localTokens: 5_000_000, observedAt: new Date(NOW - 5 * D).toISOString(), resetsAt: new Date(NOW - 2 * D).toISOString() }),
    ],
    sinceLatest: 9_000_000, sinceReset: 3_000_000,          // 3M since reset at 100k/pt = 30%
    // 30% two days into a seven-day window is 105% by the reset: wall in 112h, reset in 120h → watch
    want: { basis: 'rollover', pct: [0.30, 0.30], pace: 'watch', wallBeforeReset: true, samples: 0, rate: 100_000 },
  },
  {
    label: 'reset passed, no rate: nothing honest to say — ask for a fresh reading',
    checkpoints: [cp({ pctUsed: 0.70, observedAt: new Date(NOW - 6 * D).toISOString(), resetsAt: new Date(NOW - 2 * D).toISOString() })],
    sinceLatest: 9_000_000, sinceReset: 3_000_000,
    want: null,
  },
];

test('anchorFromCheckpoints: every history shape yields the projection it can honestly support', () => {
  const wrong: string[] = [];
  for (const s of SHAPES) {
    const got = anchorFromCheckpoints({ checkpoints: s.checkpoints, window: 'weekly', localTokensSinceLatest: s.sinceLatest, localTokensSinceReset: s.sinceReset, now: NOW });
    if (s.want === null) { if (got !== null) wrong.push(`${s.label}: expected null, got ${JSON.stringify(got)}`); continue; }
    if (got === null) { wrong.push(`${s.label}: expected an anchor, got null`); continue; }
    const w = s.want;
    if (got.basis !== w.basis) wrong.push(`${s.label}: basis ${got.basis} ≠ ${w.basis}`);
    if (got.pctUsed < w.pct[0] - 1e-9 || got.pctUsed > w.pct[1] + 1e-9) wrong.push(`${s.label}: pct ${got.pctUsed.toFixed(3)} outside [${w.pct}]`);
    if (got.pace !== w.pace) wrong.push(`${s.label}: pace ${got.pace} ≠ ${w.pace} (wall ${got.hoursToWall}h, reset ${got.hoursToReset}h)`);
    if (got.hitsWallBeforeReset !== w.wallBeforeReset) wrong.push(`${s.label}: hitsWallBeforeReset ${got.hitsWallBeforeReset}`);
    if (got.samples !== w.samples) wrong.push(`${s.label}: samples ${got.samples} ≠ ${w.samples}`);
    if (got.tokensPerPct !== w.rate) wrong.push(`${s.label}: tokensPerPct ${got.tokensPerPct} ≠ ${w.rate}`);
    if (!got.recommendation || !/%/.test(got.recommendation)) wrong.push(`${s.label}: no readable recommendation`);
    if (got.hoursToReset < 0 || (got.hoursToWall !== null && got.hoursToWall < 0)) wrong.push(`${s.label}: a negative countdown`);
    for (const [k, v] of Object.entries(got)) if (typeof v === 'number' && !Number.isFinite(v)) wrong.push(`${s.label}: ${k} is ${v}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the session window is its own anchor and never borrows the weekly one', () => {
  const weekly = cp({ pctUsed: 0.5, observedAt: new Date(NOW - D).toISOString(), resetsAt: reset });
  const session = cp({ window: 'session', pctUsed: 0.8, observedAt: new Date(NOW - H).toISOString(), resetsAt: new Date(NOW + 2 * H).toISOString() });
  const s = anchorFromCheckpoints({ checkpoints: [weekly, session], window: 'session', localTokensSinceLatest: 0, localTokensSinceReset: 0, now: NOW });
  assert.ok(s && s.window === 'session' && s.pctAtCheckpoint === 0.8, JSON.stringify(s));
  assert.ok(s!.hoursToReset > 1.9 && s!.hoursToReset < 2.1);
  assert.equal(windowStartOf(session), NOW - 3 * H, 'a session window is five hours long');
  assert.equal(HOLD_HORIZON_HOURS, 24);
});
