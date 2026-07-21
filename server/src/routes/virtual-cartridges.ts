import { Router } from 'express';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { openDirectory } from '../lib/open-directory.js';
import { getIO } from '../ws.js';
import type { VirtualCartridge } from '../types.js';

const router = Router();

function normalizeCartridge(row: Record<string, unknown>): VirtualCartridge {
  return {
    id: row.id as string,
    name: row.name as string,
    directoryPath: (row.directory_path as string) || '',
    iconIndex: (row.icon_index as number) || 0,
    color: (row.color as string) || '#a855f7',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// List all virtual cartridges
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM virtual_cartridges ORDER BY name').all() as Record<string, unknown>[];
  res.json(rows.map(normalizeCartridge));
});

// Create a virtual cartridge
router.post('/', (req, res) => {
  const { name, directoryPath, color, iconIndex } = req.body;

  if (!directoryPath) {
    return res.status(400).json({ error: 'directoryPath is required' });
  }

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM virtual_cartridges WHERE directory_path = ?').get(directoryPath);
  if (existing) {
    return res.status(409).json({ error: 'A virtual cartridge already exists for this directory' });
  }

  const id = uuid();
  const now = new Date().toISOString();
  const resolvedName = name || directoryPath.split('/').pop() || 'Untitled';

  db.prepare(`
    INSERT INTO virtual_cartridges (id, name, directory_path, icon_index, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, resolvedName, directoryPath,
    iconIndex ?? Math.floor(Math.random() * 16),
    color || '#a855f7',
    now, now
  );

  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(id) as Record<string, unknown>;
  const cartridge = normalizeCartridge(row);

  getIO().emit('virtual_cartridge_updated', cartridge);
  res.status(201).json(cartridge);
});

// Update a virtual cartridge
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const { name, color, iconIndex } = req.body;
  const now = new Date().toISOString();

  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (color !== undefined) { updates.push('color = ?'); values.push(color); }
  if (iconIndex !== undefined) { updates.push('icon_index = ?'); values.push(iconIndex); }

  values.push(req.params.id);
  db.prepare(`UPDATE virtual_cartridges SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  const cartridge = normalizeCartridge(row);

  getIO().emit('virtual_cartridge_updated', cartridge);
  res.json(cartridge);
});

// Delete a virtual cartridge
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM virtual_cartridges WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Virtual cartridge not found' });

  db.prepare('DELETE FROM virtual_cartridges WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// Launch an agent extension (Claude CC, Gridlight, CLI) in the cartridge's directory
router.post('/:id/launch', (req, res) => {
  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const { agentType } = req.body;
  if (!agentType || typeof agentType !== 'string') {
    return res.status(400).json({ error: 'agentType is required' });
  }

  const dirPath = row.directory_path as string;
  if (!fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Directory no longer exists on disk' });
  }

  const err = openDirectory(dirPath, agentType);
  if (err) return res.status(500).json({ error: err });
  res.json({ ok: true });
});

export default router;
