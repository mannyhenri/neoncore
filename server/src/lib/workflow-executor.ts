import db from '../db.js';
import { getIO } from '../ws.js';
import { sendCommandToAgent } from './send-command.js';
import { getAdapter } from './model-adapters.js';
import type { Workflow, WorkflowPlayer, WorkflowPhaseState, PhaseResult, WorkflowPhase } from '../types.js';

const POLL_INTERVAL_MS = 15_000;
const IDLE_THRESHOLD_MS = 45_000;
const GRIDLIGHT_IDLE_THRESHOLD_MS = 90_000;

// Track dispatched VS Code agent commands — keyed by `${workflowId}:${playerId}:${round}`
const dispatchedAgents = new Map<string, { dispatchedAt: number; fallbackAgentId?: string }>();
// Track in-flight API calls to prevent double-dispatch
const inflightApiCalls = new Set<string>();

// ─── Public ──────────────────────────────────────────

export function startWorkflowExecutor() {
  setInterval(() => {
    const rows = db.prepare(
      "SELECT * FROM workflows WHERE status = 'running'"
    ).all() as Record<string, unknown>[];

    for (const row of rows) {
      try {
        processWorkflow(row);
      } catch (err) {
        console.error(`[workflow] Error processing ${row.id}:`, err);
      }
    }
  }, POLL_INTERVAL_MS);

  console.log(`[workflow] Executor started (${POLL_INTERVAL_MS / 1000}s interval)`);
}

// ─── Core Processing ─────────────────────────────────

function processWorkflow(row: Record<string, unknown>) {
  const wf = normalizeWorkflow(row);
  const phase = wf.phases[wf.currentPhase];
  if (!phase) return;

  const phasePlayers = wf.players.filter((p) => p.roles.includes(phase.phase));
  if (phasePlayers.length === 0) {
    // No players for this phase — skip it
    advanceToNextPhase(wf);
    return;
  }

  // Determine current round state
  if (phase.currentRound === 0) {
    // Phase hasn't started — kick off Round 1
    startRound(wf, phase, phasePlayers, 1);
  } else if (isRoundComplete(wf, phase, phasePlayers, phase.currentRound)) {
    if (phase.currentRound < 3) {
      // Advance to next round
      startRound(wf, phase, phasePlayers, phase.currentRound + 1);
    } else {
      // Round 3 complete — finalize phase
      finalizePhase(wf, phase);
    }
  }
  // Otherwise: round still in progress, wait
}

// ─── Round Management ────────────────────────────────

function startRound(wf: Workflow, phase: WorkflowPhaseState, players: WorkflowPlayer[], round: number) {
  const now = new Date().toISOString();

  if (round === 1 && phase.status === 'pending') {
    phase.status = 'running';
    phase.startedAt = now;
  }
  phase.currentRound = round;
  saveWorkflow(wf);

  console.log(`[workflow] ${wf.id} — ${phase.phase} phase, round ${round} starting (${players.length} players)`);

  for (const player of players) {
    const prompt = buildRoundPrompt(wf, phase, player, round);
    dispatchToPlayer(wf, phase, player, round, prompt);
  }
}

function isRoundComplete(wf: Workflow, phase: WorkflowPhaseState, players: WorkflowPlayer[], round: number): boolean {
  for (const player of players) {
    const key = `${wf.id}:${player.id}:${round}`;
    const hasResult = phase.playerResults.some(
      (r) => r.playerId === player.id && r.round === round,
    );
    if (hasResult) continue;

    // Check if API call is in-flight
    if (inflightApiCalls.has(key)) return false;

    // For VS Code agents (or API players re-dispatched to a Gridlight agent), check idle detection
    const dispatched = dispatchedAgents.get(key);
    const monitorAgentId = dispatched?.fallbackAgentId || player.agentId;
    if (monitorAgentId && (player.playerType === 'vscode-agent' || dispatched?.fallbackAgentId)) {
      if (!dispatched) return false; // Not dispatched yet

      const agent = db.prepare('SELECT status, last_seen, agent_type FROM agents WHERE id = ?')
        .get(monitorAgentId) as { status: string; last_seen: string; agent_type: string } | undefined;
      if (!agent) continue; // Agent gone

      if (agent.status === 'waiting') return false; // Waiting for permission
      if (agent.status !== 'idle') return false; // Still working

      const threshold = agent.agent_type === 'gridlight' ? GRIDLIGHT_IDLE_THRESHOLD_MS : IDLE_THRESHOLD_MS;
      const lastSeen = new Date(agent.last_seen).getTime();
      const idleFor = Date.now() - lastSeen;
      if (idleFor < threshold) return false; // Not idle long enough

      // Agent is idle — collect output
      const output = collectAgentOutput(monitorAgentId, dispatched.dispatchedAt);
      const isFailover = !!dispatched.fallbackAgentId;
      dispatchedAgents.delete(key);

      // ── Failsafe: detect agent failure and re-dispatch to Gridlight ──
      // Only attempt failsafe if this isn't already a failover (prevent loops)
      const agentFailed = isAgentOutputFailure(output);
      if (agentFailed && !isFailover) {
        const glPlayer = findGridlightPlayerAgent(wf, monitorAgentId);
        if (glPlayer) {
          console.log(`[workflow][failsafe] ${player.name} failed — re-dispatching to Gridlight agent "${glPlayer.name}"`);
          const prompt = buildRoundPrompt(wf, phase, player, round);
          sendCommandToAgent(glPlayer.agentId, prompt, false);
          dispatchedAgents.set(key, { dispatchedAt: Date.now(), fallbackAgentId: glPlayer.agentId });
          saveWorkflow(wf);
          return false; // Round not complete — waiting for Gridlight agent
        }
      }

      // Normal path: agent succeeded (or no fallback available)
      phase.playerResults.push({
        playerId: player.id,
        playerName: player.name,
        phase: phase.phase,
        round,
        output,
        completedAt: new Date().toISOString(),
        ...(isFailover ? { fallbackModel: 'gridlight-agent' } : {}),
        ...(agentFailed && !isFailover ? { error: 'Agent produced failed output; no Gridlight fallback available' } : {}),
      });
      saveWorkflow(wf);
      console.log(`[workflow] ${wf.id} — ${player.name} completed ${phase.phase} round ${round}`);
    }
  }

  // Check if all players have results for this round
  return players.every((p) =>
    phase.playerResults.some((r) => r.playerId === p.id && r.round === round),
  );
}

// ─── Dispatch ────────────────────────────────────────

function dispatchToPlayer(wf: Workflow, phase: WorkflowPhaseState, player: WorkflowPlayer, round: number, prompt: string) {
  const key = `${wf.id}:${player.id}:${round}`;

  // Skip if already dispatched
  if (dispatchedAgents.has(key) || inflightApiCalls.has(key)) return;
  if (phase.playerResults.some((r) => r.playerId === player.id && r.round === round)) return;

  if (player.playerType === 'vscode-agent' && player.agentId) {
    sendCommandToAgent(player.agentId, prompt, false);
    dispatchedAgents.set(key, { dispatchedAt: Date.now() });
    console.log(`[workflow] Dispatched to VS Code agent ${player.name} (${phase.phase} R${round})`);
  } else if (player.playerType === 'openai' || player.playerType === 'gridlight-gateway') {
    inflightApiCalls.add(key);
    const adapter = getAdapter(player.playerType, player.modelId || '');

    const systemPrompt = buildSystemPrompt(phase.phase, player, round);
    adapter.call(prompt, systemPrompt)
      .then((output) => {
        phase.playerResults.push({
          playerId: player.id,
          playerName: player.name,
          phase: phase.phase,
          round,
          output,
          completedAt: new Date().toISOString(),
        });
        console.log(`[workflow] ${player.name} (${player.playerType}) completed ${phase.phase} round ${round}`);
        saveWorkflow(wf);
      })
      .catch((err) => {
        console.error(`[workflow] ${player.name} failed:`, err);

        // ── Failsafe: re-dispatch to Gridlight VS Code agent ──
        const glPlayer = findGridlightPlayerAgent(wf);
        if (glPlayer) {
          console.log(`[workflow][failsafe] ${player.name} failed — re-dispatching to Gridlight agent "${glPlayer.name}"`);
          sendCommandToAgent(glPlayer.agentId, prompt, false);
          // Track as dispatched agent so idle detection picks it up
          dispatchedAgents.set(key, { dispatchedAt: Date.now(), fallbackAgentId: glPlayer.agentId });
          saveWorkflow(wf);
          return;
        }

        // No Gridlight agent available — record error
        phase.playerResults.push({
          playerId: player.id,
          playerName: player.name,
          phase: phase.phase,
          round,
          output: '',
          completedAt: new Date().toISOString(),
          error: String(err),
        });
        saveWorkflow(wf);
      })
      .finally(() => {
        inflightApiCalls.delete(key);
      });
  }
}

// ─── Phase Finalization ──────────────────────────────

function finalizePhase(wf: Workflow, phase: WorkflowPhaseState) {
  const now = new Date().toISOString();
  phase.status = 'completed';
  phase.completedAt = now;

  // Merge Round 3 outputs into shared context
  const round3Results = phase.playerResults.filter((r) => r.round === 3 && !r.error);
  const contextBlock = [
    `\n\n=== ${phase.phase.toUpperCase()} PHASE (Iteration ${wf.iteration}) ===\n`,
    ...round3Results.map((r) => `[${r.playerName}]:\n${r.output}`),
  ].join('\n\n');
  wf.sharedContext += contextBlock;

  console.log(`[workflow] ${wf.id} — ${phase.phase} phase completed`);

  if (phase.phase === 'review') {
    handleReviewResult(wf, phase);
  } else {
    advanceToNextPhase(wf);
  }
}

function handleReviewResult(wf: Workflow, phase: WorkflowPhaseState) {
  const round3Results = phase.playerResults.filter((r) => r.round === 3 && !r.error);
  const allApproved = round3Results.length > 0 && round3Results.every((r) =>
    r.output.toUpperCase().includes('APPROVED'),
  );

  if (allApproved) {
    // Workflow complete!
    wf.status = 'completed';
    wf.completedAt = new Date().toISOString();
    saveWorkflow(wf);
    console.log(`[workflow] ${wf.id} COMPLETED — all reviewers approved`);
  } else if (wf.iteration >= wf.maxIterations) {
    // Max iterations reached
    wf.status = 'completed';
    wf.completedAt = new Date().toISOString();
    wf.error = `Review did not pass after ${wf.maxIterations} iterations`;
    saveWorkflow(wf);
    console.log(`[workflow] ${wf.id} COMPLETED with warnings — max iterations reached`);
  } else {
    // Loop back to coding phase
    wf.iteration++;
    wf.currentPhase = 1; // coding
    wf.phases[1] = {
      phase: 'coding',
      status: 'pending',
      currentRound: 0,
      startedAt: '',
      completedAt: '',
      playerResults: [],
    };
    wf.phases[2] = {
      phase: 'review',
      status: 'pending',
      currentRound: 0,
      startedAt: '',
      completedAt: '',
      playerResults: [],
    };
    saveWorkflow(wf);
    console.log(`[workflow] ${wf.id} — review not passed, starting iteration ${wf.iteration}`);
  }
}

function advanceToNextPhase(wf: Workflow) {
  wf.currentPhase++;
  if (wf.currentPhase >= wf.phases.length) {
    wf.status = 'completed';
    wf.completedAt = new Date().toISOString();
    console.log(`[workflow] ${wf.id} COMPLETED — all phases done`);
  }
  saveWorkflow(wf);
}

// ─── Prompt Building ─────────────────────────────────

function buildSystemPrompt(phase: WorkflowPhase, player: WorkflowPlayer, round: number): string {
  const roleLabel = player.playerType === 'vscode-agent'
    ? 'You are a VS Code agent with direct file system access.'
    : `You are an AI model (${player.modelId}).`;

  if (phase === 'research') {
    if (round === 1) return `${roleLabel} You are a research analyst on a development team.`;
    if (round === 2) return `${roleLabel} You are reviewing your team's research findings.`;
    return `${roleLabel} Produce the FINAL consolidated research summary.`;
  }
  if (phase === 'coding') {
    if (round === 1) {
      if (player.playerType === 'vscode-agent') return `${roleLabel} You are a developer implementing code changes.`;
      return `${roleLabel} You are a developer producing code suggestions with file paths and reasoning.`;
    }
    if (round === 2) return `${roleLabel} You are reviewing code implementations for bugs, logic errors, and security issues.`;
    if (player.playerType === 'vscode-agent') return `${roleLabel} Apply the agreed improvements to the codebase.`;
    return `${roleLabel} Produce a final code review confirming the implementation is correct, or flag remaining issues.`;
  }
  // review
  if (round === 1) return `${roleLabel} You are a code reviewer checking correctness, test coverage, and quality.`;
  if (round === 2) return `${roleLabel} You are evaluating your team's review findings.`;
  return `${roleLabel} Produce a FINAL review verdict. If everything passes, include the word APPROVED.`;
}

function buildRoundPrompt(wf: Workflow, phase: WorkflowPhaseState, player: WorkflowPlayer, round: number): string {
  const taskHeader = [
    `[Workflow: ${wf.name} | Phase: ${phase.phase} | Round ${round}/3 | Iteration ${wf.iteration}/${wf.maxIterations}]`,
    '',
    wf.jiraTaskId ? `Jira Task: ${wf.jiraTaskId}` : '',
    `Task Description: ${wf.description}`,
    '',
  ].filter(Boolean).join('\n');

  if (round === 1) {
    const contextSection = wf.sharedContext
      ? `\n\nContext from previous phases:\n${wf.sharedContext}`
      : '';

    if (phase.phase === 'research') {
      return `${taskHeader}\nAnalyze the task requirements. Research the codebase, best practices, and approaches. Produce a thorough research summary.${contextSection}\n\nWhen done, stop and wait.`;
    }
    if (phase.phase === 'coding') {
      if (player.playerType === 'vscode-agent') {
        return `${taskHeader}\nBased on the agreed research below, implement the required changes in the codebase.${contextSection}\n\nWhen done, stop and wait. Do NOT commit or push.`;
      }
      return `${taskHeader}\nBased on the agreed research below, produce the code implementation you would write. Include full file paths, code snippets, and reasoning.${contextSection}`;
    }
    // review
    return `${taskHeader}\nReview the implementation against the original requirements. Check correctness, test coverage, and code quality.${contextSection}\n\nIf everything looks good, include the word APPROVED in your response. Otherwise, list specific issues.`;
  }

  // Round 2 & 3: include previous round outputs
  const prevRound = round - 1;
  const prevResults = phase.playerResults.filter((r) => r.round === prevRound && !r.error);
  const prevOutputs = prevResults.map((r) => `[${r.playerName}]:\n${r.output}`).join('\n\n---\n\n');

  if (round === 2) {
    return `${taskHeader}\nHere is what each team member produced in Round 1:\n\n${prevOutputs}\n\nReview ALL outputs. Identify gaps, disagreements, bugs, and improvements. Provide specific feedback.\n\nWhen done, stop and wait.`;
  }

  // Round 3
  const contextSection = wf.sharedContext
    ? `\n\nFull context from previous phases:\n${wf.sharedContext}`
    : '';

  if (phase.phase === 'review') {
    return `${taskHeader}\nHere is the team discussion from Round 2:\n\n${prevOutputs}\n\nProduce a FINAL review verdict. If everything passes, include the word APPROVED. Otherwise, list remaining issues.${contextSection}`;
  }

  if (phase.phase === 'coding' && player.playerType === 'vscode-agent') {
    return `${taskHeader}\nHere is the team feedback from Round 2:\n\n${prevOutputs}\n\nApply the agreed improvements to the codebase. Incorporate the best of all suggestions.${contextSection}\n\nWhen done, stop and wait. Do NOT commit or push.`;
  }

  return `${taskHeader}\nHere is the team discussion from Round 2:\n\n${prevOutputs}\n\nProduce your FINAL consolidated output incorporating the best of everyone's work.${contextSection}`;
}

// ─── Agent Output Collection ─────────────────────────

function collectAgentOutput(agentId: string, dispatchedAt: number): string {
  const since = new Date(dispatchedAt).toISOString();
  const activities = db.prepare(
    `SELECT tool_name, tool_input, tool_result, event_type FROM activity
     WHERE agent_id = ? AND timestamp > ?
     ORDER BY timestamp ASC
     LIMIT 100`,
  ).all(agentId, since) as { tool_name: string; tool_input: string; tool_result: string; event_type: string }[];

  // Extract assistant messages and meaningful tool results
  const outputs: string[] = [];
  for (const a of activities) {
    if (a.event_type === 'assistant_message') {
      outputs.push(a.tool_input);
    } else if (a.tool_result && a.tool_result !== '{}') {
      try {
        const result = JSON.parse(a.tool_result);
        if (typeof result === 'string' && result.length > 10) {
          outputs.push(`[${a.tool_name}]: ${result.slice(0, 2000)}`);
        }
      } catch {
        // Not JSON
      }
    }
  }

  if (outputs.length === 0) {
    // Fallback: get last message from agent
    const agent = db.prepare('SELECT last_message FROM agents WHERE id = ?')
      .get(agentId) as { last_message: string } | undefined;
    return agent?.last_message || '(No output captured)';
  }

  return outputs.join('\n\n');
}

// ─── Failsafe Helpers ───────────────────────────────

/**
 * Find the Gridlight VS Code agent in this workflow's player list.
 * Excludes the failed agent itself. Returns null if none found or offline.
 */
function findGridlightPlayerAgent(wf: Workflow, excludeAgentId?: string): { agentId: string; name: string } | null {
  for (const p of wf.players) {
    if (p.playerType !== 'vscode-agent' || !p.agentId) continue;
    if (p.agentId === excludeAgentId) continue;

    const agent = db.prepare('SELECT id, status, agent_type, name FROM agents WHERE id = ?')
      .get(p.agentId) as { id: string; status: string; agent_type: string; name: string } | undefined;
    if (agent && agent.agent_type === 'gridlight' && agent.status !== 'offline') {
      return { agentId: agent.id, name: p.name };
    }
  }
  return null;
}

// ─── Failure Detection ──────────────────────────────

function isAgentOutputFailure(output: string): boolean {
  if (!output || output === '(No output captured)') return true;

  const trimmed = output.trim();
  if (trimmed.length < 50) return true;

  const errorPatterns = [
    /token.{0,20}(limit|exhaust|exceed)/i,
    /rate.{0,10}limit/i,
    /context.{0,15}(window|length).{0,15}(exceed|full|limit)/i,
    /maximum.{0,10}(token|context)/i,
    /error.*processing.*request/i,
    /session.*expired/i,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /network.*error/i,
  ];

  return errorPatterns.some((pattern) => pattern.test(trimmed));
}

// ─── Persistence ─────────────────────────────────────

function saveWorkflow(wf: Workflow) {
  db.prepare(`
    UPDATE workflows
    SET phases = ?, status = ?, current_phase = ?, iteration = ?,
        shared_context = ?, completed_at = ?, error = ?
    WHERE id = ?
  `).run(
    JSON.stringify(wf.phases), wf.status, wf.currentPhase, wf.iteration,
    wf.sharedContext, wf.completedAt || null, wf.error, wf.id,
  );

  getIO().emit('workflow_updated', wf);
}

function normalizeWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    name: (row.name ?? '') as string,
    jiraTaskId: (row.jira_task_id ?? '') as string,
    description: (row.description ?? '') as string,
    players: JSON.parse((row.players ?? '[]') as string),
    phases: JSON.parse((row.phases ?? '[]') as string),
    status: (row.status ?? 'pending') as Workflow['status'],
    currentPhase: (row.current_phase ?? 0) as number,
    iteration: (row.iteration ?? 1) as number,
    maxIterations: (row.max_iterations ?? 3) as number,
    sharedContext: (row.shared_context ?? '') as string,
    initialContext: (row.initial_context ?? '') as string,
    createdAt: (row.created_at ?? '') as string,
    startedAt: (row.started_at ?? '') as string,
    completedAt: (row.completed_at as string) || null,
    error: (row.error ?? '') as string,
    templateId: (row.template_id as string) || null,
    runNumber: (row.run_number as number) || 0,
  };
}
