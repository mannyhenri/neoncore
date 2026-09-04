/**
 * Fleet burn rate — how fast the cartridges are actually consuming tokens.
 *
 * WHY THIS COUNTS CACHE. There are two token numbers in this codebase and only one of them
 * is real. `workflow_steps.tokens_in/out` (routes/workflows.ts) is `string.length / 4` over
 * the dispatched prompt and the final result — it cannot see the agentic loop inside a step,
 * so on a 47-step run it reported 48,683 output tokens against 1,034,252 actually recorded,
 * and modelled none of the 516,377,556 cache-read tokens that carried the real cost. The
 * cartridge card has a milder version of the same fault: `total: input + output`, which
 * prints ~16.4M for a cartridge that has moved 10.07 BILLION cache tokens.
 *
 * A header readout is the first number anyone reads, so `tokens` here is ALL FOUR classes.
 * `session_usage` is the measured source — written per turn from the transcript JSONL by
 * routes/agents.ts — and it is the only one worth averaging.
 */
import { totalCostUsd } from './pricing.js';

/** One `session_usage` row. Mirrors the schema's four token columns. */
export interface UsageSample {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  model: string;
  recorded_at: string;
}

/** Every field is numeric on purpose — the readout formats, it does not parse. */
export interface BurnRate {
  windowHours: number;
  /** All four token classes summed. The honest throughput number. */
  tokens: number;
  tokensPerHour: number;
  tokensPerDay: number;
  costUsd: number;
  costPerDay: number;
  /** Turn-level rows in the window — how much evidence the average rests on. */
  samples: number;
}

/**
 * Average the rows over a FIXED window rather than over their own first-to-last span.
 *
 * Dividing by the observed span would make the rate climb as a fleet went quiet — the last
 * row stops moving, the span stops growing, and an idle weekend would read as a busy one.
 * The caller states the window; both rates come out of that one divisor, so the per-hour and
 * per-day figures shown side by side can never contradict each other.
 */
export function computeBurnRate(rows: UsageSample[], windowHours: number): BurnRate {
  const tokens = rows.reduce(
    (sum, r) =>
      sum +
      (r.input_tokens || 0) +
      (r.output_tokens || 0) +
      (r.cache_read_tokens || 0) +
      (r.cache_creation_tokens || 0),
    0,
  );
  const costUsd = totalCostUsd(rows);

  // A zero or negative window is a caller bug, not a division to perform. Report the volume
  // truthfully and the rates as zero rather than shipping Infinity into the header.
  if (!(windowHours > 0)) {
    return { windowHours, tokens, tokensPerHour: 0, tokensPerDay: 0, costUsd, costPerDay: 0, samples: rows.length };
  }

  const tokensPerHour = tokens / windowHours;
  return {
    windowHours,
    tokens,
    tokensPerHour,
    tokensPerDay: tokensPerHour * 24,
    costUsd,
    costPerDay: (costUsd / windowHours) * 24,
    samples: rows.length,
  };
}
