import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { normalizeSession, getProjectSessions } from '../lib/session-manager.js';

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
  const allowed = ['progress.md', 'decisions.md', 'gotchas.md'];
  if (!allowed.includes(filename)) {
    return res.status(400).json({ error: `Invalid filename. Allowed: ${allowed.join(', ')}` });
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
  const allowed = ['progress.md', 'decisions.md', 'gotchas.md'];
  if (!allowed.includes(filename)) {
    return res.status(400).json({ error: `Invalid filename. Allowed: ${allowed.join(', ')}` });
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

export default router;
