import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { consumeActivityEvent } from '../lib/engine-store.js';
import { getIO } from '../ws.js';
import type { Activity } from '../types.js';
import { totalCostUsd, type UsageRow } from '../lib/pricing.js';
import { budgetProjection } from '../lib/projection.js';
import { limitEventsSince } from '../lib/limit-events.js';
import { learnedCeiling } from '../lib/learned-ceiling.js';
import { autoCompleteDispatchedTask } from '../lib/task-autocomplete.js';
import { resolveAgentId } from '../lib/resolve-agent.js';
import { armOnWork } from '../lib/work-standard.js';
import { clearInterruptOnLife } from '../lib/recovery.js';
import { statusFromActivity } from '../lib/activity-status.js';
import { detectLimitSignal, recordLimitEvent } from '../lib/limit-events.js';
import { computeBurnRate, type UsageSample } from '../lib/burn-rate.js';
import { buildSeries, BUCKETS, type Bucket } from '../lib/usage-series.js';
import { totalCostUsd as seriesCostUsd } from '../lib/pricing.js';
import {
  SUBSCRIPTION_PROVIDERS, learnTokenCeiling, projectTokenCeiling,
  type SubscriptionProvider,
} from '../lib/token-ceiling.js';

const router = Router();
const WEEK_MS = 7 * 86_400_000;

type TokenTotal = { tokens: number };
type CalibrationRow = { provider: SubscriptionProvider; hit_at: string; weekly_tokens: number };
type TokenUsage = TokenTotal & { first_at: string | null };

function providerTokens(provider: SubscriptionProvider, from: string, to: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens), 0) AS tokens
    FROM session_usage u JOIN agents a ON a.id = u.agent_id
    WHERE a.agent_type = ? AND u.recorded_at >= ? AND u.recorded_at <= ?
  `).get(provider, from, to) as TokenTotal;
  return Number(row?.tokens) || 0;
}

function providerUsageSince(provider: SubscriptionProvider, from: string, to: string): TokenUsage {
  return db.prepare(`
    SELECT COALESCE(SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens), 0) AS tokens,
      MIN(u.recorded_at) AS first_at
    FROM session_usage u JOIN agents a ON a.id = u.agent_id
    WHERE a.agent_type = ? AND u.recorded_at > ? AND u.recorded_at <= ?
  `).get(provider, from, to) as TokenUsage;
}

function subscriptionUsage(now = Date.now()) {
  return SUBSCRIPTION_PROVIDERS.flatMap((provider) => {
    const rows = db.prepare(`SELECT provider, hit_at, weekly_tokens FROM token_limit_calibrations
      WHERE provider = ? ORDER BY hit_at DESC LIMIT 52`).all(provider) as CalibrationRow[];
    if (!rows.length) return [];
    const learned = learnTokenCeiling(rows.map((row) => row.weekly_tokens));
    const lastHitAt = rows[0].hit_at;
    const usage = providerUsageSince(provider, lastHitAt, new Date(now).toISOString());
    const cycleStart = usage.first_at ? Date.parse(usage.first_at) : now;
    const elapsedDays = Math.max((now - cycleStart) / 86_400_000, 1 / 24);
    const tokensPerDay = usage.tokens / elapsedDays;
    return [projectTokenCeiling({
      provider, ceilingTokens: learned?.tokensWeekly ?? 0, tokensUsed: usage.tokens, tokensPerDay,
      samples: learned?.samples ?? 0, confidence: learned?.confidence ?? 0, lastHitAt,
    })];
  });
}

router.post('/token-limit-calibrations', (req, res) => {
  const provider = String(req.body?.provider || '').toLowerCase() as SubscriptionProvider;
  if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of ${SUBSCRIPTION_PROVIDERS.join(', ')}` });
  }
  const hit = Date.parse(String(req.body?.hitAt || ''));
  if (!Number.isFinite(hit) || hit > Date.now() + 60_000 || hit < Date.now() - 370 * 86_400_000) {
    return res.status(400).json({ error: 'hitAt must be a valid time within the past year and not in the future' });
  }
  const hitAt = new Date(hit).toISOString();
  const duplicate = db.prepare(`SELECT id, weekly_tokens FROM token_limit_calibrations
    WHERE provider = ? AND hit_at BETWEEN ? AND ? LIMIT 1`).get(
      provider,
      new Date(hit - 60_000).toISOString(),
      new Date(hit + 60_000).toISOString(),
    ) as { id: string; weekly_tokens: number } | undefined;
  if (duplicate) {
    return res.status(200).json({ id: duplicate.id, provider, hitAt, weeklyTokens: duplicate.weekly_tokens });
  }
  const weeklyTokens = providerTokens(provider, new Date(hit - WEEK_MS).toISOString(), hitAt);
  const id = uuid();
  db.prepare(`INSERT INTO token_limit_calibrations (id, provider, hit_at, weekly_tokens, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, provider, hitAt, weeklyTokens, new Date().toISOString());
  res.status(201).json({ id, provider, hitAt, weeklyTokens });
});

// Log an activity event (called by hooks)
router.post('/', (req, res) => {
  const { agentId, sessionId, machine, repoPath, eventType, toolName, toolInput, toolResult, agentType } = req.body;

  // Resolution lives in lib/resolve-agent.ts — this route used to carry its own copy,
  // which drifted: the shared helper gained an untyped-payload default while this one
  // still fell through to insertion order, so Claude hook events landed on the Codex
  // cartridge whenever Codex's row happened to be created first.
  const resolvedAgentId = resolveAgentId({ agentId, machine, repoPath, sessionId, agentType });

  if (!resolvedAgentId) {
    return res.status(400).json({ error: 'agentId, machine+repoPath, or valid sessionId required' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  const toolInputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {});
  const toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || {});

  db.prepare(`
    INSERT INTO activity (id, agent_id, event_type, tool_name, tool_input, tool_result, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, resolvedAgentId, eventType || 'tool_use', toolName || '', toolInputStr, toolResultStr, now);

  // Close the loop. These events have been arriving since the second confer and NOTHING
  // has ever read them — the router honoured a demotion argument that nothing produced.
  // Consuming here keeps it on the path that already works and needs no change on the
  // emitting side. Never let a consumer error break activity ingestion.
  try {
    consumeActivityEvent(String(eventType || ''), typeof toolInput === 'string' ? toolInput : undefined, resolvedAgentId);
  } catch (err) {
    console.warn(`[activity] trouble-signal consumer failed: ${err instanceof Error ? err.message : err}`);
  }

  // Update last_seen always — any event is proof of life. The STATUS depends on what the
  // event says: forcing 'working' for everything discarded the one signal that means the
  // cartridge is blocked on a human ("Claude is waiting for your input"), so a waiting agent
  // was indistinguishable from an idle one. null means "this event says nothing about
  // availability" — leave whatever is there rather than guessing.
  const implied = statusFromActivity(String(eventType || ''), toolInputStr);

  // GAS-012 — where the usage wall was, and what had been spent when we hit it. Gated on the
  // event TYPE before any text is read: an agent writing "we hit the usage limit yesterday"
  // must not record a ceiling observation. Recording is best-effort and must never fail an
  // activity report, which is a heartbeat as much as a log.
  const limitMarker = detectLimitSignal(String(eventType || ''), toolInputStr);
  // resolvedAgentId, NOT the raw agentId off the body: a payload without an explicit id is
  // the normal case that resolveAgentId exists to handle, and attributing to the raw value
  // would silently drop every limit event from exactly those reports.
  if (limitMarker && resolvedAgentId) {
    try {
      recordLimitEvent(String(resolvedAgentId), limitMarker, new Date().toISOString());
    } catch (err) {
      console.error(`[limit-events] could not record ${limitMarker}: ${err}`);
    }
  }
  if (implied) {
    db.prepare('UPDATE agents SET last_seen = ?, status = ? WHERE id = ?')
      .run(now, implied, resolvedAgentId);
  } else {
    db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(now, resolvedAgentId);
  }
  // A tool hook firing is the strongest proof this cartridge is alive. If the staleness sweep
  // declared it dead during a long tool call, this is the moment that verdict is wrong.
  clearInterruptOnLife(resolvedAgentId);

  // Work-standard gate: an offered contract becomes binding the first time the agent edits
  // something. This is the ingest point every engine's reporter posts to, so it covers all
  // of them in one place. No-op for read-only tools and for agents with no offer.
  if (armOnWork(db, { agentId: resolvedAgentId, toolName: toolName || '' })) {
    console.log(`[standard] Armed ${resolvedAgentId.slice(0, 8)} — first edit (${toolName}) under an offered contract`);
  }

  const activity: Activity = {
    id,
    agentId: resolvedAgentId,
    eventType: eventType || 'tool_use',
    toolName: toolName || '',
    toolInput: toolInputStr,
    toolResult: toolResultStr,
    timestamp: now,
  };

  getIO().emit('activity_logged', activity);

  // Stop-hook auto-complete (path B): the agent finished a turn — close out any
  // task we dispatched into its terminal that it didn't self-report (path C).
  if ((eventType || '') === 'Stop') {
    try { autoCompleteDispatchedTask(resolvedAgentId); } catch { /* non-fatal */ }
  }

  res.status(201).json(activity);
});

// Get activity for an agent
// NB: THIS MUST STAY ABOVE `router.get('/:agentId')`. Express matches in declaration
// order and `/:agentId` eats any single segment, so a burn-rate route declared after it
// is not a 404 — it silently returns the activity list for an agent named 'burn-rate',
// i.e. `[]`. Guarded by test/burn-rate.test.ts.
// Fleet burn rate — the header readout. Aggregate across EVERY cartridge, not one agent.
//
// A trailing fixed window, not lifetime-to-date: a lifetime average is dragged down forever
// by the weeks before the fleet was busy, and it can only ever move slower than reality.
// `days` is the window; the two rates the header prints both come out of that one divisor.
router.get('/burn-rate', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const windowHours = days * 24;
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  // Bounded by `since` and nothing else — every agent, so the header answers "the fleet",
  // which is the question a global chrome element is asking.
  const rows = db.prepare(`
    SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, speed, recorded_at
    FROM session_usage WHERE recorded_at >= ?
  `).all(since) as UsageSample[];

  const active = db.prepare(
    'SELECT COUNT(DISTINCT agent_id) AS n FROM session_usage WHERE recorded_at >= ?'
  ).get(since) as { n: number };

  const burn = computeBurnRate(rows, windowHours);

  // The declared ceiling and the projection, ADDITIVELY (GAS-007). BurnRate.tsx fans out
  // across every server in `activeServers` and merges, and those servers can be on different
  // builds — so an older one that has never heard of `budget` must not break the badge. Every
  // existing field keeps its name and meaning; the new data arrives under keys an old client
  // simply ignores.
  const settings = Object.fromEntries(
    (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[])
      .map((r) => [r.key, r.value]),
  );
  const accountProjection = budgetProjection({
    costPerDay: burn.costPerDay,
    settings,
    learned: learnedCeiling(limitEventsSince(new Date(Date.now() - 90 * 86_400_000).toISOString())),
  });

  res.json({
    ...burn,
    days,
    since,
    activeCartridges: active?.n || 0,
    subscriptionUsage: subscriptionUsage(),
    // A ceiling learned from real limit events outranks the declared budget (GAS-013).
    // learnedCeiling() returns null until it has enough consistent observations, which today
    // it does not — so this changes nothing yet and is correct that it changes nothing.
    budget: accountProjection.budget,
    projection: accountProjection.projection,
    windowStart: accountProjection.windowStart,
  });
});

// Token burn over time — the reporting page. Same window/ordering rules as /burn-rate above,
// and the same reason it must sit ABOVE `/:agentId`.
//
// `byCartridge` ships alongside the series deliberately: the series answers "when did my spend
// change", and the immediate next question is always "on what", which a chart of one line
// cannot answer. Both come off the same scan, so it costs nothing to answer both at once.
//
// Each cartridge carries its `project`, the SAME expression `byProject` groups on, so a client
// can split a project into its cartridges by equality. Clients previously matched on the name
// — `cartridge.name.includes(project)` — which is wrong the moment one repo name contains
// another: tapping `gridlight` also listed `gridlight-work` and `gridlight-manager`, under a
// heading that correctly said "1 cartridge". Deriving it here is also the only place it CAN be
// derived, since `session_usage` carries an agent id and nothing else.
router.get('/usage-series', (req, res) => {
  const days = Math.min(400, Math.max(1, Number(req.query.days) || 30));
  const bucket = (BUCKETS as string[]).includes(String(req.query.bucket))
    ? (req.query.bucket as Bucket)
    : 'day';

  const to = Date.now();
  const from = to - days * 86_400_000;
  const sinceIso = new Date(from).toISOString();

  const rows = db.prepare(`
    SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, speed, recorded_at
    FROM session_usage WHERE recorded_at >= ?
  `).all(sinceIso) as UsageSample[];

  const series = buildSeries(rows, bucket, from, to);

  // Priced per row by its own model, so a window spanning a model switch stays honest.
  const byCartridge = db.prepare(`
    SELECT u.agent_id AS agentId, COALESCE(a.name, u.agent_id) AS name,
           COALESCE(NULLIF(a.repo_name, ''), 'unassigned') AS project,
           SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens) AS tokens,
           COUNT(*) AS samples
    FROM session_usage u LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.recorded_at >= ?
    GROUP BY u.agent_id ORDER BY tokens DESC
  `).all(sinceIso) as
    { agentId: string; name: string; project: string; tokens: number; samples: number }[];

  /**
   * The same spend, grouped by REPO rather than by cartridge.
   *
   * A cartridge is not a project: 13 cartridges span 11 repos, and the ones sharing a repo are
   * exactly the ones worth summing — "what did this project cost me" is the question a per-
   * cartridge list cannot answer no matter how it is sorted.
   *
   * Grouped HERE and not on the client because session_usage carries only agent_id; deriving
   * the repo on the phone would mean shipping the whole agent roster alongside every report,
   * and it would still be wrong for a cartridge that has since been deleted.
   *
   * Cartridges with no repo collapse into one honest bucket rather than being dropped — a
   * total that silently omits rows is worse than a row labelled "unassigned".
   */
  const byProject = db.prepare(`
    SELECT COALESCE(NULLIF(a.repo_name, ''), 'unassigned') AS project,
           SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens) AS tokens,
           COUNT(*) AS samples,
           COUNT(DISTINCT u.agent_id) AS cartridges
    FROM session_usage u LEFT JOIN agents a ON a.id = u.agent_id
    WHERE u.recorded_at >= ?
    GROUP BY project ORDER BY tokens DESC
  `).all(sinceIso) as { project: string; tokens: number; samples: number; cartridges: number }[];

  res.json({
    bucket, days,
    from: sinceIso,
    to: new Date(to).toISOString(),
    series,
    total: {
      tokens: series.reduce((n, p) => n + p.tokens, 0),
      costUsd: seriesCostUsd(rows),
      samples: rows.length,
    },
    byCartridge,
    byProject,
  });
});

router.get('/:agentId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const activities = db
    .prepare('SELECT * FROM activity WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(req.params.agentId, limit) as Record<string, unknown>[];

  res.json(activities.map(normalizeActivity));
});

// Get all recent activity
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const activities = db
    .prepare('SELECT * FROM activity ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];

  res.json(activities.map(normalizeActivity));
});

function normalizeActivity(row: Record<string, unknown>): Activity {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    eventType: (row.event_type ?? row.eventType) as string,
    toolName: (row.tool_name ?? row.toolName) as string,
    toolInput: (row.tool_input ?? row.toolInput) as string,
    toolResult: (row.tool_result ?? row.toolResult ?? '{}') as string,
    timestamp: row.timestamp as string,
  };
}

// ── Token usage endpoints ──────────────────────────────────────────────────

// Report session token usage (called from Stop/SubagentStop hook)
router.post('/usage', (req, res) => {
  const { sessionId, machine, repoPath, inputTokens, outputTokens, model, agentType } = req.body;

  // Same shared resolver as the activity route. This path used to take the FIRST
  // repo match with no agentType consideration at all, so in a two-engine repo the
  // token spend of one engine was billed to the other.
  const resolvedAgentId = resolveAgentId({ machine, repoPath, sessionId, agentType });

  if (!resolvedAgentId) {
    return res.status(400).json({ error: 'Could not resolve agent' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO session_usage (id, session_id, agent_id, input_tokens, output_tokens, model, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sessionId || '', resolvedAgentId, inputTokens || 0, outputTokens || 0, model || '', now);

  res.status(201).json({ id });
});

// Get aggregate token usage for an agent (optionally since a timestamp)
router.get('/usage/:agentId', (req, res) => {
  const { agentId } = req.params;
  const since = req.query.since as string | undefined;

  // No LIMIT — the card shows lifetime "total tokens consumed", so sum every row
  // (optionally bounded by `since`). Cache tokens are summed for accurate cost.
  const cols = 'input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, speed, recorded_at';
  const rows = since
    ? db.prepare(`SELECT ${cols} FROM session_usage WHERE agent_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC`).all(agentId, since) as (UsageRow & { recorded_at: string })[]
    : db.prepare(`SELECT ${cols} FROM session_usage WHERE agent_id = ? ORDER BY recorded_at DESC`).all(agentId) as (UsageRow & { recorded_at: string })[];

  const totalInput = rows.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
  const totalOutput = rows.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
  const totalCacheRead = rows.reduce((sum, r) => sum + (r.cache_read_tokens || 0), 0);
  const totalCacheCreation = rows.reduce((sum, r) => sum + (r.cache_creation_tokens || 0), 0);
  const latestModel = rows[0]?.model || '';

  res.json({
    agentId,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreation,
    total: totalInput + totalOutput,
    costUsd: totalCostUsd(rows),
    latestModel,
    sessions: rows.length,
  });
});

export default router;
