/**
 * The reporting chart must not lie about WHEN, and must not lose tokens to bucketing.
 *
 * The point of this page is comparison across time: you change how you work and you want to
 * see the line move. That only means anything if every bucket covers the same amount of time
 * as every other, if nothing falls between two buckets, and if the charted total still equals
 * the number the header badge shows for the same window. A bucketing bug does not look like a
 * bug — it looks like a change in your spending, which is precisely the signal being read.
 *
 * SET-BASED OVER granularity x range, iterating BUCKETS from the lib rather than naming
 * 'hour'/'day'/'week' here. An example test on 'day' passes while the week bucket silently
 * floors to Sunday in one place and Monday in another, and the 6-month view — the one that
 * exists to show a slow trend — is exactly where nobody would notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUCKETS, BUCKET_MS, bucketStart, buildSeries, type Bucket } from '../src/lib/usage-series.ts';
import type { UsageSample } from '../src/lib/burn-rate.ts';

/** THE OTHER SET: the ranges the page offers. */
const RANGES: { label: string; days: number }[] = [
  { label: 'last week', days: 7 },
  { label: 'last month', days: 30 },
  { label: 'last 6 months', days: 182 },
];

const TO = Date.parse('2026-09-04T15:00:00.000Z');

function rowAt(iso: string, tokens = 100): UsageSample {
  return {
    input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    model: 'claude-opus-5', recorded_at: iso,
  };
}

/** Deterministic spread of rows across the whole window, so every bucket type sees data. */
function rowsAcross(days: number, n: number): UsageSample[] {
  const from = TO - days * 86_400_000;
  return Array.from({ length: n }, (_, i) =>
    rowAt(new Date(from + Math.floor(((i + 0.5) * (days * 86_400_000)) / n)).toISOString(), 10),
  );
}

test('buckets tile the window — equal width, no gap, no overlap', () => {
  const failures: string[] = [];

  for (const bucket of BUCKETS) {
    for (const { label, days } of RANGES) {
      const from = TO - days * 86_400_000;
      const series = buildSeries([], bucket, from, TO);

      if (series.length < 2) { failures.push(`${bucket}/${label}: only ${series.length} buckets`); continue; }

      for (let i = 1; i < series.length; i++) {
        const gap = Date.parse(series[i].t) - Date.parse(series[i - 1].t);
        if (gap !== BUCKET_MS[bucket]) {
          failures.push(`${bucket}/${label}: bucket ${i} is ${gap}ms after the previous, expected ${BUCKET_MS[bucket]}ms`);
          break;
        }
      }

      // The left edge must contain the requested start, not begin after it.
      if (Date.parse(series[0].t) !== bucketStart(from, bucket)) {
        failures.push(`${bucket}/${label}: first bucket ${series[0].t} does not contain the window start`);
      }
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('the charted total equals the unbucketed total, for every granularity and range', () => {
  // The invariant that catches a half-done bucketing: tokens dropped between buckets, or
  // double-counted at a boundary, change the shape of the chart without changing its type.
  const failures: string[] = [];

  for (const { label, days } of RANGES) {
    const rows = rowsAcross(days, 500);
    const from = TO - days * 86_400_000;
    const want = rows.length * 10;

    for (const bucket of BUCKETS) {
      const series = buildSeries(rows, bucket, from, TO);
      const got = series.reduce((s, p) => s + p.tokens, 0);
      const samples = series.reduce((s, p) => s + p.samples, 0);
      if (got !== want) failures.push(`${bucket}/${label}: charted ${got} tokens, rows hold ${want}`);
      if (samples !== rows.length) failures.push(`${bucket}/${label}: charted ${samples} samples, rows hold ${rows.length}`);
    }
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('a quiet stretch is a zero, not a missing point', () => {
  // A chart that omits empty buckets joins the neighbours and draws an idle weekend as a
  // straight line at working height — the opposite of what the reader concludes.
  const from = TO - 7 * 86_400_000;
  const series = buildSeries([rowAt(new Date(TO - 3600_000).toISOString(), 50)], 'day', from, TO);

  assert.ok(series.length >= 7, `expected ~8 daily buckets, got ${series.length}`);
  const zeros = series.filter((p) => p.tokens === 0);
  assert.ok(zeros.length >= 6, `expected the empty days to be present as zeros, got ${zeros.length}`);
  assert.equal(series.reduce((s, p) => s + p.tokens, 0), 50);
});

test('weeks floor to Monday, in every bucket helper that touches them', () => {
  // Monday, not "seven days back from now": a rolling cut re-shapes the same week on every
  // reload, so two views of one window disagree about what a week was.
  const thursday = Date.parse('2026-09-03T12:00:00.000Z');
  const monday = Date.parse('2026-08-31T00:00:00.000Z');
  assert.equal(bucketStart(thursday, 'week'), monday);

  // And it is stable: any instant inside that week floors to the same Monday.
  for (let h = 0; h < 24 * 7; h++) {
    assert.equal(bucketStart(monday + h * 3600_000, 'week'), monday, `hour ${h} of the week drifted`);
  }
});

test('rows outside the window and rows with a bad timestamp are dropped, not counted', () => {
  const from = TO - 7 * 86_400_000;
  const series = buildSeries(
    [
      rowAt(new Date(TO - 3600_000).toISOString(), 10),   // inside
      rowAt(new Date(from - 86_400_000).toISOString(), 999), // before the window
      rowAt('not-a-date', 999),                            // unparseable
    ],
    'day', from, TO,
  );
  assert.equal(series.reduce((s, p) => s + p.tokens, 0), 10);
  for (const p of series) assert.ok(Number.isFinite(p.tokens) && Number.isFinite(p.costUsd), `${p.t} was NaN`);
});

/**
 * ── EVERY DIMENSION THE REPORT EXPOSES MUST BE REACHABLE ────────────────────────────────
 *
 * REPORTED, from the phone: "on the ios app in the metrics/report tool ... tap on any items
 * and get more details, like for example tokens by project I can't really see them".
 *
 * Two different defects sit behind that one sentence, and only one is a UI problem:
 *
 *   byCartridge EXISTS and is rendered, but as a static bar list — nothing to tap.
 *   byProject DOES NOT EXIST AT ALL. There is no project dimension anywhere in the response,
 *   so no client could show it however it was written.
 *
 * A cartridge is not a project: 13 cartridges span 11 repos, and the ones that share a repo
 * are exactly the ones you want summed. `session_usage` carries only agent_id, so the grouping
 * is a JOIN to agents.repo_name — cheap on the server, and impossible on the phone without
 * shipping the whole agent roster alongside every report.
 *
 * SET-BASED over the dimensions the route promises rather than asserting byProject alone: a
 * report is a contract of dimensions, and the next one added would otherwise ship unrendered
 * exactly as this one shipped unreachable.
 */
const DIMENSIONS = ['series', 'total', 'byCartridge', 'byProject'] as const;

test('the usage report exposes EVERY dimension it claims', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'routes', 'activity.ts'), 'utf8',
  );
  // The response literal, not the whole file: a dimension named only in a comment is not served.
  const body = src.slice(src.indexOf("res.json({\n    bucket, days,"));
  const payload = body.slice(0, body.indexOf('});'));
  assert.ok(payload.length > 40, 'could not locate the usage-series response literal — scanner broken');

  const missing = DIMENSIONS.filter((d) => !new RegExp(`\\b${d}\\b`).test(payload));
  assert.deepEqual(missing, [],
    `usage-series does not return: ${missing.join(', ')} — the phone cannot render a dimension the server never sends`);
});

test('byProject groups by REPO, not by cartridge — the two are not the same', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'routes', 'activity.ts'), 'utf8',
  );
  const q = src.slice(src.indexOf('const byProject'), src.indexOf('const byProject') + 600);
  assert.ok(/repo_name/.test(q), 'byProject must join agents.repo_name — agent_id alone is a cartridge, not a project');
  assert.ok(/GROUP BY/i.test(q), 'byProject must aggregate, or it is just the cartridge list renamed');
});

/**
 * ── A DIMENSION MUST REACH EVERY SURFACE, NOT WHICHEVER ONE WAS BEING WORKED ON ─────────
 *
 * I added `byProject` to this route to answer a request made from the phone, wired it into
 * TokensScreen, and shipped. The dashboard's TokensPage renders `byCartridge` and knows
 * nothing about it — a dimension exists on the server and appears on exactly one of the two
 * surfaces that read it. That is the same defect class as the 105 capabilities missing from
 * iOS, created fresh, in the session that diagnosed it.
 *
 * Set-based over dimensions x surfaces, because the failure is never the dimension you are
 * thinking about — it is the surface you are not.
 */
const SURFACES = [
  { name: 'dashboard', file: '../dashboard/src/components/TokensPage.tsx' },
  { name: 'mobile', file: '../mobile/src/screens/TokensScreen.tsx' },
  { name: 'shared client type', file: '../packages/client/src/client.ts' },
] as const;

test('EVERY dimension reaches EVERY surface that reads this report', () => {
  const gaps: string[] = [];
  for (const s of SURFACES) {
    const p = path.join(import.meta.dirname, '..', s.file);
    assert.ok(fs.existsSync(p), `${s.name}: ${s.file} not found — scanner broken`);
    const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const d of DIMENSIONS) {
      if (!new RegExp(`\\b${d}\\b`).test(src)) gaps.push(`${s.name} never reads ${d}`);
    }
  }
  assert.deepEqual(gaps, [],
    `a dimension the server sends that a surface cannot show:\n  ${gaps.join('\n  ')}`);
});

test('byProject SUMS across servers — the same repo exists on more than one machine', () => {
  // byCartridge concatenates, correctly: a cartridge belongs to one server. A PROJECT does not.
  // film-engine runs on both machines, and concatenating would list it twice and halve every
  // share — the one merge rule where copying the cartridge line would be wrong.
  const merge = fs.readFileSync(
    path.join(import.meta.dirname, '..', '../dashboard/src/lib/usageSeries.ts'), 'utf8');
  assert.match(merge, /byProject/, 'the federated merge drops byProject entirely');
  const block = merge.slice(merge.indexOf('byProject'));
  assert.ok(!/byProject:\s*ok\.flatMap\([^)]*\)\.sort/.test(block.slice(0, 200)),
    'byProject is concatenated like byCartridge — the same project on two servers would appear twice');
});
