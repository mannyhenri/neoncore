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
 *   neoncore_submit_goal_draft  — submit a proposed goal intent (a draft; changes nothing)
 *   neoncore_submit_goal_decomposition — submit a proposed goal → projects → tasks plan (creates nothing)
 *   neoncore_list_agents        — see sibling agents for coordination
 *   neoncore_message_agent      — send a message into another agent's session (confer/hand off)
 *   neoncore_read_agent         — read another agent's recent transcript
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import os from 'os';
import { getServerBaseUrl } from './lib/server-url.js';

// NEONCORE_URL wins (correct for remote agents pointing at the server's LAN URL);
// otherwise derive from the machine's network name — for a same-machine setup that
// resolves to the same host the orchestrator advertises.
const BASE_URL = getServerBaseUrl();
const AGENT_TYPE = process.env.NEONCORE_AGENT_TYPE || 'codex';

// ---------------------------------------------------------------------------
// Helpers — never write to stdout (breaks JSON-RPC), only stderr
// ---------------------------------------------------------------------------
const log = (...args: unknown[]) => process.stderr.write(`[neoncore-mcp] ${args.join(' ')}\n`);

/**
 * The fleet token for this MCP process.
 *
 * Runs as its own process — often on a DIFFERENT machine from the server — so it cannot call
 * getFleetToken(), which reads the server's database. Same contract as the relay and the
 * hooks: env first so a remote agent can point at another fleet, then the file the server
 * publishes locally. Read per call rather than cached, so rotating the token does not require
 * restarting every MCP client.
 */
function authHeaders(): Record<string, string> {
  const env = (process.env.NEONCORE_FLEET_TOKEN || '').trim();
  if (env) return { Authorization: `Bearer ${env}` };
  try {
    const t = readFileSync(join(homedir(), '.neoncore', 'token'), 'utf8').trim();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders(), signal });
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
        'Signal that a NeonCore workflow step is fully complete. Call this (instead of curling the webhook) when you finish a step that was dispatched to you — the workflow stays paused until you do. Under the NeonCore work standard a step is not complete until it is VERIFIED: scope and verify are required, and a step reported without real verification output is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
          stepId:    { type: 'string', description: 'The workflow step id (given in the task instructions)' },
          panelAgentId: { type: 'string', description: 'Only for a PANEL step: your agent id, given in the task instructions. Omit for a normal step.' },
          result:    { type: 'string', description: 'Summary of what was done + guidance for the next step' },
          scope:     { type: 'string', description: 'Completed vs total items this step covered, e.g. "15/15 — 12 sections + 3 attachment types". Enumerate from the code, not the description.' },
          verify:    { type: 'string', description: 'The exact command you ran and its REAL output, e.g. "npm test -- report-copy → 15 passed". Never report verification you did not perform.' },
          deferred:  { type: 'string', description: 'Anything in scope you did not do, and why. "none" if nothing.' },
        },
        required: ['stepId', 'result', 'scope', 'verify'],
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
        'Complete a task you claimed, recording the outcome. Under the NeonCore work standard a task is not done until it is VERIFIED — scope and verify are required for status "done", and the server rejects a completion whose verify field has no real command output. Set status to "failed" (with an error) if you could not finish; a failure honestly reported is always preferred over a "done" that was never verified.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
          taskId:    { type: 'string', description: 'The task id you claimed' },
          result:    { type: 'string', description: 'Summary of the outcome / what you produced' },
          scope:     { type: 'string', description: 'Completed vs total items the ask covered, e.g. "15/15 — 12 report sections + 3 attachment types, per REPORT_SECTIONS". Enumerate from the code, not the description.' },
          verify:    { type: 'string', description: 'The exact command you ran and its REAL output, e.g. "npm test -- report-copy → 15 passed, 0 failed". Required for "done".' },
          deferred:  { type: 'string', description: 'Anything in scope you did not do, and why. "none" if nothing.' },
          status:    { type: 'string', enum: ['done', 'failed'], description: 'Defaults to "done"' },
          error:     { type: 'string', description: 'Error detail if status is "failed"' },
        },
        required: ['sessionId', 'taskId', 'result', 'scope', 'verify'],
      },
    },
    {
      name: 'neoncore_submit_goal_draft',
      description:
        'Submit a DRAFT of a goal\'s intent that you were asked to write. This stores a proposal only — it does NOT change the goal. The user reviews your draft field by field and chooses what to keep, so do not also edit the goal yourself through any other route. Omit any field you cannot ground in what the user actually said: these fields are injected into every prompt dispatched under this goal, so an invented acceptance criterion or a fabricated baseline becomes an instruction that other agents act on. A partial draft is a good draft.',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string', description: 'The draft id given to you in the request' },
          fields: {
            type: 'object',
            description: 'Proposed values, keyed exactly as the request listed them.',
            properties: {
              description:        { type: 'string', description: 'Why this matters — the outcome and why now. No implementation detail.' },
              successMetric:      { type: 'string', description: 'One sentence: the observable condition that means this goal is done.' },
              acceptanceCriteria: { type: 'string', description: 'EARS-form statements, one per line: "When <trigger>, the system shall <response>."' },
              invariants:         { type: 'string', description: 'What must stay true throughout — behaviour that may not regress.' },
              noGos:              { type: 'string', description: 'Explicitly out of scope. Concrete about what NOT to touch.' },
              rabbitHoles:        { type: 'string', description: 'Known time sinks to steer around, and why each is a trap.' },
              keyResults: {
                type: 'array',
                description: 'Up to 4 measurable results. Omit entirely if nothing is genuinely measurable.',
                items: {
                  type: 'object',
                  properties: {
                    metric:   { type: 'string' },
                    baseline: { type: 'string' },
                    target:   { type: 'string' },
                    measure:  { type: 'string' },
                  },
                  required: ['metric'],
                },
              },
            },
          },
        },
        required: ['draftId', 'fields'],
      },
    },
    {
      name: 'neoncore_submit_goal_decomposition',
      description:
        'Submit a PROPOSED breakdown of a goal into projects and tasks. This stores a proposal only — it creates nothing. The user reviews every project and task and chooses what becomes real, so do not create projects or tasks yourself by any other route. Ground the plan in the actual repository: a decomposition invented from the goal text alone names files and components that do not exist, and every task built on it wastes a cartridge run. Each task prompt is dispatched to a cartridge verbatim, so write it for someone who has not read your conversation. A short, honest decomposition is a better answer than a padded one.',
      inputSchema: {
        type: 'object',
        properties: {
          decompositionId: { type: 'string', description: 'The decomposition id given to you in the request' },
          proposal: {
            type: 'object',
            properties: {
              projects: {
                type: 'array',
                description: 'Candidate projects, each with its tasks. At most 8.',
                items: {
                  type: 'object',
                  properties: {
                    key:         { type: 'string', description: 'Short slug, unique across the proposal' },
                    name:        { type: 'string' },
                    description: { type: 'string' },
                    primaryRepo: { type: 'string', description: 'Absolute repo path, if known' },
                    tasks: {
                      type: 'array',
                      description: 'At most 20 per project.',
                      items: {
                        type: 'object',
                        properties: {
                          key:       { type: 'string', description: 'Short slug, unique across the WHOLE proposal — dependsOn refers to these' },
                          title:     { type: 'string' },
                          prompt:    { type: 'string', description: 'Dispatched to a cartridge verbatim: what to change, where, how it is verified' },
                          size:      { type: 'string', enum: ['S', 'M', 'L'] },
                          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task keys that must finish first. Across projects is fine. Unresolvable and circular links are dropped on arrival.' },
                        },
                        required: ['title'],
                      },
                    },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['projects'],
          },
        },
        required: ['decompositionId', 'proposal'],
      },
    },
    {
      name: 'neoncore_list_agents',
      description:
        'List the other agents currently known to NeonCore (id, machine, repo, status). Use for coordination — e.g. to avoid duplicating work another agent is already doing, or to get a target id for neoncore_message_agent / neoncore_read_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session identifier from neoncore_register' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'neoncore_message_agent',
      description:
        "Send a message directly into another agent's session (target id from neoncore_list_agents). The text is injected as if typed to that agent. This is the core primitive for two agents conferring on one job: hand off work, share a finding, or ask a peer to review/critique your solution.",
      inputSchema: {
        type: 'object',
        properties: {
          targetAgentId: { type: 'string', description: 'Id of the agent to message (from neoncore_list_agents)' },
          message: { type: 'string', description: "The message/instruction to deliver into that agent's session" },
        },
        required: ['targetAgentId', 'message'],
      },
    },
    {
      name: 'neoncore_read_agent',
      description:
        "Read another agent's recent transcript (target id from neoncore_list_agents) — their prompts, tool calls, and messages. Use to see what a peer agent has done before responding, critiquing, or synthesizing a shared final solution.",
      inputSchema: {
        type: 'object',
        properties: {
          targetAgentId: { type: 'string', description: 'Id of the agent whose transcript to read' },
          limit: { type: 'number', description: 'Max recent messages to return (default 20, max 100)' },
        },
        required: ['targetAgentId'],
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
    const { stepId, result, scope, verify, deferred } = args as Record<string, string>;
    if (!stepId) return text('ERROR: stepId is required to report step completion.');
    try {
      // A panel member reports against a DIFFERENT route: every member shares one step, so
      // their verdicts must land per-agent (executor_config.panelResults[agentId]) rather than
      // the first one completing the step for everyone.
      const panelAgentId = (args as Record<string, string>).panelAgentId;
      const route = panelAgentId
        ? `/api/workflows/webhook/${stepId}/panel/${panelAgentId}/complete`
        : `/api/workflows/webhook/${stepId}/complete`;
      await post(route, { result: result || 'Completed.', scope, verify, deferred });
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
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
    const { sessionId, taskId, result, status, error, scope, verify, deferred } = args as Record<string, string>;
    if (!taskId) return text('ERROR: taskId is required.');
    try {
      await post(`/api/tasks/${taskId}/complete`, {
        sessionId, result, status: status || 'done', error, scope, verify, deferred,
      });
      return text(`Task ${taskId} marked ${status === 'failed' ? 'failed' : 'done'} in NeonCore.`);
    } catch (err) {
      // A rejection here is the work standard refusing an unverified completion. The
      // message explains what is missing — pass it through verbatim so the agent acts on
      // it rather than treating the task as closed.
      log(`report_task_done rejected: ${err}`);
      return text(`Task ${taskId} was NOT completed. ${err}`);
    }
  }

  if (name === 'neoncore_submit_goal_draft') {
    const { draftId, fields } = args as { draftId?: string; fields?: unknown };
    if (!draftId) return text('ERROR: draftId is required.');
    try {
      await post(`/api/goals/drafts/${draftId}/submit`, { fields });
      return text(
        `Draft ${draftId} submitted. It is stored as a PROPOSAL and has changed nothing — the ` +
        `user will review it field by field and choose what to keep. Do not edit the goal yourself.`,
      );
    } catch (err) {
      // A 422 here means nothing usable came through — usually every field was empty or the
      // keys did not match. Pass it back so the agent can retry rather than assume it landed.
      log(`submit_goal_draft rejected: ${err}`);
      return text(`Draft ${draftId} was NOT accepted. ${err}`);
    }
  }

  if (name === 'neoncore_submit_goal_decomposition') {
    const { decompositionId, proposal } = args as { decompositionId?: string; proposal?: unknown };
    if (!decompositionId) return text('ERROR: decompositionId is required.');
    try {
      const out = await post(`/api/goals/decompositions/${decompositionId}/submit`, { proposal }) as
        { proposal?: { projects?: unknown[] }; notes?: string[] };
      const kept = out?.proposal?.projects?.length ?? 0;
      const notes = out?.notes ?? [];
      return text(
        `Decomposition ${decompositionId} submitted: ${kept} project(s) stored as a PROPOSAL. ` +
        `Nothing was created — the user reviews each project and task and chooses what becomes real.` +
        (notes.length ? `\n\nValidation adjusted your submission:\n- ${notes.join('\n- ')}` : ''),
      );
    } catch (err) {
      log(`submit_goal_decomposition rejected: ${err}`);
      return text(`Decomposition ${decompositionId} was NOT accepted. ${err}`);
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

  if (name === 'neoncore_message_agent') {
    const { targetAgentId, message } = args as Record<string, string>;
    if (!targetAgentId || !message) return text('targetAgentId and message are required.');
    try {
      const cmd = await post('/api/commands/send', {
        agentId: targetAgentId,
        text: message,
        includeMemory: false,
      }) as Record<string, unknown>;
      if (cmd && cmd.delivered === false) {
        return text(`Message queued but NOT delivered to ${targetAgentId} — no live command channel (is that cartridge running?).`);
      }
      return text(`Message delivered to agent ${targetAgentId}.`);
    } catch (err) {
      log(`message_agent failed: ${err}`);
      return text(`Could not message agent ${targetAgentId}: ${err}`);
    }
  }

  if (name === 'neoncore_read_agent') {
    const { targetAgentId, limit } = args as Record<string, unknown>;
    if (!targetAgentId || typeof targetAgentId !== 'string') return text('targetAgentId is required.');
    const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 20;
    try {
      const msgs = await get(`/api/agents/${targetAgentId}/messages?limit=${n}`) as Array<Record<string, unknown>>;
      if (!Array.isArray(msgs) || msgs.length === 0) return text(`Agent ${targetAgentId} has no transcript yet.`);
      const lines = msgs.map((m) => {
        const role = String(m.role || '');
        let body = '';
        try {
          const blocks = JSON.parse(String(m.content || '[]')) as Array<Record<string, unknown>>;
          body = blocks.map((b) => {
            if (b.type === 'text' || b.type === 'thinking') return String(b.text || '');
            if (b.type === 'tool_use') return `[tool: ${b.name}]`;
            if (b.type === 'tool_result') return '[tool result]';
            return '';
          }).filter(Boolean).join(' ');
        } catch {
          body = String(m.content || '');
        }
        return `${role}: ${body.slice(0, 500)}`;
      });
      return text(`Recent transcript of ${targetAgentId} (${msgs.length} msg):\n${lines.join('\n')}`);
    } catch (err) {
      log(`read_agent failed: ${err}`);
      return text(`Could not read agent ${targetAgentId}: ${err}`);
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
