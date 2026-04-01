import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { startMcpServer, callMcpTool, listMcpTools } from '../lib/mcp-manager.js';
import { getIO } from '../ws.js';
import type { VirtualCartridge, McpTool } from '../types.js';

const router = Router();

function normalizeCartridge(row: Record<string, unknown>): VirtualCartridge {
  return {
    id: row.id as string,
    name: row.name as string,
    directoryPath: (row.directory_path as string) || '',
    iconIndex: (row.icon_index as number) || 0,
    color: (row.color as string) || '#a855f7',
    mcpServerIds: JSON.parse((row.mcp_server_ids as string) || '[]'),
    pinnedTools: JSON.parse((row.pinned_tools as string) || '[]'),
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
  const { name, directoryPath, mcpServerIds, color, iconIndex } = req.body;

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
    INSERT INTO virtual_cartridges (id, name, directory_path, icon_index, color, mcp_server_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, resolvedName, directoryPath,
    iconIndex ?? Math.floor(Math.random() * 16),
    color || '#a855f7',
    JSON.stringify(mcpServerIds || []),
    now, now
  );

  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(id) as Record<string, unknown>;
  const cartridge = normalizeCartridge(row);

  getIO().emit('virtual_cartridge_updated' as any, cartridge);
  res.status(201).json(cartridge);
});

// Update a virtual cartridge
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const { name, mcpServerIds, pinnedTools, color, iconIndex } = req.body;
  const now = new Date().toISOString();

  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (mcpServerIds !== undefined) { updates.push('mcp_server_ids = ?'); values.push(JSON.stringify(mcpServerIds)); }
  if (pinnedTools !== undefined) { updates.push('pinned_tools = ?'); values.push(JSON.stringify(pinnedTools)); }
  if (color !== undefined) { updates.push('color = ?'); values.push(color); }
  if (iconIndex !== undefined) { updates.push('icon_index = ?'); values.push(iconIndex); }

  values.push(req.params.id);
  db.prepare(`UPDATE virtual_cartridges SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  const cartridge = normalizeCartridge(row);

  getIO().emit('virtual_cartridge_updated' as any, cartridge);
  res.json(cartridge);
});

// Delete a virtual cartridge
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM virtual_cartridges WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Virtual cartridge not found' });

  db.prepare('DELETE FROM virtual_cartridges WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// List aggregated tools from enabled MCP servers
router.get('/:id/tools', async (req, res) => {
  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const serverIds: string[] = JSON.parse((row.mcp_server_ids as string) || '[]');
  const allTools: (McpTool & { serverId: string; serverName: string })[] = [];

  for (const serverId of serverIds) {
    try {
      const tools = await listMcpTools(serverId);
      const serverRow = db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(serverId) as { name: string } | undefined;
      for (const tool of tools) {
        allTools.push({ ...tool, serverId, serverName: serverRow?.name || serverId });
      }
    } catch {
      // Server might not be running — skip
    }
  }

  res.json(allTools);
});

// Execute an MCP tool in the context of this cartridge
router.post('/:id/execute', async (req, res) => {
  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const { serverId, toolName, args } = req.body;
  if (!serverId || !toolName) {
    return res.status(400).json({ error: 'serverId and toolName are required' });
  }

  const serverIds: string[] = JSON.parse((row.mcp_server_ids as string) || '[]');
  if (!serverIds.includes(serverId)) {
    return res.status(403).json({ error: 'MCP server not enabled for this cartridge' });
  }

  try {
    // Auto-start server if stopped
    const serverRow = db.prepare('SELECT status FROM mcp_servers WHERE id = ?').get(serverId) as { status: string } | undefined;
    if (serverRow && serverRow.status !== 'running') {
      await startMcpServer(serverId);
    }

    const result = await callMcpTool(serverId, toolName, args || {});
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
