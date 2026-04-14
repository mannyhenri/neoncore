import { Router } from 'express';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { startMcpServer, callMcpTool, listMcpTools } from '../lib/mcp-manager.js';
import { openDirectory } from '../lib/open-directory.js';
import { getIO } from '../ws.js';
import type { VirtualCartridge, McpTool } from '../types.js';

// Static map of common MCP tool names → friendly suggestion metadata
const TOOL_SUGGESTION_MAP: Record<string, { title: string; promptTemplate: string }> = {
  search_files:          { title: 'Search Files',       promptTemplate: 'Search the project files for relevant code and content.' },
  read_file:             { title: 'Read File',           promptTemplate: 'Read and summarize the contents of a key file in this project.' },
  list_directory:        { title: 'List Directory',      promptTemplate: 'List the directory structure of this project.' },
  create_issue:          { title: 'Create Issue',        promptTemplate: 'Create a new GitHub issue summarizing the current task or bug.' },
  list_issues:           { title: 'List Issues',         promptTemplate: 'List all open issues in this repository.' },
  create_pull_request:   { title: 'Create PR',           promptTemplate: 'Create a pull request for the current branch with a clear description.' },
  search:                { title: 'Web Search',          promptTemplate: 'Search the web for relevant documentation or solutions.' },
  fetch:                 { title: 'Fetch URL',           promptTemplate: 'Fetch and summarize content from a specific URL.' },
  brave_web_search:      { title: 'Web Search',          promptTemplate: 'Search the web for relevant documentation or solutions.' },
  send_message:          { title: 'Send Message',        promptTemplate: 'Send a status update message to the configured channel.' },
  create_note:           { title: 'Create Note',         promptTemplate: 'Create a note capturing the current task progress and findings.' },
  get_file:              { title: 'Get Drive File',      promptTemplate: 'Get a file from Google Drive relevant to this project.' },
  list_files:            { title: 'List Drive Files',    promptTemplate: 'List files in Google Drive related to this project.' },
  bash:                  { title: 'Run Command',         promptTemplate: 'Run a shell command to check the project status or run tests.' },
  execute_python:        { title: 'Run Python',          promptTemplate: 'Execute a Python script or command in this project.' },
};

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
    ntfyUrl: (row.ntfy_url as string) || '',
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

  getIO().emit('virtual_cartridge_updated', cartridge);
  res.status(201).json(cartridge);
});

// Update a virtual cartridge
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const { name, mcpServerIds, pinnedTools, color, iconIndex, ntfyUrl } = req.body;
  const now = new Date().toISOString();

  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (mcpServerIds !== undefined) { updates.push('mcp_server_ids = ?'); values.push(JSON.stringify(mcpServerIds)); }
  if (pinnedTools !== undefined) { updates.push('pinned_tools = ?'); values.push(JSON.stringify(pinnedTools)); }
  if (color !== undefined) { updates.push('color = ?'); values.push(color); }
  if (iconIndex !== undefined) { updates.push('icon_index = ?'); values.push(iconIndex); }
  if (ntfyUrl !== undefined) { updates.push('ntfy_url = ?'); values.push(ntfyUrl); }

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

// Suggest quick actions based on the cartridge's enabled MCP server tools
router.get('/:id/suggestions', async (req, res) => {
  const row = db.prepare('SELECT * FROM virtual_cartridges WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Virtual cartridge not found' });

  const serverIds: string[] = JSON.parse((row.mcp_server_ids as string) || '[]');
  if (serverIds.length === 0) return res.json({ suggestions: [] });

  interface Suggestion { title: string; prompt: string; toolName: string; serverId: string }
  const suggestions: Suggestion[] = [];

  for (const serverId of serverIds) {
    if (suggestions.length >= 5) break;
    const serverRow = db.prepare('SELECT status, name FROM mcp_servers WHERE id = ?').get(serverId) as { status: string; name: string } | undefined;
    if (!serverRow || serverRow.status !== 'running') continue;

    try {
      const tools = await listMcpTools(serverId);
      for (const tool of tools) {
        if (suggestions.length >= 5) break;
        const known = TOOL_SUGGESTION_MAP[tool.name.toLowerCase()];
        if (known) {
          suggestions.push({ title: known.title, prompt: known.promptTemplate, toolName: tool.name, serverId });
        } else if (tool.description) {
          // Generic fallback: derive title from tool name, use description as prompt
          const title = tool.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          suggestions.push({ title, prompt: tool.description.slice(0, 200), toolName: tool.name, serverId });
        }
      }
    } catch {
      // Server may have stopped — skip it
    }
  }

  res.json({ suggestions });
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
