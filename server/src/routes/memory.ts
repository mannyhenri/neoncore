import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { AgentMemory } from '../types.js';

const router = Router();

// Get all memory entries for an agent
router.get('/:agentId/memory', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC')
    .all(req.params.agentId) as Record<string, unknown>[];

  res.json(rows.map(normalizeMemory));
});

// Add a memory entry
router.post('/:agentId/memory', (req, res) => {
  const { category, content, project, source } = req.body;
  const agentId = req.params.agentId;

  if (!category || !content) {
    return res.status(400).json({ error: 'category and content required' });
  }

  // Resolve project from agent if not provided
  let resolvedProject = project || '';
  if (!resolvedProject) {
    const agent = db.prepare('SELECT repo_name FROM agents WHERE id = ?').get(agentId) as { repo_name: string } | undefined;
    resolvedProject = agent?.repo_name || '';
  }

  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_memory (id, agent_id, project, category, content, source, created_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, agentId, resolvedProject, category, content, source || 'manual', now);

  const memory: AgentMemory = {
    id,
    agentId,
    project: resolvedProject,
    category,
    content,
    source: (source || 'manual') as 'auto' | 'manual',
    active: false,
    createdAt: now,
  };

  getIO().emit('memory_updated', { agentId });
  res.status(201).json(memory);
});

// Toggle memory active state
router.patch('/:agentId/memory/:memoryId/toggle', (req, res) => {
  const { agentId, memoryId } = req.params;
  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ? AND agent_id = ?').get(memoryId, agentId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Memory not found' });

  const newActive = row.active ? 0 : 1;
  db.prepare('UPDATE agent_memory SET active = ? WHERE id = ?').run(newActive, memoryId);

  const updated = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(memoryId) as Record<string, unknown>;
  getIO().emit('memory_updated', { agentId });
  res.json(normalizeMemory(updated));
});

// Delete a memory entry
router.delete('/:agentId/memory/:memoryId', (req, res) => {
  db.prepare('DELETE FROM agent_memory WHERE id = ? AND agent_id = ?')
    .run(req.params.memoryId, req.params.agentId);

  getIO().emit('memory_updated', { agentId: req.params.agentId });
  res.status(204).send();
});

function normalizeMemory(row: Record<string, unknown>): AgentMemory {
  return {
    id: row.id as string,
    agentId: (row.agent_id ?? row.agentId) as string,
    project: (row.project as string) ?? '',
    category: row.category as string,
    content: row.content as string,
    source: (row.source as 'auto' | 'manual') ?? 'manual',
    active: row.active !== 0 && row.active !== false,
    createdAt: (row.created_at ?? row.createdAt) as string,
  };
}

export default router;
