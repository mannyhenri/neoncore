/**
 * NeonCore MCP Server
 *
 * Exposes NeonCore as an MCP server that Codex CLI (and any MCP-compatible agent) can connect to.
 * Runs as a stdio process spawned by the agent — configured via ~/.codex/config.toml.
 *
 * Tools:
 *   neoncore_register          — register agent session with NeonCore dashboard
 *   neoncore_report            — log a tool execution to the activity feed
 *   neoncore_request_permission — request dashboard approval before acting (blocks up to 600s)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import os from 'os';

const BASE_URL = `http://localhost:${process.env.NEONCORE_PORT || 4040}`;
const AGENT_TYPE = 'codex';

// ---------------------------------------------------------------------------
// Helpers — never write to stdout (breaks JSON-RPC), only stderr
// ---------------------------------------------------------------------------
const log = (...args: unknown[]) => process.stderr.write(`[neoncore-mcp] ${args.join(' ')}\n`);

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'neoncore', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'neoncore_register',
      description:
        'Register this Codex session with the NeonCore dashboard. Call once at the start of each session so the agent appears in the NeonCore UI.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId:  { type: 'string', description: 'Unique session identifier' },
          machine:    { type: 'string', description: 'Hostname of the machine running the agent' },
          repoPath:   { type: 'string', description: 'Absolute path to the git repository root' },
          repoName:   { type: 'string', description: 'Repository name (basename of repoPath)' },
          branch:     { type: 'string', description: 'Current git branch' },
        },
        required: ['sessionId', 'repoPath'],
      },
    },
    {
      name: 'neoncore_report',
      description:
        'Log a tool execution to the NeonCore activity feed. Call after every file edit, write, or significant action so the dashboard stays in sync.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId:  { type: 'string', description: 'Session identifier from neoncore_register' },
          toolName:   { type: 'string', description: 'Name of the tool that was used (e.g. Edit, Write, Bash)' },
          toolInput:  { type: 'string', description: 'JSON-stringified tool input' },
          toolResult: { type: 'string', description: 'JSON-stringified tool result or output (truncated is fine)' },
          eventType:  {
            type: 'string',
            enum: ['tool_use', 'user_prompt', 'assistant_message'],
            description: 'Type of event',
          },
          repoPath:   { type: 'string', description: 'Absolute path to the repo root' },
        },
        required: ['sessionId', 'toolName', 'eventType'],
      },
    },
    {
      name: 'neoncore_request_permission',
      description:
        'Request dashboard approval before performing a significant action (file writes, destructive commands, etc). Blocks until the user approves or denies — respect the returned decision. For Bash commands, the existing hook system handles permissions automatically; use this for file operations and other non-Bash actions.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId:   { type: 'string', description: 'Session identifier from neoncore_register' },
          toolName:    { type: 'string', description: 'Name of the tool requiring permission (e.g. Write, Edit)' },
          toolInput:   { type: 'string', description: 'JSON-stringified description of the action' },
          description: { type: 'string', description: 'Human-readable summary of what you are about to do (120–200 chars)' },
          repoPath:    { type: 'string', description: 'Absolute path to the repo root' },
        },
        required: ['sessionId', 'toolName', 'description'],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === 'neoncore_register') {
    const { sessionId, machine, repoPath, repoName, branch } = args as Record<string, string>;
    try {
      const result = await post('/api/agents/register', {
        sessionId,
        machine:   machine || os.hostname(),
        repoPath:  repoPath || '',
        repoName:  repoName || repoPath?.split('/').pop() || '',
        branch:    branch   || 'unknown',
        agentType: AGENT_TYPE,
        status:    'working',
      }) as Record<string, unknown>;
      log(`Registered agent ${result.id} for session ${sessionId}`);
      return text(`Registered with NeonCore. Agent ID: ${result.id}. You are now visible on the NeonCore dashboard.`);
    } catch (err) {
      log(`Register failed: ${err}`);
      return text(`NeonCore registration failed (server may not be running): ${err}. Continuing without dashboard integration.`);
    }
  }

  if (name === 'neoncore_report') {
    const { sessionId, toolName, toolInput, toolResult, eventType, repoPath } = args as Record<string, string>;
    try {
      await post('/api/activity', {
        sessionId,
        machine:   os.hostname(),
        repoPath:  repoPath || '',
        agentType: AGENT_TYPE,
        eventType: eventType || 'tool_use',
        toolName,
        toolInput:  toolInput  ? JSON.parse(toolInput)  : {},
        toolResult: toolResult ? JSON.parse(toolResult) : {},
      });
      return text('Activity logged to NeonCore.');
    } catch (err) {
      log(`Report failed: ${err}`);
      return text('Activity log failed (non-critical). Continuing.');
    }
  }

  if (name === 'neoncore_request_permission') {
    const { sessionId, toolName, toolInput, description, repoPath } = args as Record<string, string>;
    try {
      // Create the permission request
      const created = await post('/api/permissions/request', {
        sessionId,
        machine:   os.hostname(),
        repoPath:  repoPath || '',
        agentType: AGENT_TYPE,
        toolName,
        toolInput:   toolInput ? JSON.parse(toolInput) : {},
        description: description || `${toolName} requested by Codex`,
      }) as { id: string; trustMode?: boolean };

      // Trust mode — immediately allowed
      if (created.trustMode) {
        return text('ALLOWED — trust mode is active, proceeding automatically.');
      }

      const permId = created.id;
      log(`Permission request created: ${permId} — waiting for dashboard decision`);

      // Poll in 55s chunks (under Codex's default 60s timeout per chunk;
      // config.toml sets tool_timeout_sec=600 so we can loop ~10 times)
      const MAX_ATTEMPTS = 10;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutMs = 55_000;
          const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);
          try {
            const poll = await get(
              `/api/permissions/poll/${permId}?timeout=${timeoutMs}`,
              controller.signal,
            ) as { decision: string; response?: string };
            clearTimeout(timer);

            if (poll.decision === 'allowed') {
              return text(`ALLOWED — the NeonCore dashboard approved this action. Proceed.`);
            }
            if (poll.decision === 'denied') {
              return text(`DENIED — the NeonCore dashboard denied this action. Do NOT proceed with "${toolName}". Ask the user how they'd like to continue.`);
            }
            // timeout response — loop and try again
            log(`Poll attempt ${attempt + 1} timed out, retrying`);
          } finally {
            clearTimeout(timer);
          }
        } catch (pollErr: unknown) {
          if ((pollErr as { name?: string })?.name === 'AbortError') {
            log(`Poll attempt ${attempt + 1} aborted, retrying`);
            continue;
          }
          throw pollErr;
        }
      }

      // Exhausted retries — default to denied for safety
      return text(`TIMEOUT — no response from NeonCore dashboard after ${MAX_ATTEMPTS} attempts. Treating as denied for safety. Do NOT proceed.`);

    } catch (err) {
      log(`Permission request failed: ${err}`);
      return text(`NeonCore permission check failed: ${err}. Pause and ask the user whether to proceed.`);
    }
  }

  return text(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
log('NeonCore MCP server ready');
