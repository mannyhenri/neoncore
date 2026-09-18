import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { normalizeSession, getProjectSessions } from '../lib/session-manager.js';
import { KNOWLEDGE_FILES, isKnowledgeFile } from '../lib/knowledge-files.js';

const router = Router();

// ── List all projects with session counts ──

router.get('/projects', (_req, res) => {
  const rows = db.prepare(`
    SELECT project, COUNT(*) as session_count, MAX(started_at) as last_session
    FROM sessions
    WHERE project != ''
    GROUP BY project
    ORDER BY last_session DESC
  `).all() as { project: string; session_count: number; last_session: string }[];

  res.json(rows.map((r) => ({
    project: r.project,
    sessionCount: r.session_count,
    lastSession: r.last_session,
  })));
});

// ── List sessions for a project ──

router.get('/projects/:project/sessions', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const sessions = getProjectSessions(req.params.project, limit);
  res.json(sessions);
});

// ── Get a specific session (with full summary) ──

router.get('/sessions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?')
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: 'Session not found' });
  res.json(normalizeSession(row));
});

// ── Read a project knowledge file ──

router.get('/projects/:project/knowledge/:filename', (req, res) => {
  const { project, filename } = req.params;
  // The registry, not a third and fourth copy of the list — these two routes each carried
  // their own, which is how a file can end up writable but unlisted.
  if (!isKnowledgeFile(filename)) {
    return res.status(400).json({ error: `Invalid filename. Allowed: ${KNOWLEDGE_FILES.join(', ')}` });
  }

  const row = db.prepare(
    'SELECT * FROM project_knowledge WHERE project = ? AND filename = ?'
  ).get(project, filename) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: 'Knowledge file not found' });

  res.json({
    id: row.id as string,
    project: row.project as string,
    filename: row.filename as string,
    content: row.content as string,
    updatedAt: row.updated_at as string,
  });
});

// ── Update a project knowledge file ──

router.put('/projects/:project/knowledge/:filename', (req, res) => {
  const { project, filename } = req.params;
  const { content } = req.body;
  // The registry, not a third and fourth copy of the list — these two routes each carried
  // their own, which is how a file can end up writable but unlisted.
  if (!isKnowledgeFile(filename)) {
    return res.status(400).json({ error: `Invalid filename. Allowed: ${KNOWLEDGE_FILES.join(', ')}` });
  }

  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) required' });
  }

  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id FROM project_knowledge WHERE project = ? AND filename = ?'
  ).get(project, filename) as { id: string } | undefined;

  if (existing) {
    db.prepare('UPDATE project_knowledge SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, now, existing.id);
  } else {
    const id = uuid();
    db.prepare('INSERT INTO project_knowledge (id, project, filename, content, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, project, filename, content, now);
  }

  res.json({ ok: true });
});

// ── Completion reports for a project ──
//
// What replaced progress.md / decisions.md / gotchas.md. Those were appended on every hook and
// read by nobody; this is written once per run, by the agent that did the work, and is the
// structured half of the report it rendered.

router.get('/projects/:project/reports', (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const rows = db.prepare(
    `SELECT id, project, workflow_id, step_id, workflow_name, run_number, status, report, created_at
       FROM workflow_reports WHERE project = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(req.params.project, limit) as Record<string, unknown>[];

  res.json(rows.map((r) => ({
    id: r.id as string,
    project: r.project as string,
    workflowId: r.workflow_id as string,
    stepId: r.step_id as string,
    workflowName: r.workflow_name as string,
    runNumber: r.run_number as number,
    status: r.status as string,
    createdAt: r.created_at as string,
    // Parsed, not handed back as a string — every consumer would otherwise parse it itself,
    // and one of them would forget the try/catch.
    report: (() => {
      try { return JSON.parse((r.report as string) || '{}'); } catch { return {}; }
    })(),
  })));
});

// ── Project-scoped notes ──

interface NoteRow {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

router.get('/projects/:project/notes', (req, res) => {
  const rows = db.prepare(
    "SELECT id, content, created_at, updated_at FROM notes WHERE project = ? ORDER BY updated_at DESC"
  ).all(req.params.project) as NoteRow[];

  res.json(rows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
});

router.post('/projects/:project/notes', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });

  // Find any agent for this project to satisfy the foreign key
  const agent = db.prepare("SELECT id FROM agents WHERE repo_name = ? LIMIT 1").get(req.params.project) as { id: string } | undefined;
  const agentId = agent?.id || '';

  const id = uuid();
  const now = new Date().toISOString();

  if (agentId) {
    db.prepare(
      "INSERT INTO notes (id, agent_id, project, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, agentId, req.params.project, content.trim(), now, now);
  } else {
    // No agent exists yet — insert without FK (SQLite only enforces FK if PRAGMA foreign_keys=ON)
    db.prepare(
      "INSERT INTO notes (id, agent_id, project, content, created_at, updated_at) VALUES (?, '__project__', ?, ?, ?, ?)"
    ).run(id, req.params.project, content.trim(), now, now);
  }

  res.status(201).json({ id, content: content.trim(), createdAt: now, updatedAt: now });
});

router.put('/projects/:project/notes/:noteId', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });

  const now = new Date().toISOString();
  db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND project = ?')
    .run(content.trim(), now, req.params.noteId, req.params.project);

  res.json({ id: req.params.noteId, content: content.trim(), updatedAt: now });
});

router.delete('/projects/:project/notes/:noteId', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ? AND project = ?')
    .run(req.params.noteId, req.params.project);
  res.status(204).send();
});

// ── Full-text search over journal sessions and knowledge files ──

router.get('/search', (req, res) => {
  const q = (req.query.q as string || '').trim();
  const project = req.query.project as string | undefined;

  if (!q || q.length < 2) {
    return res.json({ sessions: [], knowledge: [] });
  }

  const likePattern = `%${q.replace(/[%_]/g, '\\$&')}%`;

  function likeSnippet(text: string, term: string): string {
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx === -1) return text.slice(0, 150) + '…';
    const start = Math.max(0, idx - 50);
    const end = Math.min(text.length, idx + term.length + 50);
    const snip = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    return snip.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<b>$&</b>');
  }

  // Search session summaries
  const summaryRows = project
    ? db.prepare(`SELECT id, project, started_at, summary FROM sessions WHERE project = ? AND summary LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 10`)
        .all(project, likePattern) as { id: string; project: string; started_at: string; summary: string }[]
    : db.prepare(`SELECT id, project, started_at, summary FROM sessions WHERE summary LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 10`)
        .all(likePattern) as { id: string; project: string; started_at: string; summary: string }[];

  // Search activity logs (tool_input contains file paths, commands, outputs)
  // Join agents to get project, join sessions to get session metadata
  const activityRows = project
    ? db.prepare(`
        SELECT DISTINCT s.id, s.project, s.started_at, a.tool_input as match_text
        FROM activity a
        JOIN agents ag ON a.agent_id = ag.id
        JOIN sessions s ON s.session_id = ag.session_id AND s.project = ag.repo_name
        WHERE ag.repo_name = ? AND a.tool_input LIKE ? ESCAPE '\\'
        ORDER BY s.started_at DESC
        LIMIT 10
      `).all(project, likePattern) as { id: string; project: string; started_at: string; match_text: string }[]
    : db.prepare(`
        SELECT DISTINCT s.id, s.project, s.started_at, a.tool_input as match_text
        FROM activity a
        JOIN agents ag ON a.agent_id = ag.id
        JOIN sessions s ON s.session_id = ag.session_id AND s.project = ag.repo_name
        WHERE a.tool_input LIKE ? ESCAPE '\\'
        ORDER BY s.started_at DESC
        LIMIT 10
      `).all(likePattern) as { id: string; project: string; started_at: string; match_text: string }[];

  // Merge: summary matches first, then activity matches not already included
  const seen = new Set(summaryRows.map((r) => r.id));
  const sessionRows = [
    ...summaryRows.map((r) => ({ id: r.id, project: r.project, startedAt: r.started_at, summary: likeSnippet(r.summary, q) })),
    ...activityRows
      .filter((r) => !seen.has(r.id))
      .map((r) => ({ id: r.id, project: r.project, startedAt: r.started_at, summary: `[activity log] ${likeSnippet(r.match_text, q)}` })),
  ].slice(0, 10);

  // Search knowledge files
  const knowledgeRows = project
    ? db.prepare(`SELECT project, filename, content FROM project_knowledge WHERE project = ? AND content LIKE ? ESCAPE '\\' LIMIT 10`)
        .all(project, likePattern) as { project: string; filename: string; content: string }[]
    : db.prepare(`SELECT project, filename, content FROM project_knowledge WHERE content LIKE ? ESCAPE '\\' LIMIT 10`)
        .all(likePattern) as { project: string; filename: string; content: string }[];

  res.json({
    sessions: sessionRows,
    knowledge: knowledgeRows.map((r) => ({ project: r.project, filename: r.filename, snippet: likeSnippet(r.content, q) })),
  });
});

export default router;
