import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import type { CommandTemplate } from '../types.js';

const router = Router();

function normalize(row: Record<string, unknown>): CommandTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    content: row.content as string,
    category: row.category as string,
    createdAt: (row.created_at ?? row.createdAt) as string,
    updatedAt: (row.updated_at ?? row.updatedAt) as string,
  };
}

// List all command templates
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM command_templates ORDER BY category, name').all() as Record<string, unknown>[];
  res.json(rows.map(normalize));
});

// Create a command template
router.post('/', (req, res) => {
  const { name, content, category } = req.body;
  if (!name?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'name and content required' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO command_templates (id, name, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name.trim(), content.trim(), (category || 'Custom').trim(), now, now);

  res.status(201).json(normalize({
    id, name: name.trim(), content: content.trim(),
    category: (category || 'Custom').trim(), created_at: now, updated_at: now,
  }));
});

// Update a command template
router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM command_templates WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Command template not found' });

  const { name, content, category } = req.body;
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE command_templates SET name = ?, content = ?, category = ?, updated_at = ? WHERE id = ?'
  ).run(
    (name?.trim() || row.name) as string,
    (content?.trim() || row.content) as string,
    (category?.trim() || row.category) as string,
    now,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM command_templates WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalize(updated));
});

// Delete a command template
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM command_templates WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

export default router;
