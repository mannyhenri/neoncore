import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import {
  startMcpServer,
  stopMcpServer,
  callMcpTool,
  listMcpTools,
  getAllServers,
} from '../lib/mcp-manager.js';
import type { McpServer, McpTool, McpRegistryEntry } from '../types.js';
import registryData from '../data/mcp-registry.json' with { type: 'json' };

const registry = registryData as McpRegistryEntry[];

const router = Router();

function normalizeServer(row: Record<string, unknown>): McpServer {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string) || '',
    command: row.command as string,
    args: JSON.parse((row.args as string) || '[]'),
    env: JSON.parse((row.env as string) || '{}'),
    isPreconfigured: (row.is_preconfigured as number) === 1,
    status: (row.status as McpServer['status']) || 'stopped',
    error: (row.error as string) || '',
    pid: (row.pid as number) || null,
    capabilities: JSON.parse((row.capabilities as string) || '[]'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// MCP Server Registry / Marketplace
router.get('/registry', (_req, res) => {
  const installedRows = db.prepare('SELECT slug FROM mcp_servers').all() as { slug: string }[];
  const installedSlugs = installedRows.map((r) => r.slug);
  const categories = [...new Set(registry.map((s) => s.category))].sort();
  res.json({ servers: registry, categories, installed: installedSlugs });
});

// List all MCP servers
router.get('/servers', (_req, res) => {
  res.json(getAllServers());
});

// Add a custom MCP server (also used by marketplace one-click install)
router.post('/servers', (req, res) => {
  const { command, name, args, env, slug: requestedSlug, description } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'command is required' });
  }

  // If slug already exists, return the existing server (idempotent marketplace install)
  if (requestedSlug) {
    const existing = db.prepare('SELECT * FROM mcp_servers WHERE slug = ?').get(requestedSlug) as Record<string, unknown> | undefined;
    if (existing) {
      return res.json(normalizeServer(existing));
    }
  }

  // Parse an npx command string like "npx @some/package --flag"
  let resolvedCommand = command;
  let resolvedArgs: string[] = args || [];
  if (!args && typeof command === 'string' && command.includes(' ')) {
    const parts = command.trim().split(/\s+/);
    resolvedCommand = parts[0];
    resolvedArgs = parts.slice(1);
  }

  const slug = requestedSlug || `custom-${Date.now()}`;
  const id = requestedSlug ? `mcp-${requestedSlug}` : uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO mcp_servers (id, name, slug, command, args, env, is_preconfigured, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'stopped', ?, ?, ?)
  `).run(id, name || slug, slug, resolvedCommand, JSON.stringify(resolvedArgs), JSON.stringify(env || {}), description || '', now, now);

  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(normalizeServer(row));
});

// Update an MCP server (env vars, command, name)
router.put('/servers/:id', (req, res) => {
  const { env, command, args, name } = req.body;
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'MCP server not found' });

  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (env !== undefined) { updates.push('env = ?'); values.push(JSON.stringify(env)); }
  if (command !== undefined) { updates.push('command = ?'); values.push(command); }
  if (args !== undefined) { updates.push('args = ?'); values.push(JSON.stringify(args)); }
  if (name !== undefined) { updates.push('name = ?'); values.push(name); }

  values.push(req.params.id);
  db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(normalizeServer(row));
});

// Delete an MCP server
router.delete('/servers/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'MCP server not found' });

  // Stop if running
  if ((row.status as string) === 'running') {
    try { await stopMcpServer(req.params.id); } catch { /* ignore */ }
  }

  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// Start an MCP server
router.post('/servers/:id/start', async (req, res) => {
  try {
    const server = await startMcpServer(req.params.id);
    res.json(server);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to start: ${msg}` });
  }
});

// Stop an MCP server
router.post('/servers/:id/stop', async (req, res) => {
  try {
    await stopMcpServer(req.params.id);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json(normalizeServer(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to stop: ${msg}` });
  }
});

// List tools for an MCP server
router.get('/servers/:id/tools', async (req, res) => {
  try {
    const tools = await listMcpTools(req.params.id);
    res.json(tools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// Call a tool on an MCP server
router.post('/servers/:id/tools/:toolName/call', async (req, res) => {
  try {
    const result = await callMcpTool(req.params.id, req.params.toolName, req.body.args || {});
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
