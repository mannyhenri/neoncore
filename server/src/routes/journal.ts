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
  const allowed = ['progress.md', 'decisions.md', 'gotchas.md', 'details.md'];
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
  const allowed = ['progress.md', 'decisions.md', 'gotchas.md', 'details.md'];
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

  // Escape FTS5 special characters
  const ftsQuery = q.replace(/['"*]/g, ' ').trim();
  if (!ftsQuery) return res.json({ sessions: [], knowledge: [] });

  try {
    // Search sessions via FTS5
    const sessionRows = project
      ? db.prepare(`
          SELECT s.id, s.project, s.started_at,
            snippet(sessions_fts, 0, '<b>', '</b>', '…', 20) as snippet
          FROM sessions_fts
          JOIN sessions s ON sessions_fts.rowid = s.rowid
          WHERE sessions_fts MATCH ? AND sessions_fts.project = ?
          ORDER BY rank
          LIMIT 10
        `).all(ftsQuery, project) as { id: string; project: string; started_at: string; snippet: string }[]
      : db.prepare(`
          SELECT s.id, s.project, s.started_at,
            snippet(sessions_fts, 0, '<b>', '</b>', '…', 20) as snippet
          FROM sessions_fts
          JOIN sessions s ON sessions_fts.rowid = s.rowid
          WHERE sessions_fts MATCH ?
          ORDER BY rank
          LIMIT 10
        `).all(ftsQuery) as { id: string; project: string; started_at: string; snippet: string }[];

    // Search knowledge files
    const knowledgeRows = project
      ? db.prepare(`
          SELECT pk.project, pk.filename,
            snippet(knowledge_fts, 0, '<b>', '</b>', '…', 20) as snippet
          FROM knowledge_fts
          JOIN project_knowledge pk ON knowledge_fts.rowid = pk.rowid
          WHERE knowledge_fts MATCH ? AND knowledge_fts.project = ?
          ORDER BY rank
          LIMIT 10
        `).all(ftsQuery, project) as { project: string; filename: string; snippet: string }[]
      : db.prepare(`
          SELECT pk.project, pk.filename,
            snippet(knowledge_fts, 0, '<b>', '</b>', '…', 20) as snippet
          FROM knowledge_fts
          JOIN project_knowledge pk ON knowledge_fts.rowid = pk.rowid
          WHERE knowledge_fts MATCH ?
          ORDER BY rank
          LIMIT 10
        `).all(ftsQuery) as { project: string; filename: string; snippet: string }[];

    res.json({
      sessions: sessionRows.map((r) => ({
        id: r.id,
        project: r.project,
        startedAt: r.started_at,
        summary: r.snippet,
      })),
      knowledge: knowledgeRows.map((r) => ({
        project: r.project,
        filename: r.filename,
        snippet: r.snippet,
      })),
    });
  } catch {
    // FTS5 not available or query syntax error — fall back to LIKE
    const likePattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const sessionRows = project
      ? db.prepare(`SELECT id, project, started_at, summary FROM sessions WHERE project = ? AND summary LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 10`)
          .all(project, likePattern) as { id: string; project: string; started_at: string; summary: string }[]
      : db.prepare(`SELECT id, project, started_at, summary FROM sessions WHERE summary LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 10`)
          .all(likePattern) as { id: string; project: string; started_at: string; summary: string }[];

    const knowledgeRows = project
      ? db.prepare(`SELECT project, filename, content FROM project_knowledge WHERE project = ? AND content LIKE ? ESCAPE '\\' LIMIT 10`)
          .all(project, likePattern) as { project: string; filename: string; content: string }[]
      : db.prepare(`SELECT project, filename, content FROM project_knowledge WHERE content LIKE ? ESCAPE '\\' LIMIT 10`)
          .all(likePattern) as { project: string; filename: string; content: string }[];

    function likeSnippet(text: string, term: string): string {
      const idx = text.toLowerCase().indexOf(term.toLowerCase());
      if (idx === -1) return text.slice(0, 150) + '…';
      const start = Math.max(0, idx - 50);
      const end = Math.min(text.length, idx + term.length + 50);
      const snip = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      return snip.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<b>$&</b>');
    }

    res.json({
      sessions: sessionRows.map((r) => ({ id: r.id, project: r.project, startedAt: r.started_at, summary: likeSnippet(r.summary, q) })),
      knowledge: knowledgeRows.map((r) => ({ project: r.project, filename: r.filename, snippet: likeSnippet(r.content, q) })),
    });
  }
});

export default router;
