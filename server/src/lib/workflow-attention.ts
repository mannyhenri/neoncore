/**
 * Is this run waiting on a PERSON right now?
 *
 * `[P1] Pick Approach` is a `decision` step: it sat `running` with an empty
 * `dispatched_prompt` because decision steps are never sent to an agent — they wait for
 * someone to choose. From every surface it was indistinguishable from work in progress. The
 * run said "1 running"; the bell said nothing. The executing agent investigated, correctly
 * found its queue empty, and reported a phantom stall.
 *
 * ── WHY THIS IS DERIVED, NOT REMEMBERED ────────────────────────────────────────────────
 * `workflow_notification` fires in exactly two places in the executor — manual-advance and the
 * `system-notify` connector. A decision gate sends a phone push and nothing to the dashboard;
 * failed and interrupted steps send neither. Adding the missing emissions is necessary but not
 * sufficient: a notification is a one-shot event that can be missed, dismissed, or fired while
 * nobody was looking. "Is this waiting on me right now?" has to be answerable from state at
 * any moment, so it is computed from the rows rather than stored when something happened.
 *
 * ── ORDER IS THE POINT ─────────────────────────────────────────────────────────────────
 * A run can be in several of these at once — a parallel branch fails while another waits on a
 * decision. Reporting the decision would send someone to answer a question on a run that is
 * already broken, so the list is ordered most-urgent first and the first match wins.
 */
import db from '../db.js';

/**
 * How long a cartridge must be quiet before a dispatched step counts as abandoned.
 *
 * Generous on purpose. These cartridges legitimately pause between tool calls, and accusing a
 * working agent of stalling would re-dispatch work that is already in progress. Ten minutes is
 * far longer than any gap in normal operation and far shorter than a night.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * The FLOOR under which a still-working cartridge is never called silent.
 *
 * MEASURED, not guessed — and the measurement corrected the reasoning that asked for it. Across
 * three real epic runs (74 loop gaps):
 *
 *   gl-dev GRD-3412       median 13.9  p90 39.9  max  51.8   ← the 52m loop COMPLETED normally
 *   gridlight-work 3502   median  9.9  p90 17.8  max 173.1   ← 65m legit; 146m+173m = the stall
 *   film-engine   3598    median 11.3  p90 21.2  max  32.2
 *
 * Longest VERIFIED-LEGITIMATE gap ~65 min; shortest GENUINE stall ~146 min. 90 sits between
 * them, which is why the original guess held. Firing sooner is not available at any multiplier:
 * `median x 3` accuses gl-dev's benchmark loop, which finished fine.
 */
export const DISPATCH_SILENT_FLOOR_MS = 90 * 60 * 1000;

/**
 * How many median loop times a dispatch may take before it is silent, when that exceeds the
 * floor. Set above the worst legitimate variance actually observed (3.7x median, gl-dev) so the
 * adaptive term cannot become a false-positive generator.
 *
 * This raises the threshold for a SLOW run; it never lowers it for a fast one. A workload whose
 * median loop is 40 minutes legitimately produces 150-minute gaps, and a fixed 90 would accuse
 * it every cycle. On every run measured so far the floor governs and this term is inert — a
 * guard for a case that has not happened yet, not dead code.
 */
export const STALL_MULTIPLE = 6;

/**
 * The median gap between this run's loop dispatches, or null when there is not one yet.
 *
 * Median, not mean: the stall itself is in the sample. gridlight-work's 173-minute stall sits in
 * the same series as its 5-minute loops, and a mean would let the anomaly raise the threshold
 * that is supposed to catch it.
 *
 * Null on fewer than two rows (no gap exists) and on unparseable timestamps, so a caller that
 * treats null as zero cannot accidentally set a zero threshold — see `silentThresholdMs`.
 */
export function medianLoopMs(workflowId: string): number | null {
  const rows = db.prepare(
    `SELECT created_at FROM workflow_journal
      WHERE workflow_id = ? AND message LIKE 'Loop %/%'
      ORDER BY created_at`,
  ).all(workflowId) as { created_at: string }[];
  if (rows.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = Date.parse(rows[i - 1].created_at);
    const b = Date.parse(rows[i].created_at);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const gap = b - a;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  // Lower middle on an even count. Averaging the two middles would invent a duration that never
  // occurred, and this number is compared against real elapsed time.
  return gaps[Math.floor((gaps.length - 1) / 2)];
}

/** The silence threshold for this run: the floor, raised if the run's own cadence is slower. */
export function silentThresholdMs(workflowId: string): number {
  const median = medianLoopMs(workflowId);
  if (median === null) return DISPATCH_SILENT_FLOOR_MS;
  return Math.max(DISPATCH_SILENT_FLOOR_MS, median * STALL_MULTIPLE);
}

/**
 * How long a cartridge's command channel must be CONTINUOUSLY absent before that counts.
 *
 * `hasActiveSocket` goes false for every relay the instant the server restarts, and they
 * reconnect a second or two later — four restarts happened in one evening of development, and
 * without this each would have fired `channel-lost` for every running workflow. A detector that
 * cries wolf on every deploy is one you mute, taking its true positives with it.
 *
 * Matches the `DEFAULT_GRACE_MS` idiom `detectInterruptedSteps` already uses for the same
 * reason; two sweeps of the 60-second notifier clear it.
 */
export const CHANNEL_GRACE_MS = 90 * 1000;

/**
 * When each agent's channel was FIRST seen absent. Cleared the moment it comes back.
 *
 * ── WHY THIS IS FILLED BY THE SWEEP AND READ BY THE DETECTOR, NEVER BOTH ───────────────
 * `workflowNeedsAttention` is called from four places, including `routes/workflows.ts` on every
 * dashboard list request, and its own header promises it is DERIVED — computed from the rows
 * every time it is asked. If asking advanced this clock, polling the dashboard would manufacture
 * a stall. So `observeChannels` mutates and the detector only reads.
 *
 * In-memory on purpose. After a restart the map is empty and every socket is briefly absent;
 * "no record" therefore means "start the clock", never "absent forever". The cost is that the
 * first `CHANNEL_GRACE_MS` after a boot is blind, which is the correct direction to be wrong.
 */
const channelAbsentSince = new Map<string, number>();

/**
 * Record which agents currently have a command channel. Call from the periodic sweep ONLY.
 *
 * `isAlive` is injected rather than imported so this module stays free of the socket layer —
 * the same shape `detectInterruptedSteps(db, { isAlive })` already uses, and what makes the
 * restart and reconnect cases testable without a real server.
 */
export function observeChannels(
  agentIds: string[],
  isAlive: (agentId: string) => boolean,
  now: number = Date.now(),
): void {
  for (const id of agentIds) {
    if (!id) continue;
    if (isAlive(id)) channelAbsentSince.delete(id);
    else if (!channelAbsentSince.has(id)) channelAbsentSince.set(id, now);
  }
}

/** How long this agent's channel has been continuously absent, or null if it is present. */
function channelAbsentFor(agentId: string, now: number = Date.now()): number | null {
  const since = channelAbsentSince.get(agentId);
  return since === undefined ? null : now - since;
}

export function __resetChannelStateForTest(): void {
  channelAbsentSince.clear();
}

export const ATTENTION_REASONS = [
  'failed',         // the run cannot continue at all
  'interrupted',    // a step's executor died mid-work; needs recovery
  'decision',       // a decision gate is waiting for a choice
  'agent-waiting',  // the executing cartridge stopped to ask a question
  'manual-advance', // a step finished but is held for a human to advance
  'channel-lost',   // alive, but no command channel — the next dispatch will bounce
  'agent-idle',     // dispatched, the cartridge went quiet, and nothing was ever reported
  'agent-silent',   // dispatched, the cartridge is still WORKING, and nothing was ever reported
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface Attention {
  reason: AttentionReason;
  stepId: string;
  stepName: string;
  /** One line a person can act on without opening the run. */
  detail: string;
}

interface StepRow {
  id: string;
  name: string;
  status: string;
  executor_type: string;
  executor_id: string;
  executor_config: string;
  auto_advance: number;
  recovery_status: string;
  dispatched_prompt: string;
  result: string;
  /** When the dispatch went out. Null on a step that was never started. */
  started_at: string | null;
}

/**
 * Is a person actually owed an answer by this cartridge?
 *
 * Either a permission request is still pending, or the hook recorded a question banner. A
 * `waiting` status with neither is a stale flag, not a block.
 */
function hasRealQuestion(agentId: string, pendingQuestion: string): boolean {
  if (pendingQuestion.trim()) return true;
  const pending = db.prepare(
    "SELECT 1 AS x FROM permissions WHERE agent_id = ? AND status = 'pending' LIMIT 1",
  ).get(agentId) as { x?: number } | undefined;
  return !!pending;
}

function question(cfg: string): string {
  try {
    const q = (JSON.parse(cfg || '{}') as { question?: string }).question;
    return typeof q === 'string' ? q : '';
  } catch {
    return '';
  }
}

/** What a detector returns when it matches: the step to name, and the line a person reads. */
interface Hit { step: StepRow; detail: string }

/**
 * What every detector is handed. `steps` is fetched once per sweep and shared; `workflowId` is
 * there because some reasons are properties of the RUN rather than of a step — the silence
 * threshold reads the run's own loop cadence, and the reasons still to come read its autonomy
 * deadline and loop budget.
 */
interface DetectCtx { workflowId: string; steps: StepRow[] }

/**
 * ONE DEFINITION PER REASON. Everything else reads this.
 *
 * A reason used to be spread across five sites — this array, its detector clause, the
 * `AUTO_RESOLVABLE` grants in autonomy.ts, the `hint()` map in attention-notifier.ts, and the
 * notifier test's `RESOLVABLE` classification. Adding `agent-silent` tripped two of those five
 * tripwires; three had no tripwire at all, so a reason could ship granted at the wrong autonomy
 * level or with a hint contradicting its own detector.
 *
 * ── ORDER IS DATA, NOT COMMENT NUMBERING ───────────────────────────────────────────────
 * Precedence used to live only in `// 1.` … `// 6.` comments above each clause, and after ONE
 * addition it was already wrong: two clauses both read `// 6.`. Comments cannot be asserted.
 * `order` can, and server/test/attention-registry.test.ts asserts it is a total order.
 *
 * A run can match several reasons at once — a parallel branch fails while another waits on a
 * decision. Reporting the decision would send someone to answer a question on a run that is
 * already broken, so the lowest `order` wins and evaluation stops there.
 */
interface ReasonDef {
  name: AttentionReason;
  /** Lower runs first. Unique across the registry; the test enforces that. */
  order: number;
  /**
   * Autonomy levels that MAY settle this reason without a human. EMPTY MEANS NEVER — that is
   * breakage (`failed`, `interrupted`), which no level may auto-resolve at any time.
   * `autonomy.ts` derives AUTO_RESOLVABLE and NEVER_AUTO from this rather than restating them.
   */
  autoAt: readonly ('advance' | 'full')[];
  detect: (ctx: DetectCtx) => Hit | null;
}

export const REASONS: readonly ReasonDef[] = [
  {
    name: 'failed',
    order: 1,
    autoAt: [],                       // breakage — never auto-resolved, at any level
    detect: ({ steps }) => {
      const s = steps.find((x) => x.status === 'failed');
      return s ? { step: s, detail: `"${s.name}" failed — the run cannot continue.` } : null;
    },
  },
  {
    name: 'interrupted',
    order: 2,
    autoAt: [],                       // breakage — recovery is a decision, not a default
    detect: ({ steps }) => {
      const s = steps.find((x) => x.status === 'running' && x.recovery_status === 'interrupted');
      return s ? { step: s, detail: `"${s.name}" was interrupted and needs recovery.` } : null;
    },
  },
  {
    // A decision gate. Nothing was dispatched and nothing ever will be until someone chooses.
    name: 'decision',
    order: 3,
    autoAt: ['full'],
    detect: ({ steps }) => {
      const s = steps.find((x) => x.status === 'running' && x.executor_type === 'decision');
      if (!s) return null;
      const q = question(s.executor_config);
      return { step: s, detail: q || `"${s.name}" is waiting for your choice.` };
    },
  },

  {
    // The cartridge stopped to ASK something — and there must really be a question.
    //
    // `waiting` alone is not enough, and treating it as enough is what let a run sit all night.
    // Claude Code fires a `notification` hook when a turn ends with nothing more to do, and that
    // sets `waiting` with no question attached: the agent simply stopped. Reported as
    // `agent-waiting`, such a run says "the cartridge is waiting for your input" while there is
    // nothing to input, and `full` correctly refuses to invent an answer — so it sits forever.
    //
    // lib/queue-runner.ts already reached this conclusion for the queue and wrote it down:
    // "`waiting` counts ONLY when there is a real question outstanding. A cartridge that ends a
    // session in `waiting` with no pending question is not blocked on anything — it is idle with
    // a stale flag." The same rule, applied here. Anything else falls through to the stall
    // checks below, which is what it actually is.
    name: 'agent-waiting',
    order: 4,
    autoAt: ['full'],
    detect: ({ steps }) => {
      const s = steps.find((x) => {
        if (x.status !== 'running' || !x.executor_id) return false;
        const a = db.prepare('SELECT status, pending_question FROM agents WHERE id = ?').get(x.executor_id) as
          { status?: string; pending_question?: string } | undefined;
        if (a?.status !== 'waiting') return false;
        return hasRealQuestion(x.executor_id, a.pending_question || '');
      });
      return s
        ? { step: s, detail: `The cartridge running "${s.name}" is waiting for your input.` }
        : null;
    },
  },

  {
    // ALIVE, BUT UNREACHABLE — the hole between "the agent died" and "the agent went quiet".
    //
    // SEEN LIVE, 2026-09-06. A cartridge was restored without a relay. It was working perfectly
    // — hooks reporting, tools running — and nothing could dispatch to it. The next dispatch
    // bounced with "Command not delivered: no command channel", the step went `failed`, and
    // `failed` is NEVER_AUTO, so the run stopped until a person looked.
    //
    // `detectInterruptedSteps` cannot see this: it needs the agent DEAD by activity staleness
    // first (`if (!dead) continue;`) and treats a live socket only as a veto. An agent that is
    // busy and merely unreachable never qualifies.
    //
    // Ranked ABOVE the symptoms it causes. Such a cartridge will also look idle once it stops
    // reporting; naming the cause is what lets someone relaunch the relay, where "went quiet"
    // sends them to inspect a cartridge that is working fine.
    name: 'channel-lost',
    order: 5,
    // NOT auto-resolvable at any level, and not because it is breakage in the usual sense: the
    // auto-resolution for a stalled cartridge is a NUDGE, and a nudge is a dispatch. There is
    // no channel to deliver it down. Granting this would queue a message into the void and
    // record it as handled.
    autoAt: [],
    detect: ({ steps }) => {
      const s = steps.find((x) => {
        if (x.status !== 'running' || !x.executor_id) return false;
        const absentFor = channelAbsentFor(x.executor_id);
        return absentFor !== null && absentFor > CHANNEL_GRACE_MS;
      });
      return s
        ? {
          step: s,
          detail: `The cartridge running "${s.name}" has had no command channel for over `
            + `${Math.round(CHANNEL_GRACE_MS / 1000)} seconds — the next dispatch will bounce. `
            + 'Relaunch its relay.',
        }
        : null;
    },
  },
  {
    // DISPATCHED AND ABANDONED — the failure that looks most like health.
  //
  // A step sits `running`, its cartridge went idle, and no result was ever reported. It is not
  // failed, not interrupted, not waiting on a person, not a gate. Every surface says "1 running"
  // and nothing is happening; a run stalled this way is invisible until someone notices hours
  // later that the number never moved. Seen live on the first real epic run.
  //
  // redispatchOrphanedSteps does NOT cover this: it fires only when the cartridge's session
  // CHANGED, which is the restart case. Here the session is identical — the agent simply
  // stopped without calling the completion webhook.
  //
  // Guarded three ways so a working cartridge is never accused of stalling:
  //   · executor_id must be set — a decision gate is `running` with no executor by design
  //   · dispatched_prompt must be non-empty — nothing was sent, nothing can be owed
  //   · the agent must have been quiet for STALE_AFTER_MS, not merely idle this instant
    name: 'agent-idle',
    order: 6,
    autoAt: ['advance', 'full'],
    detect: ({ steps }) => {
      const s = steps.find((x) => {
        if (x.status !== 'running' || !x.executor_id) return false;
        if (!(x.dispatched_prompt || '').trim()) return false;
        if ((x.result || '').trim()) return false;
        const a = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?').get(x.executor_id) as
          { status?: string; last_seen?: string } | undefined;
        if (!a || a.status === 'working') return false;
        // `waiting` is only a genuine block when something is actually outstanding — see
        // `agent-waiting`. Otherwise it is the same abandonment as `idle`, wearing a different
        // label.
        if (a.status === 'waiting' && hasRealQuestion(x.executor_id, '')) return false;
        const quietFor = a.last_seen ? Date.now() - Date.parse(a.last_seen) : Infinity;
        return Number.isFinite(quietFor) ? quietFor > STALE_AFTER_MS : true;
      });
      return s
        ? { step: s, detail: `"${s.name}" was dispatched but the cartridge went quiet without reporting.` }
        : null;
    },
  },

  {
    // DISPATCHED, ALIVE, AND SILENT — the other half of `agent-idle`, and the one that hides best.
  //
  // `agent-idle` asks "did the cartridge go quiet?". That question has a blind spot precisely where
  // it is guarded: `if (a.status === 'working') return false` exists so a busy cartridge is
  // never accused of stalling, and a busy cartridge is exactly what this looks like.
  //
  // SEEN LIVE. A dispatch went out at 20:25Z. Six minutes later the session hit its context
  // limit and auto-compacted, and the summary carried the epic forward but dropped the
  // completion contract the dispatch had given it — the step id and the webhook. The cartridge
  // kept working from its own state doc for 2h53m, committing real work, while the engine sat
  // on "Waiting for webhook callback" and every surface read healthy. It even asked questions
  // its dispatch prompt forbade, which is what losing the contract looks like from outside.
  // `agent-idle` could never fire: the agent was never quiet for a single sweep.
  //
  // So the signal here is the INVERSE liveness test — the agent is demonstrably alive and the
  // dispatch is old and nothing has been reported. The threshold is deliberately generous
  // against observed reality rather than tuned tight: the longest LEGITIMATE loop on a live
  // epic ran 65 minutes and completed normally, so 90 minutes clears real work while catching
  // a stall that ran nearly three hours. The remedy is a nudge, not a re-dispatch, so the cost
  // of being wrong is one interrupting message rather than duplicated side effects.
    name: 'agent-silent',
    order: 7,
    autoAt: ['advance', 'full'],
    detect: ({ workflowId, steps }) => {
      // Computed ONCE per sweep, not per step: it is a property of the run, and the query
      // behind it costs 0.06ms against an index that already exists.
      const threshold = silentThresholdMs(workflowId);
      const s = steps.find((x) => {
        if (x.status !== 'running' || !x.executor_id) return false;
        if (!(x.dispatched_prompt || '').trim()) return false;
        if ((x.result || '').trim()) return false;
        if (!x.started_at) return false;
        const dispatchedFor = Date.now() - Date.parse(x.started_at);
        if (!Number.isFinite(dispatchedFor) || dispatchedFor <= threshold) return false;
        const a = db.prepare('SELECT status, last_seen FROM agents WHERE id = ?').get(x.executor_id) as
          { status?: string; last_seen?: string } | undefined;
        if (!a) return false;
        // Alive: the exact complement of `agent-idle`'s staleness test, so the two clauses
        // partition the space instead of overlapping — a step is quiet-stalled or loud-stalled,
        // never both.
        const quietFor = a.last_seen ? Date.now() - Date.parse(a.last_seen) : Infinity;
        return Number.isFinite(quietFor) && quietFor <= STALE_AFTER_MS;
      });
      if (!s) return null;
      return {
        step: s,
        detail: `"${s.name}" was dispatched over ${Math.round(threshold / 60000)} minutes `
          + 'ago and the cartridge is still working, but nothing has been reported — it may have lost '
          + 'the completion contract (a context compaction drops it).',
      };
    },
  },
  {
    // Finished, but held. Only meaningful while there is still something left to advance to.
    name: 'manual-advance',
    order: 8,
    autoAt: ['advance', 'full'],
    detect: ({ steps }) => {
      const anyPending = steps.some((x) => x.status === 'pending');
      const s = steps.find((x) => x.status === 'completed' && x.auto_advance === 0);
      return s && anyPending
        ? { step: s, detail: `"${s.name}" finished and is waiting for you to advance.` }
        : null;
    },
  },
];

/** The registry in precedence order. Sorted once at module load, not per sweep. */
const ORDERED_REASONS = [...REASONS].sort((a, b) => a.order - b.order);

/** Look one reason up by name. Returns undefined for a name not in the registry. */
export function reasonDef(name: AttentionReason): ReasonDef | undefined {
  return REASONS.find((r) => r.name === name);
}

/**
 * The reason this run is blocked on a human, or null when it is genuinely working.
 *
 * Only a `running` workflow can need attention: recovery state on a finished or cancelled run
 * is history, and flagging it would make the badge permanent noise.
 */
export function workflowNeedsAttention(workflowId: string): Attention | null {
  const wf = db.prepare('SELECT status FROM workflows WHERE id = ?').get(workflowId) as
    { status?: string } | undefined;
  if (!wf || wf.status !== 'running') return null;

  const steps = db.prepare(
    `SELECT id, name, status, executor_type, executor_id, executor_config, auto_advance,
            recovery_status, dispatched_prompt, result, started_at
       FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y`,
  ).all(workflowId) as StepRow[];
  if (steps.length === 0) return null;

  for (const def of ORDERED_REASONS) {
    const hit = def.detect({ workflowId, steps });
    if (hit) return { reason: def.name, stepId: hit.step.id, stepName: hit.step.name, detail: hit.detail };
  }
  return null;
}
