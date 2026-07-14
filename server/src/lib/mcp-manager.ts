/**
 * MCP Server Process Manager
 *
 * Manages MCP server child processes using the official @modelcontextprotocol/sdk.
 * Handles start/stop/restart, tool discovery, tool invocation, and crash recovery.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import db from '../db.js';
import { getIO } from '../ws.js';
import type { McpServer, McpTool } from '../types.js';

interface ManagedServer {
  id: string;
  client: Client;
  transport: StdioClientTransport;
}

const runningServers = new Map<string, ManagedServer>();

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

function emitUpdate(serverId: string) {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as Record<string, unknown> | undefined;
  if (row) {
    getIO().emit('mcp_server_updated', normalizeServer(row));
  }
}

export async function startMcpServer(serverId: string): Promise<McpServer> {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`MCP server ${serverId} not found`);

  const command = row.command as string;
  if (!command) throw new Error(`MCP server ${serverId} has no command configured`);

  // Stop existing if running
  if (runningServers.has(serverId)) {
    await stopMcpServer(serverId);
  }

  const args: string[] = JSON.parse((row.args as string) || '[]');
  const env: Record<string, string> = JSON.parse((row.env as string) || '{}');

  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    const client = new Client(
      { name: 'neoncore', version: '0.2.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    // Get the child process PID if available
    const pid = (transport as unknown as { _process?: { pid?: number } })._process?.pid ?? null;

    runningServers.set(serverId, { id: serverId, client, transport });

    // Discover tools
    let tools: McpTool[] = [];
    try {
      const result = await client.listTools();
      tools = (result.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
      }));
    } catch {
      // Some servers may not support tool listing
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE mcp_servers SET status = 'running', error = '', pid = ?, capabilities = ?, updated_at = ?
      WHERE id = ?
    `).run(pid, JSON.stringify(tools), now, serverId);

    // Listen for process exit
    const proc = (transport as unknown as { _process?: { on?: Function } })._process;
    if (proc?.on) {
      proc.on('exit', (code: number | null) => {
        runningServers.delete(serverId);
        const exitNow = new Date().toISOString();
        db.prepare(`
          UPDATE mcp_servers SET status = 'error', error = ?, pid = NULL, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(`Process exited with code ${code}`, exitNow, serverId);
        emitUpdate(serverId);
        console.log(`[mcp] Server ${serverId} process exited (code=${code})`);
      });
    }

    emitUpdate(serverId);
    console.log(`[mcp] Started ${row.name} (${serverId}), discovered ${tools.length} tool(s)`);

    return normalizeServer(
      db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as Record<string, unknown>
    );
  } catch (err) {
    const now = new Date().toISOString();
    const errMsg = err instanceof Error ? err.message : String(err);
    db.prepare(`
      UPDATE mcp_servers SET status = 'error', error = ?, pid = NULL, updated_at = ?
      WHERE id = ?
    `).run(errMsg, now, serverId);
    emitUpdate(serverId);
    throw err;
  }
}

export async function stopMcpServer(serverId: string): Promise<void> {
  const managed = runningServers.get(serverId);
  if (managed) {
    try {
      await managed.transport.close();
    } catch {
      // Process may already be dead
    }
    runningServers.delete(serverId);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE mcp_servers SET status = 'stopped', error = '', pid = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, serverId);
  emitUpdate(serverId);
  console.log(`[mcp] Stopped server ${serverId}`);
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const managed = runningServers.get(serverId);
  if (!managed) throw new Error(`MCP server ${serverId} is not running`);

  const result = await managed.client.callTool({ name: toolName, arguments: args });
  return result;
}

export async function listMcpTools(serverId: string): Promise<McpTool[]> {
  const managed = runningServers.get(serverId);
  if (!managed) {
    // Return cached capabilities from DB
    const row = db.prepare('SELECT capabilities FROM mcp_servers WHERE id = ?').get(serverId) as { capabilities: string } | undefined;
    return row ? JSON.parse(row.capabilities) : [];
  }

  try {
    const result = await managed.client.listTools();
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: (t.inputSchema || {}) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}


export function getAllServers(): McpServer[] {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY is_preconfigured DESC, name ASC').all() as Record<string, unknown>[];
  return rows.map(normalizeServer);
}

/** Restore MCP servers that were running before server restart */
export async function restoreRunningServers(): Promise<void> {
  const rows = db.prepare("SELECT id, name FROM mcp_servers WHERE status = 'running'").all() as { id: string; name: string }[];
  if (rows.length === 0) return;

  console.log(`[mcp] Restoring ${rows.length} previously running server(s)...`);
  for (const row of rows) {
    try {
      await startMcpServer(row.id);
    } catch (err) {
      console.error(`[mcp] Failed to restore ${row.name}: ${err}`);
    }
  }
}
