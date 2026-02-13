import { Router } from 'express';
import db from '../db.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import type { Command } from '../types.js';

const router = Router();

// Send a command to an agent (from dashboard)
router.post('/send', (req, res) => {
  const { agentId, text, includeMemory } = req.body;

  if (!agentId || !text) {
    return res.status(400).json({ error: 'agentId and text required' });
  }

  const command = sendCommandToAgent(agentId, text, includeMemory !== false);
  if (!command) return res.status(404).json({ error: 'Agent not found' });

  res.status(201).json(command);
});

// Mark command as delivered (called by VS Code extension)
router.post('/delivered/:id', (req, res) => {
  const now = new Date().toISOString();
  db.prepare('UPDATE commands SET status = ?, delivered_at = ? WHERE id = ?')
    .run('delivered', now, req.params.id);
  res.json({ status: 'delivered' });
});

// Get pending commands for an agent
router.get('/pending/:agentId', (req, res) => {
  const commands = db
    .prepare('SELECT * FROM commands WHERE agent_id = ? AND status = ? ORDER BY created_at ASC')
    .all(req.params.agentId, 'pending') as Command[];
  res.json(commands);
});

export default router;
