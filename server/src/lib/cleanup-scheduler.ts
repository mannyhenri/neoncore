/**
 * Periodic cleanup of stale data — prevents unbounded DB growth.
 * Runs on startup and every 6 hours.
 */
import db from '../db.js';
import { deleteAgentCascade } from './agent-cleanup.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const MAX_SESSIONS_PER_PROJECT = 20;
const MAX_MEMORY_PER_AGENT = 20;

// Finished workflow RUNS (template_id IS NOT NULL) are kept this long, then pruned with
// their steps. Runs used to be hard-deleted 30 seconds after finishing, which destroyed
// every step result — the whole output of a review workflow was gone before anyone could
// read it, and both UIs had nothing left to show. Keep the history; prune it on a window.
// Templates (template_id IS NULL) are never pruned.
const WORKFLOW_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Agents that have been offline longer than this are deleted outright (cartridge
// disappears for good). They're already hidden in the grid; this stops the
// `agents` table from growing without bound as repos come and go.
const OFFLINE_AGENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function runCleanup() {
  const stats = { activity: 0, commands: 0, permissions: 0, sessions: 0, memory: 0, agents: 0, workflowRuns: 0 };

  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const oneDayAgo = new Date(Date.now() - ONE_DAY_MS).toISOString();

  // Activity: delete older than 7 days
  stats.activity = db.prepare('DELETE FROM activity WHERE timestamp < ?').run(sevenDaysAgo).changes;

  // Commands: delete older than 7 days
  stats.commands = db.prepare('DELETE FROM commands WHERE created_at < ?').run(sevenDaysAgo).changes;

  // Permissions: delete decided/expired older than 24h
  stats.permissions = db.prepare(
    "DELETE FROM permissions WHERE status IN ('allowed', 'denied', 'expired') AND decided_at < ?"
  ).run(oneDayAgo).changes;

  // Sessions: keep last N per project
  const projects = db.prepare(
    "SELECT DISTINCT project FROM sessions WHERE project != ''"
  ).all() as { project: string }[];

  for (const { project } of projects) {
    const cutoff = db.prepare(
      'SELECT started_at FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT 1 OFFSET ?'
    ).get(project, MAX_SESSIONS_PER_PROJECT) as { started_at: string } | undefined;

    if (cutoff) {
      stats.sessions += db.prepare(
        'DELETE FROM sessions WHERE project = ? AND started_at < ?'
      ).run(project, cutoff.started_at).changes;
    }
  }

  // Agent memory: keep last N per agent
  const agents = db.prepare('SELECT DISTINCT agent_id FROM agent_memory').all() as { agent_id: string }[];

  for (const { agent_id } of agents) {
    const cutoff = db.prepare(
      'SELECT created_at FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?'
    ).get(agent_id, MAX_MEMORY_PER_AGENT) as { created_at: string } | undefined;

    if (cutoff) {
      stats.memory += db.prepare(
        'DELETE FROM agent_memory WHERE agent_id = ? AND created_at < ?'
      ).run(agent_id, cutoff.created_at).changes;
    }
  }

  // Agents: delete those offline beyond the retention window, along with all
  // their child rows. Only 'offline' agents qualify — idle/working/waiting are
  // live, and an offline agent's last_seen is the moment it disconnected.
  const offlineCutoff = new Date(Date.now() - OFFLINE_AGENT_RETENTION_MS).toISOString();
  const staleAgents = db.prepare(
    "SELECT id FROM agents WHERE status = 'offline' AND last_seen < ?"
  ).all(offlineCutoff) as { id: string }[];

  for (const { id } of staleAgents) {
    deleteAgentCascade(id);
    stats.agents++;
  }

  // Workflow runs: prune finished runs (and their steps) past the retention window.
  // Only runs — a template has no template_id and must survive forever. An unfinished run
  // (no completed_at) is never pruned, however old, so a hung run stays visible.
  const runCutoff = new Date(Date.now() - WORKFLOW_RUN_RETENTION_MS).toISOString();
  const staleRuns = db.prepare(
    `SELECT id FROM workflows
     WHERE template_id IS NOT NULL
       AND status IN ('completed', 'failed')
       AND completed_at IS NOT NULL
       AND completed_at < ?`
  ).all(runCutoff) as { id: string }[];

  for (const { id } of staleRuns) {
    db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(id);
    db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    stats.workflowRuns++;
  }

  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(`[cleanup] Pruned: ${JSON.stringify(stats)}`);
  }
}

export function startCleanupScheduler() {
  // Run on startup (slight delay to not block init)
  setTimeout(runCleanup, 5000);
  setInterval(runCleanup, SIX_HOURS_MS);
  console.log('[cleanup] Scheduler started (runs every 6h)');
}
