import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import type { Note } from '../types.js';

const router = Router();

function normalizeNote(row: Record<string, unknown>): Note {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    content: row.content as string,
    createdAt: (row.created_at ?? row.createdAt) as string,
    updatedAt: (row.updated_at ?? row.updatedAt) as string,
  };
}

// Get all notes for an agent
router.get('/:agentId/notes', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notes WHERE agent_id = ? ORDER BY updated_at DESC')
    .all(req.params.agentId) as Record<string, unknown>[];

  res.json(rows.map(normalizeNote));
});

// Create a note
router.post('/:agentId/notes', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO notes (id, agent_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.agentId, content.trim(), now, now);

  res.status(201).json(normalizeNote({
    id, agent_id: req.params.agentId, content: content.trim(),
    created_at: now, updated_at: now,
  }));
});

// Update a note
router.put('/:agentId/notes/:noteId', (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  const row = db.prepare('SELECT * FROM notes WHERE id = ? AND agent_id = ?')
    .get(req.params.noteId, req.params.agentId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Note not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
    .run(content.trim(), now, req.params.noteId);

  const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.noteId) as Record<string, unknown>;
  res.json(normalizeNote(updated));
});

// Delete a note
router.delete('/:agentId/notes/:noteId', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ? AND agent_id = ?')
    .run(req.params.noteId, req.params.agentId);
  res.status(204).send();
});

export default router;
