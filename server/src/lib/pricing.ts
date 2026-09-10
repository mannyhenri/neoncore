/**
 * Per-model token pricing (USD per 1M tokens) and cost computation.
 *
 * Matched by case-insensitive substring on the model id (e.g. "claude-opus-4-8"
 * matches "opus"). Cache-read is ~0.1x input; cache-write (5m TTL) ~1.25x input.
 * Keep this in sync with platform.claude.com/pricing as new tiers ship.
 *
 * SPECIFICITY: THE LONGEST MATCHING PATTERN WINS (GAS-002). A family can split — Sonnet 5 is
 * $2/$10 while Sonnet 4.6 is $3/$15 — and a single `sonnet` entry then misprices whichever
 * sibling it does not describe by ~50%. First-match-wins made that silent and order-dependent.
 * Longest-match keeps the substring ergonomics (an unprefixed `opus`, or a version this table
 * has never seen, still resolves to its family) while letting a more specific entry override
 * a broader one. To split a family, add the narrower pattern; order in the array is no longer
 * load-bearing.
 */
interface Tier {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Rate extends Tier {
  match: string;
  /**
   * Fast mode, where the model has it (GAS-014). Opus fast bills $10/$50 per MTok against a
   * standard $5/$25, so a fast turn priced as standard is HALF its true cost — and understated
   * burn overstates headroom, which is the failure direction this gauge exists to avoid.
   *
   * Input and output are published. The cache multipliers are NOT, so they are derived on the
   * same 0.1x / 1.25x convention this table uses everywhere else — an inference, recorded as
   * one. Fast mode exists on Opus only; no other family gets an invented fast rate.
   */
  fast?: Tier;
}

const RATES: Rate[] = [
  { match: 'fable', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  { match: 'opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
    fast: { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 } },
  // `sonnet-5` must stay NARROWER than `sonnet`: both match "claude-sonnet-5" and the longer
  // pattern is what distinguishes it from Sonnet 4.6, which keeps the broader entry.
  { match: 'sonnet-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

/**
 * An unrecognised model prices at NO LESS than every known one (GAS-002, epic Open Question 4).
 *
 * These rates divide a declared budget to answer "how long until 100%". Pricing an unknown
 * model cheaply makes the tank look fuller than it is — the gauge says three days and the work
 * stops in one. Pricing it dearly costs some unused headroom and nothing else. A budget gauge
 * should take the headroom. The previous default was Opus-tier, which UNDER-prices a
 * Fable-tier model by 2x: the dangerous direction.
 *
 * Derived from the table rather than written down, so adding a pricier tier cannot leave the
 * fallback quietly below it. GAS-003 asserts no model actually present in `session_usage`
 * reaches this, making it an alarm rather than a silent mispricing.
 */
const DEFAULT_RATE: Omit<Rate, 'match'> = {
  input: Math.max(...RATES.map((r) => r.input)),
  output: Math.max(...RATES.map((r) => r.output)),
  cacheRead: Math.max(...RATES.map((r) => r.cacheRead)),
  cacheWrite: Math.max(...RATES.map((r) => r.cacheWrite)),
};

/** The documented marker. Anything else is standard — an unknown value must not double a bill. */
const FAST = 'fast';

function rateFor(model: string, speed?: string): Tier {
  const m = (model || '').toLowerCase();
  // Longest match wins — see SPECIFICITY above. `find` would return whichever entry happened
  // to sit first, making a family split depend on array order.
  let best: Rate | undefined;
  for (const r of RATES) {
    if (m.includes(r.match) && (!best || r.match.length > best.match.length)) best = r;
  }
  if (!best) return DEFAULT_RATE;
  return (speed || '').trim() === FAST && best.fast ? best.fast : best;
}

export interface UsageRow {
  /** 'fast' selects the fast-mode tier where one exists. Absent means standard, which is what
   *  every caller predating GAS-014 passes — those rows must price exactly as they always did. */
  speed?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  model: string;
}

/** USD cost of a single session_usage row, priced by its model. */
export function rowCostUsd(r: UsageRow): number {
  const p = rateFor(r.model, r.speed);
  return (
    ((r.input_tokens || 0) * p.input +
      (r.output_tokens || 0) * p.output +
      (r.cache_read_tokens || 0) * p.cacheRead +
      (r.cache_creation_tokens || 0) * p.cacheWrite) /
    1_000_000
  );
}

/** Total USD cost across many usage rows (each priced by its own model). */
export function totalCostUsd(rows: UsageRow[]): number {
  return rows.reduce((sum, r) => sum + rowCostUsd(r), 0);
}
