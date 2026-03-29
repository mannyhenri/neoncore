/**
 * Periodic cleanup of stale data — prevents unbounded DB growth.
 * Runs on startup and every 6 hours.
 */
import db from '../db.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const MAX_SESSIONS_PER_PROJECT = 20;
const MAX_MEMORY_PER_AGENT = 20;

function runCleanup() {
  const stats = { activity: 0, commands: 0, permissions: 0, sessions: 0, memory: 0 };

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
