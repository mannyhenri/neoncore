/**
 * The router: a pure function over the eligibility map.
 *
 * It holds NO policy of its own beyond the thresholds in engine-capability.ts. Every time
 * policy has lived in two places in this codebase it has drifted — KNOWN_ENGINES against
 * AgentType, the escalation ladder against rollup(). If the profile says a function clears
 * its bar and the router carries a separate opinion, that defect is rebuilt on purpose.
 */
import {
  FUNCTIONS, TIER_BARS, GATE_DIMENSION, GATE_THRESHOLD, INTERACTIVE_MAX_TURN_SECONDS,
  MIN_TRIALS, TIER_LATENCY_DIMENSION, wilsonLowerBound, wilsonUpperBound,
  getFunction, type CapabilityProfile, type Dimension,
} from './engine-capability.js';

export type Engine = 'local' | 'frontier';
/**
 * Four states, not three. INCONCLUSIVE was added after measuring a real model: a rate
 * whose confidence interval straddles the bar is epistemically identical to no
 * measurement, so it escalates exactly like UNMEASURED. Collapsing it into ELIGIBLE is how
 * a 3/5 becomes a "pass".
 */
export type Eligibility = 'ELIGIBLE' | 'INELIGIBLE' | 'UNMEASURED' | 'INCONCLUSIVE';

export interface RoutingDecision {
  functionId: string;
  engine: Engine;
  state: Eligibility;
  /** Always populated — a decision with no reason cannot be audited or debugged. */
  reason: string;
}

/**
 * Runtime evidence that overrides the profile for one (model, function).
 *
 * STATUS: NOT CLOSED. This is an interface, not a loop. The design calls runtime demotion the
 * only mechanism that can correct a wrong profile, and routeFunction honours a demotion
 * correctly — but nothing in the codebase PRODUCES or PERSISTS one yet. The producer is
 * the dispatch integration, deliberately out of scope for this confer. Until that lands,
 * a wrong profile stays wrong; do not read the design's "only closed loop" as implemented.
 */
export interface DemotionRecord {
  functionId: string;
  demoted: boolean;
  reason?: string;
}

type DimVerdict = 'clears' | 'fails' | 'inconclusive' | 'unmeasured';

/**
 * Compare one measured dimension against a bar, honestly.
 * A point estimate alone cannot distinguish 3/5 from 300/500.
 */
function judgeDimension(profile: CapabilityProfile, dim: Dimension, min: number): { verdict: DimVerdict; detail: string } {
  const score = profile.vector[dim];
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return { verdict: 'unmeasured', detail: `${dim} not measured` };
  }
  const n = profile.trials?.[dim] ?? 0;
  if (n <= 0) return { verdict: 'unmeasured', detail: `${dim} has no trials` };

  // A definitive FAIL is cheaper than a definitive pass: if the whole interval sits below
  // the bar, the model cannot clear it, and no number of extra trials will change that.
  const upper = wilsonUpperBound(Math.round(score * n), n);
  if (upper < min) {
    return { verdict: 'fails', detail: `${dim}=${fmt(score)} (N=${n}), 95% upper bound ${fmt(upper)} < ${min}` };
  }

  // Certifying a PASS needs the floor: below it, even a flawless run cannot clear the bar.
  if (n < MIN_TRIALS) {
    return { verdict: 'inconclusive', detail: `${dim}: N=${n} < ${MIN_TRIALS} — too few trials to certify` };
  }
  if (score < min) return { verdict: 'fails', detail: `${dim}=${fmt(score)} < ${min}` };
  // Passed on the point estimate — but does the interval actually clear the bar?
  const lower = wilsonLowerBound(Math.round(score * n), n);
  if (lower < min) {
    return { verdict: 'inconclusive', detail: `${dim}=${fmt(score)} (N=${n}) but 95% lower bound ${fmt(lower)} < ${min}` };
  }
  return { verdict: 'clears', detail: `${dim}=${fmt(score)}` };
}

export function routeFunction(
  functionId: string,
  profile: CapabilityProfile | null,
  demotions: DemotionRecord[] = [],
): RoutingDecision {
  const fn = getFunction(functionId); // throws on unknown id, by design

  // T0 makes no model call at all — heuristic code, free, always local. It is not
  // "eligible" in the measured sense; there is nothing to measure.
  if (fn.tier === 'T0') {
    return { functionId, engine: 'local', state: 'ELIGIBLE', reason: 'T0: no model call — heuristic, always local' };
  }

  // Runtime evidence beats the profile. Checked before the bars so a demoted function
  // cannot be re-authorised by a stale measurement.
  const demoted = demotions.find((d) => d.functionId === functionId && d.demoted);
  if (demoted) {
    return { functionId, engine: 'frontier', state: 'INELIGIBLE', reason: `demoted at runtime: ${demoted.reason ?? 'observed failure'}` };
  }

  // No measurement is NOT permission. Under an SLM-first default an unmeasured function
  // would otherwise silently ship work from a model nobody verified.
  if (!profile) {
    return { functionId, engine: 'frontier', state: 'UNMEASURED', reason: 'no capability profile for this model — escalating and queuing a probe' };
  }

  // THE GATE, checked independently and first. It is not the bottom of an ordinal scale:
  // a model that cannot emit a tool call through our harness cannot read a file, so
  // nothing routes local regardless of how well it scores elsewhere.
  const gateJ = judgeDimension(profile, GATE_DIMENSION, GATE_THRESHOLD);
  if (gateJ.verdict !== 'clears') {
    const state = gateJ.verdict === 'fails' ? 'INELIGIBLE'
      : gateJ.verdict === 'unmeasured' ? 'UNMEASURED' : 'INCONCLUSIVE';
    return { functionId, engine: 'frontier', state, reason: `gate — ${gateJ.detail}` };
  }

  // Latency gates independently of capability. A capable-but-slow model is not wasted:
  // it loses interactive work and keeps everything batch.
  // Use the latency of the dimension THIS TIER depends on. Gating T4 on the toolCall
  // probe (deliberately the cheapest turn we can construct) systematically under-predicts
  // latency for the most expensive tier we route.
  if (fn.latency === 'interactive') {
    const latDim = TIER_LATENCY_DIMENSION[fn.tier];
    const seconds = (latDim && profile.perDimensionSeconds?.[latDim]) ?? profile.interactiveTurnSeconds;
    if (seconds > INTERACTIVE_MAX_TURN_SECONDS) {
      return {
        functionId, engine: 'frontier', state: 'INELIGIBLE',
        reason: `too slow for interactive use: ${fmt(seconds)}s/turn (${latDim ?? 'overall'}) > ${INTERACTIVE_MAX_TURN_SECONDS}s`,
      };
    }
  }

  // The remaining vector dimensions for this tier.
  const bar = TIER_BARS[fn.tier];
  const unmet: string[] = [];
  const unclear: string[] = [];
  for (const [dim, min] of Object.entries(bar) as [Dimension, number][]) {
    if (dim === GATE_DIMENSION) continue; // already checked
    const j = judgeDimension(profile, dim, min);
    if (j.verdict === 'unmeasured') {
      return { functionId, engine: 'frontier', state: 'UNMEASURED', reason: `${fn.tier} requires ${j.detail}` };
    }
    if (j.verdict === 'fails') unmet.push(j.detail);
    if (j.verdict === 'inconclusive') unclear.push(j.detail);
  }

  // A real failure outranks an uncertain one: if any bar is definitively unmet, say so.
  if (unmet.length > 0) {
    return { functionId, engine: 'frontier', state: 'INELIGIBLE', reason: `${fn.tier} bar unmet: ${unmet.join(', ')}` };
  }
  if (unclear.length > 0) {
    return { functionId, engine: 'frontier', state: 'INCONCLUSIVE', reason: `${fn.tier} undecided: ${unclear.join(', ')}` };
  }

  return { functionId, engine: 'local', state: 'ELIGIBLE', reason: `${fn.tier} bar cleared` };
}

/** Decide every function in the registry for one profile. */
export function eligibilityMap(
  profile: CapabilityProfile | null,
  demotions: DemotionRecord[] = [],
): Record<string, RoutingDecision> {
  const out: Record<string, RoutingDecision> = {};
  for (const fn of FUNCTIONS) out[fn.id] = routeFunction(fn.id, profile, demotions);
  return out;
}

/** Counts by engine and state — the headline a human reads. */
export function summarise(map: Record<string, RoutingDecision>) {
  const local = Object.values(map).filter((d) => d.engine === 'local');
  return {
    total: Object.keys(map).length,
    local: local.length,
    frontier: Object.keys(map).length - local.length,
    byState: Object.values(map).reduce<Record<string, number>>((acc, d) => {
      acc[d.state] = (acc[d.state] || 0) + 1;
      return acc;
    }, {}),
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(n);
}
