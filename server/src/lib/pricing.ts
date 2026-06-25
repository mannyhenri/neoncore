/**
 * Per-model token pricing (USD per 1M tokens) and cost computation.
 *
 * Matched by case-insensitive substring on the model id (e.g. "claude-opus-4-8"
 * matches "opus"). Cache-read is ~0.1x input; cache-write (5m TTL) ~1.25x input.
 * Keep this in sync with platform.claude.com/pricing as new tiers ship.
 */
interface Rate {
  match: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATES: Rate[] = [
  { match: 'fable', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  { match: 'opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

// Unknown/blank models fall back to Opus-tier rates (the common default).
const DEFAULT_RATE: Omit<Rate, 'match'> = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

function rateFor(model: string): Omit<Rate, 'match'> {
  const m = (model || '').toLowerCase();
  return RATES.find((r) => m.includes(r.match)) ?? DEFAULT_RATE;
}

export interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  model: string;
}

/** USD cost of a single session_usage row, priced by its model. */
export function rowCostUsd(r: UsageRow): number {
  const p = rateFor(r.model);
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
