/**
 * NeonCore MCP Server
 *
 * Exposes NeonCore as an MCP server that any MCP-compatible agent (Claude Code,
 * Codex, etc.) can connect to. Runs as a stdio process spawned by the agent.
 * Configure via NEONCORE_URL (full server URL — required for agents on other
 * machines) and NEONCORE_AGENT_TYPE.
 *
 * Tools:
 *   neoncore_register           — register agent session with NeonCore dashboard
 *   neoncore_report             — log a tool execution to the activity feed
 *   neoncore_request_permission — request dashboard approval before acting (blocks up to 600s)
 *   neoncore_report_step_done   — signal a workflow step is complete (reliable replacement for the curl webhook)
 *   neoncore_my_queue           — list tasks this agent can claim or has been assigned
 *   neoncore_claim_task         — atomically claim a queued task
 *   neoncore_report_task_done   — complete a claimed task with a result
 *   neoncore_list_agents        — see sibling agents for coordination
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import os from 'os';

// NEONCORE_URL wins (correct for remote agents pointing at the server's LAN URL);
// fall back to localhost:PORT for same-machine setups.
const BASE_URL = process.env.NEONCORE_URL || `http://localhost:${process.env.NEONCORE_PORT || 4040}`;
const AGENT_TYPE = process.env.NEONCORE_AGENT_TYPE || 'codex';

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
    {
      name: 'neoncore_report_step_done',
      description:
        'Signal that a NeonCore workflow step is fully complete. Call this (instead of curling the webhook) when you finish a step that was dispatched to you — the workflow stays paused until you do. Provide a result summary of what you did and what the next step should focus on.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
          stepId:    { type: 'string', description: 'The workflow step id (given in the task instructions)' },
          result:    { type: 'string', description: 'Summary of what was done + guidance for the next step' },
        },
        required: ['stepId', 'result'],
      },
    },
    {
      name: 'neoncore_my_queue',
      description:
        'List tasks you can work on right now: unassigned queued tasks plus any task already assigned to you. Use this to decide what to do next when you have no active instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'neoncore_claim_task',
      description:
        'Atomically claim a queued task so no other agent picks it up. Returns the task (incl. its prompt) on success, or tells you it was already claimed — in which case pick another from neoncore_my_queue.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
          taskId:    { type: 'string', description: 'The task id to claim (from neoncore_my_queue)' },
        },
        required: ['sessionId', 'taskId'],
      },
    },
    {
      name: 'neoncore_report_task_done',
      description:
        'Complete a task you claimed, recording the outcome. Set status to "failed" (with an error) if you could not finish.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
          taskId:    { type: 'string', description: 'The task id you claimed' },
          result:    { type: 'string', description: 'Summary of the outcome / what you produced' },
          status:    { type: 'string', enum: ['done', 'failed'], description: 'Defaults to "done"' },
          error:     { type: 'string', description: 'Error detail if status is "failed"' },
        },
        required: ['sessionId', 'taskId', 'result'],
      },
    },
    {
      name: 'neoncore_list_agents',
      description:
        'List the other agents currently known to NeonCore (machine, repo, status). Use for coordination — e.g. to avoid duplicating work another agent is already doing.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
        },
        required: ['sessionId'],
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

  if (name === 'neoncore_report_step_done') {
    const { stepId, result } = args as Record<string, string>;
    if (!stepId) return text('ERROR: stepId is required to report step completion.');
    try {
      await post(`/api/workflows/webhook/${stepId}/complete`, { result: result || 'Completed.' });
      log(`Step ${stepId} reported complete`);
      return text(`Step ${stepId} marked complete in NeonCore. The workflow will now advance.`);
    } catch (err) {
      log(`report_step_done failed: ${err}`);
      return text(`Could not mark step complete via NeonCore (${err}). As a fallback, run: curl -s -X POST ${BASE_URL}/api/workflows/webhook/${stepId}/complete -H 'Content-Type: application/json' -d '{"result":"..."}'`);
    }
  }

  if (name === 'neoncore_my_queue') {
    const { sessionId } = args as Record<string, string>;
    try {
      const tasks = await get(`/api/tasks/queue?sessionId=${encodeURIComponent(sessionId || '')}`) as Array<Record<string, unknown>>;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return text('Your NeonCore queue is empty — no tasks to claim right now.');
      }
      const lines = tasks.map((t) =>
        `- [${t.id}] (${t.status}, p${t.priority ?? 0}) ${t.title}${t.assignedAgentId ? ' [assigned to you]' : ''}`,
      );
      return text(`NeonCore queue (${tasks.length}):\n${lines.join('\n')}\n\nClaim one with neoncore_claim_task.`);
    } catch (err) {
      log(`my_queue failed: ${err}`);
      return text(`Could not fetch your NeonCore queue: ${err}.`);
    }
  }

  if (name === 'neoncore_claim_task') {
    const { sessionId, taskId } = args as Record<string, string>;
    if (!taskId) return text('ERROR: taskId is required.');
    try {
      const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.status === 409) {
        return text(`Task ${taskId} was already claimed by another agent. Pick a different one from neoncore_my_queue.`);
      }
      if (!res.ok) return text(`Could not claim task ${taskId}: ${res.status} ${await res.text()}`);
      const task = await res.json() as Record<string, unknown>;
      return text(`Claimed task ${taskId}: "${task.title}".\n\nInstructions:\n${task.prompt || '(no prompt)'}\n\nWhen finished, call neoncore_report_task_done.`);
    } catch (err) {
      log(`claim_task failed: ${err}`);
      return text(`Could not claim task ${taskId}: ${err}.`);
    }
  }

  if (name === 'neoncore_report_task_done') {
    const { sessionId, taskId, result, status, error } = args as Record<string, string>;
    if (!taskId) return text('ERROR: taskId is required.');
    try {
      await post(`/api/tasks/${taskId}/complete`, { sessionId, result, status: status || 'done', error });
      return text(`Task ${taskId} marked ${status === 'failed' ? 'failed' : 'done'} in NeonCore.`);
    } catch (err) {
      log(`report_task_done failed: ${err}`);
      return text(`Could not complete task ${taskId}: ${err}.`);
    }
  }

  if (name === 'neoncore_list_agents') {
    try {
      const agents = await get('/api/agents') as Array<Record<string, unknown>>;
      if (!Array.isArray(agents) || agents.length === 0) return text('No other agents registered in NeonCore.');
      const lines = agents.map((a) =>
        `- ${a.name || a.id} — ${a.repoName || ''} (${a.status}, ${a.agentType})`,
      );
      return text(`Agents known to NeonCore (${agents.length}):\n${lines.join('\n')}`);
    } catch (err) {
      log(`list_agents failed: ${err}`);
      return text(`Could not list agents: ${err}.`);
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
