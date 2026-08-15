/**
 * The function registry and the capability bars — THE source of truth.
 *
 * Previously the markdown table in docs/local-model-routing.md was authoritative and a
 * test grepped it. That was backwards, and it was the third instance of a pattern this
 * codebase keeps hitting: a hand-maintained artefact treated as a registry (KNOWN_ENGINES
 * against AgentType; the escalation ladder against rollup()). Here the code is the
 * registry and the document is the derived thing.
 *
 * See docs/local-model-routing.md for the reasoning behind each tier.
 */

// ---------------------------------------------------------------------------
// Capability dimensions — what the probe measures
// ---------------------------------------------------------------------------

/**
 * DIMENSIONS is the contract between the probe and the bars: a bar may only reference a
 * dimension the probe can actually produce, or a function becomes permanently unmeasurable
 * while looking merely unmeasured.
 */
export const DIMENSIONS = [
  'toolCall',      // emits a well-formed tool call THROUGH OUR HARNESS (the gate)
  'safeEdit',      // mutates exactly the intended bytes — not merely "changed the file"
  'comprehension', // summarise / extract from content already in context
  'synthesis',     // write correct code for a single well-specified change
  'planning',      // decompose a goal; multi-file, long-horizon
  'judgement',     // evaluate someone else's work for correctness and completeness
  /**
   * Did it COMPLETE the stated final action, not merely reason correctly?
   *
   * Added after measurement, not before, and it is the most important entry here.
   * Probing qwen2.5-coder-14b, three dimensions scored 0.00 or low because the model
   * reasoned correctly and then never wrote the output file — it ran the right grep,
   * read the right source, and stopped. Meanwhile toolCall/safeEdit/planning all write
   * terminal files and scored 1.00, so the model CAN complete a write; it just does not
   * always.
   *
   * That makes the confound NON-DETERMINISTIC and present in every probe, including the
   * ones that scored 1.00. Consequence: EVERY OTHER RATE IS A LOWER BOUND ON CAPABILITY,
   * because a failure is ambiguous between "cannot do it" and "did it and stopped short".
   * This dimension exists to measure that ambiguity directly so it can be factored out.
   */
  'instructionAdherence',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** Each dimension is a measured SUCCESS RATE in [0,1] over N trials — never a boolean. */
export type CapabilityVector = Record<Dimension, number>;

export interface CapabilityProfile {
  modelId: string;
  measuredAt: string;
  vector: CapabilityVector;
  /**
   * Median wall-clock seconds for a small turn. Deliberately NOT tokens/sec: the gateway
   * does not echo token counts to us (R1), so throughput is not measurable — but elapsed
   * time is, and it is what a waiting developer actually experiences.
   */
  interactiveTurnSeconds: number;
  /** Trials per dimension. A profile without this cannot be trusted — N=1 is not a rate. */
  trials?: Partial<Record<Dimension, number>>;
  /** Median wall-clock seconds per dimension: a read turn and a synthesis turn differ hugely. */
  perDimensionSeconds?: Partial<Record<Dimension, number>>;
  /**
   * Per-dimension history across runs, oldest first: [{ n, rate }, ...].
   *
   * Recorded because the trend changed a conclusion. safeEdit measured 1.00 (N=5), then
   * 0.80 (N=5), then 0.70 (N=10) — and on the strength of the first number a caution was
   * reported as falsified. Small-N results were optimistic in the flattering direction
   * twice, on the one dimension where the reviewer had a stake in the answer. A single
   * final rate hides that; the history makes it visible to whoever reads the profile next.
   */
  history?: Partial<Record<Dimension, Array<{ n: number; rate: number }>>>;
}

// ---------------------------------------------------------------------------
// Tiers and bars
// ---------------------------------------------------------------------------

export type Tier = 'T0' | 'T1-READ' | 'T1-WRITE' | 'T2' | 'T3' | 'T4' | 'T5';
export type Latency = 'interactive' | 'batch';

/**
 * THESE BARS WERE FIXED BEFORE ANY MODEL WAS MEASURED. That ordering is the point: if we
 * ran the probe first and then chose thresholds that let the result pass, the exercise
 * would validate itself — the exact failure this whole design exists to escape.
 *
 * The gate is anchored to the published BFCL V4 scale rather than to anything we measured:
 * ~68.5% at 27B, 66.1% at 9B, 50.3% at 4B, 43.6% at 2B. 0.60 sits below the 9B class
 * (which is dependable in practice) and above the 4B class (which is not), so it
 * discriminates where the capability cliff actually falls.
 *
 * safeEdit is deliberately the HIGHEST bar in the table at 0.80. A wrong edit is not a
 * failed call — it is a corrupted file that reports success, so it must clear a stricter
 * threshold than anything whose failure is merely a wasted turn.
 */
export const GATE_DIMENSION: Dimension = 'toolCall';
export const GATE_THRESHOLD = 0.60;

/**
 * Minimum trials before a rate may CERTIFY a pass. 8 is not arbitrary: it is the smallest
 * N at which a flawless score clears the 0.60 gate (Wilson lower bound 0.676). At N=5 a
 * perfect 5/5 bounds at 0.566 — so five trials cannot authorise anything, however good the
 * result, and spending them produces a guaranteed INCONCLUSIVE.
 *
 * SUFFICIENCY IS ASYMMETRIC, and this matters. The floor applies to PASSING only. A
 * definitive FAIL needs less evidence than a definitive pass: 0/5 has an upper bound of
 * 0.434, entirely below the 0.60 bar, so it is conclusive at N=5 even though 5/5 is not.
 * Applying one floor to both directions would have discarded the two clearest real
 * findings we have — comprehension 0.00 and judgement 0.00 — by relabelling proven
 * incapability as "undecided".
 */
export const MIN_TRIALS = 8;

/**
 * Which dimension's latency represents a function's tier. Gating `claude-code` (T4) on the
 * toolCall probe median is a category error — that probe is deliberately the cheapest turn
 * we can construct (write one short file), and T4 is the most expensive tier we route.
 */
export const TIER_LATENCY_DIMENSION: Record<Tier, Dimension | null> = {
  'T0': null,
  'T1-READ': 'toolCall',
  'T1-WRITE': 'safeEdit',
  'T2': 'comprehension',
  'T3': 'synthesis',
  'T4': 'planning',
  'T5': 'judgement',
};

export const TIER_BARS: Record<Tier, Partial<Record<Dimension, number>>> = {
  'T0': {},
  'T1-READ': { toolCall: GATE_THRESHOLD },
  'T1-WRITE': { toolCall: GATE_THRESHOLD, safeEdit: 0.80 },
  'T2': { toolCall: GATE_THRESHOLD, comprehension: 0.60 },
  'T3': { toolCall: GATE_THRESHOLD, synthesis: 0.60 },
  'T4': { toolCall: GATE_THRESHOLD, synthesis: 0.50, planning: 0.60 },
  'T5': { toolCall: GATE_THRESHOLD, judgement: 0.70 },
};

/**
 * Ceiling on turn latency for work sitting in a loop a developer is waiting on. Fixed in
 * advance and justified on UX grounds, not fitted to any observation: past roughly half a
 * minute per turn an in-loop tool call stops feeling like a tool and starts feeling like a
 * job. A capable-but-slow model is not wasted — it keeps every `batch` function.
 */
export const INTERACTIVE_MAX_TURN_SECONDS = 30;

/**
 * How many CONSECUTIVE failing turns demote a (model, function).
 *
 * Deliberately a count, not a rate: at demotion time we have very few samples, and a rate
 * over 3 observations is the same small-N trap the router already refuses elsewhere. A
 * streak is a cheap, auditable signal — and a single ATTRIBUTED success resets it, because one
 * bad turn on a flaky day is noise, not evidence.
 *
 * NOT named "consecutive", deliberately. The reset only fires on a successful turn the producer
 * could attribute to this function; a clean turn involving several tools is refused attribution
 * and never reaches the reset. So this counts failures with no OBSERVED success between them,
 * which is a weaker claim than adjacency and is the one the data actually supports. The old
 * name asserted the stronger claim and the recorded reason repeated it — a false sentence
 * written into the evidence.
 *
 * Lives here with the bars rather than inline in the consumer: policy in two places is the
 * drift defect this codebase has hit five times.
 */
export const DEMOTION_FAILURE_THRESHOLD = 3;

/**
 * Wilson score lower bound — the honest way to compare a small-sample rate to a bar.
 * Returns the low end of the ~95% interval for `passes` successes in `n` trials.
 */
export function wilsonUpperBound(passes: number, n: number): number {
  if (n <= 0) return 1;
  const z = 1.96;
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / d);
}

export function wilsonLowerBound(passes: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96;
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / d);
}

// ---------------------------------------------------------------------------
// The registry — 44 functions
// ---------------------------------------------------------------------------

export interface AgentFunction {
  id: string;
  tier: Tier;
  latency: Latency;
  /** Which source registry this came from — four are derived, one is not. */
  source: 'agentTools' | 'executorType' | 'conferMilestone' | 'mcpTool' | 'lifecycle';
}

const f = (id: string, tier: Tier, latency: Latency, source: AgentFunction['source']): AgentFunction =>
  ({ id, tier, latency, source });

export const FUNCTIONS: AgentFunction[] = [
  // --- Gridlight agent tools (packages/core/src/agent/agentTools.ts) ---
  f('read_file', 'T1-READ', 'interactive', 'agentTools'),
  f('list_files', 'T1-READ', 'interactive', 'agentTools'),
  f('search_code', 'T1-READ', 'interactive', 'agentTools'),
  f('git_status', 'T1-READ', 'interactive', 'agentTools'),
  f('git_diff', 'T1-READ', 'interactive', 'agentTools'),
  f('web_search', 'T1-READ', 'batch', 'agentTools'),
  f('web_fetch', 'T1-READ', 'batch', 'agentTools'),
  f('write_file', 'T1-WRITE', 'interactive', 'agentTools'),
  f('edit_file', 'T1-WRITE', 'interactive', 'agentTools'),
  f('run_command', 'T1-WRITE', 'interactive', 'agentTools'),
  f('git_commit', 'T2', 'batch', 'agentTools'),
  f('spawn_agent', 'T4', 'batch', 'agentTools'),

  // --- Workflow node types (server/src/types.ts StepExecutorType) ---
  f('command', 'T0', 'batch', 'executorType'),
  f('connector', 'T1-READ', 'batch', 'executorType'),
  f('decision', 'T2', 'interactive', 'executorType'),
  f('claude-code', 'T4', 'interactive', 'executorType'),
  f('review-gate', 'T5', 'batch', 'executorType'),
  f('quality-gate', 'T5', 'batch', 'executorType'),
  f('deliberation', 'T5', 'batch', 'executorType'),

  // --- Confer milestone roles (server/src/lib/confer-conductor.ts) ---
  f('align', 'T4', 'batch', 'conferMilestone'),
  f('frame', 'T4', 'batch', 'conferMilestone'),
  f('build', 'T4', 'batch', 'conferMilestone'),
  f('draft', 'T4', 'batch', 'conferMilestone'),
  f('revise', 'T3', 'batch', 'conferMilestone'),
  f('review', 'T5', 'batch', 'conferMilestone'),
  f('critique', 'T5', 'batch', 'conferMilestone'),
  f('converge', 'T5', 'batch', 'conferMilestone'),
  f('finalize', 'T5', 'batch', 'conferMilestone'),

  // --- NeonCore coordination tools (server/src/mcp-server.ts) ---
  f('neoncore_register', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_report', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_list_agents', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_claim_task', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_my_queue', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_request_permission', 'T1-READ', 'interactive', 'mcpTool'),
  f('neoncore_message_agent', 'T2', 'batch', 'mcpTool'),
  f('neoncore_read_agent', 'T2', 'batch', 'mcpTool'),
  f('neoncore_report_step_done', 'T2', 'batch', 'mcpTool'),
  f('neoncore_report_task_done', 'T5', 'batch', 'mcpTool'),
  // Drafting goal intent is judgement, not transcription: deciding what is genuinely
  // measurable, what belongs out of scope, and — hardest — what to leave blank rather than
  // invent. The text lands in every prompt dispatched under the goal, so a weaker engine
  // confabulating an acceptance criterion here becomes an instruction other agents act on.
  f('neoncore_submit_goal_draft', 'T5', 'batch', 'mcpTool'),
  // Decomposition is planning under constraint: reading a codebase well enough to name work
  // that actually exists, scoping each task to something independently verifiable, and getting
  // the dependency order right. Every accepted task is dispatched to a cartridge, so a plausible
  // but ungrounded plan does not fail at review — it fails after N runs have been spent on it.
  f('neoncore_submit_goal_decomposition', 'T5', 'batch', 'mcpTool'),

  // --- Engine lifecycle and developer-facing (no enum — see the doc) ---
  f('task_planning', 'T4', 'interactive', 'lifecycle'),
  f('developer_question', 'T5', 'interactive', 'lifecycle'),
  f('test_case_authoring', 'T3', 'batch', 'lifecycle'),
  f('test_authoring', 'T5', 'batch', 'lifecycle'),
  f('test_failure_interpretation', 'T4', 'interactive', 'lifecycle'),
  f('result_summarization', 'T2', 'batch', 'lifecycle'),
];

/**
 * The scenarios a developer actually names, mapped onto registry functions.
 *
 * Lives here rather than in the reporting script because a hand-maintained id map in a
 * script is the same defect this codebase has now hit four times (KNOWN_ENGINES against
 * AgentType; the escalation ladder against rollup(); a doc citation; and — written in the
 * same milestone as the document naming the pattern — the reporting script itself).
 * A test asserts every id below resolves in FUNCTIONS, so it cannot drift silently.
 */
export const SCENARIOS: Record<string, string[]> = {
  'coding': ['claude-code', 'write_file', 'edit_file'],
  'research': ['web_search', 'web_fetch'],
  'creating tests': ['test_case_authoring', 'test_authoring'],
  'testing (run + interpret)': ['run_command', 'test_failure_interpretation'],
  'file reads on the codebase': ['read_file', 'list_files', 'search_code'],
  'indexing the codebase': [],   // T0 — no model call at all
  'summarizing the end result': ['result_summarization', 'neoncore_report_step_done'],
  'interacting with the developer': ['developer_question'],
};

const BY_ID = new Map(FUNCTIONS.map((fn) => [fn.id, fn]));

/** Throws on an unknown id — a typo must not resolve to "no bar to clear". */
export function getFunction(id: string): AgentFunction {
  const fn = BY_ID.get(id);
  if (!fn) throw new Error(`unknown function: ${id}`);
  return fn;
}
