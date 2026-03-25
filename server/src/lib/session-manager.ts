import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { Session } from '../types.js';
import { summarizeSession, updateKnowledgeFromSession } from './session-summarizer.js';
import { injectProjectContext } from './context-injector.js';

// ── Helpers ──────────────────────────────────────────

function normalizeSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    sessionId: (row.session_id ?? row.sessionId) as string,
    project: (row.project as string) ?? '',
    repoPath: (row.repo_path ?? row.repoPath ?? '') as string,
    machine: (row.machine as string) ?? '',
    branch: (row.branch as string) ?? '',
    startedAt: (row.started_at ?? row.startedAt) as string,
    endedAt: (row.ended_at ?? row.endedAt ?? null) as string | null,
    status: (row.status as Session['status']) ?? 'active',
    activityCount: (row.activity_count ?? row.activityCount ?? 0) as number,
    summary: (row.summary as string) ?? '',
  };
}

// ── Ensure default knowledge files exist for a project ──

function ensureProjectKnowledge(project: string) {
  if (!project) return;

  const defaults: { filename: string; content: string }[] = [
    { filename: 'progress.md', content: `# Progress — ${project}\n\n` },
    { filename: 'decisions.md', content: `# Decisions — ${project}\n\n` },
    { filename: 'gotchas.md', content: `# Gotchas — ${project}\n\n` },
  ];

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO project_knowledge (id, project, filename, content, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const { filename, content } of defaults) {
    insertStmt.run(uuid(), project, filename, content, now);
  }
}

// ── Public API ───────────────────────────────────────

export function startSession(
  agentId: string,
  sessionId: string,
  project: string,
  repoPath: string,
  machine: string,
  branch: string,
): void {
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO sessions (id, agent_id, session_id, project, repo_path, machine, branch, started_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(id, agentId, sessionId, project, repoPath, machine, branch, now);

  ensureProjectKnowledge(project);

  getIO().emit('session_started', { agentId, project, sessionId });
  console.log(`[session] Started session for agent ${agentId.slice(0, 8)} on project "${project}"`);

  // Context injection is now manual — triggered via dashboard "Send Context" button
}

export function endSession(agentId: string): void {
  const session = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get(agentId) as Record<string, unknown> | undefined;

  if (!session) return;

  const now = new Date().toISOString();
  const startedAt = session.started_at as string;

  // Count activities during this session
  const countResult = db.prepare(
    'SELECT COUNT(*) as count FROM activity WHERE agent_id = ? AND timestamp >= ? AND timestamp <= ?'
  ).get(agentId, startedAt, now) as { count: number };

  const activityCount = countResult?.count ?? 0;

  // Update session as ended
  db.prepare('UPDATE sessions SET status = ?, ended_at = ?, activity_count = ? WHERE id = ?')
    .run('ended', now, activityCount, session.id as string);

  console.log(`[session] Ended session ${(session.id as string).slice(0, 8)} for agent ${agentId.slice(0, 8)} (${activityCount} activities)`);

  // Summarize asynchronously (don't block the request)
  if (activityCount >= 3) {
    try {
      const summary = summarizeSession(session.id as string, agentId, startedAt, now);
      db.prepare('UPDATE sessions SET status = ?, summary = ? WHERE id = ?')
        .run('summarized', summary, session.id as string);

      // Update project knowledge files
      const project = session.project as string;
      if (project) {
        updateKnowledgeFromSession(project, summary, agentId);
      }

      console.log(`[session] Summarized session ${(session.id as string).slice(0, 8)} (${summary.length} chars)`);
    } catch (err) {
      console.error(`[session] Failed to summarize session ${(session.id as string).slice(0, 8)}:`, err);
    }
  } else {
    db.prepare('UPDATE sessions SET status = ?, summary = ? WHERE id = ?')
      .run('summarized', '(Brief session — fewer than 3 activities)', session.id as string);
  }

  getIO().emit('session_ended', {
    agentId,
    project: session.project as string,
    sessionId: session.session_id as string,
  });
}

export function getActiveSession(agentId: string): Session | null {
  const row = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get(agentId) as Record<string, unknown> | undefined;

  return row ? normalizeSession(row) : null;
}

export function getProjectSessions(project: string, limit = 20): Session[] {
  const rows = db.prepare(
    'SELECT * FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT ?'
  ).all(project, limit) as Record<string, unknown>[];

  return rows.map(normalizeSession);
}

export { normalizeSession };
