import db from '../db.js';

// ── Error detection (reused from memory-analyzer patterns) ──

const ERROR_PATTERNS = [
  /error/i, /Error:/, /failed/i, /FAILED/, /Cannot /, /No such /,
  /ENOENT/, /EACCES/, /ModuleNotFoundError/, /ImportError/,
  /SyntaxError/, /TypeError/, /command not found/,
];

function hasError(text: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(text));
}

function extractErrorLine(text: string): string {
  const lines = text.split('\n');
  const errorLine = lines.find((l) => ERROR_PATTERNS.some((p) => p.test(l)));
  return errorLine?.trim().slice(0, 200) || 'Unknown error';
}

// ── Decision extraction ──

const DECISION_KEYWORDS = /\b(because|decided to|instead of|chose|tradeoff|approach was|went with|opted for)\b/i;

function extractDecisions(messages: string[]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    const sentences = msg.split(/[.!?\n]+/).filter((s) => s.trim().length > 20);
    for (const sentence of sentences) {
      if (DECISION_KEYWORDS.test(sentence)) {
        const trimmed = sentence.trim().slice(0, 200);
        if (!decisions.some((d) => d === trimmed)) {
          decisions.push(trimmed);
        }
      }
    }
    if (decisions.length >= 5) break;
  }
  return decisions;
}

// ── Main summarizer ──

interface Activity {
  tool_name: string;
  tool_input: string;
  tool_result: string;
  event_type: string;
  timestamp: string;
}

export function summarizeSession(
  _sessionDbId: string,
  agentId: string,
  startedAt: string,
  endedAt: string,
): string {
  // Get agent info
  const agent = db.prepare('SELECT name, repo_name, branch FROM agents WHERE id = ?')
    .get(agentId) as { name: string; repo_name: string; branch: string } | undefined;
  const agentName = agent?.name || agentId.slice(0, 8);
  const branch = agent?.branch || 'unknown';

  // Get all activities in this session's time range
  const activities = db.prepare(
    'SELECT tool_name, tool_input, tool_result, event_type, timestamp FROM activity WHERE agent_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
  ).all(agentId, startedAt, endedAt) as Activity[];

  if (activities.length === 0) return '(No activities recorded)';

  // Calculate duration
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const durationMin = Math.round(durationMs / 60000);

  // Extract task — from first user_prompt
  let task = '';
  for (const act of activities) {
    if (act.event_type === 'user_prompt' && act.tool_input) {
      task = typeof act.tool_input === 'string'
        ? act.tool_input.slice(0, 300)
        : String(act.tool_input).slice(0, 300);
      break;
    }
  }
  if (!task) task = '(No user prompt captured)';

  // Extract files modified — from Edit/Write tool uses
  const filesModified = new Set<string>();
  for (const act of activities) {
    if (act.tool_name === 'Edit' || act.tool_name === 'Write') {
      try {
        const input = typeof act.tool_input === 'string' ? JSON.parse(act.tool_input) : act.tool_input;
        const filePath = input?.file_path || '';
        if (filePath) {
          // Store just filename for readability
          const parts = filePath.split('/');
          filesModified.add(parts[parts.length - 1] || filePath);
        }
      } catch { /* ignore */ }
    }
  }

  // Extract commands run — from Bash tool uses
  const commands: string[] = [];
  for (const act of activities) {
    if (act.tool_name === 'Bash') {
      try {
        const input = typeof act.tool_input === 'string' ? JSON.parse(act.tool_input) : act.tool_input;
        const cmd = input?.command || '';
        if (cmd && commands.length < 10) {
          commands.push(cmd.slice(0, 100));
        }
      } catch { /* ignore */ }
    }
  }

  // Extract errors & fixes
  const errorFixes: string[] = [];
  for (let i = 1; i < activities.length && errorFixes.length < 5; i++) {
    const prev = activities[i - 1];
    const curr = activities[i];

    if (
      hasError(prev.tool_result) &&
      !hasError(curr.tool_result) &&
      prev.tool_name === curr.tool_name
    ) {
      const errorText = extractErrorLine(prev.tool_result);
      errorFixes.push(errorText);
    }
  }

  // Extract assistant messages for decision mining
  const assistantMessages: string[] = [];
  for (const act of activities) {
    if (act.event_type === 'assistant_message' && act.tool_input) {
      assistantMessages.push(
        typeof act.tool_input === 'string' ? act.tool_input : String(act.tool_input)
      );
    }
  }

  const decisions = extractDecisions(assistantMessages);

  // Extract outcome — last assistant message
  let outcome = '';
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i].event_type === 'assistant_message' && activities[i].tool_input) {
      outcome = typeof activities[i].tool_input === 'string'
        ? activities[i].tool_input.slice(0, 400)
        : String(activities[i].tool_input).slice(0, 400);
      break;
    }
  }
  // Fall back to last tool result
  if (!outcome && activities.length > 0) {
    const last = activities[activities.length - 1];
    outcome = last.tool_result?.slice(0, 200) || 'Session ended';
  }

  // Format date
  const dateStr = new Date(startedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const timeStr = new Date(startedAt).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  // Build markdown
  const parts: string[] = [];

  parts.push(`## Session: ${dateStr} ${timeStr} — ${agentName}`);
  parts.push(`**Duration:** ${durationMin} min | **Branch:** ${branch} | **Actions:** ${activities.length}\n`);

  parts.push(`### Task\n${task}\n`);

  if (filesModified.size > 0 || commands.length > 0) {
    parts.push('### What Was Done');
    if (filesModified.size > 0) {
      parts.push(`- **Modified:** ${Array.from(filesModified).slice(0, 15).join(', ')}`);
    }
    if (commands.length > 0) {
      parts.push(`- **Commands:** ${commands.slice(0, 5).map((c) => `\`${c}\``).join(', ')}`);
    }
    parts.push('');
  }

  if (decisions.length > 0) {
    parts.push('### Decisions');
    for (const d of decisions) {
      parts.push(`- ${d}`);
    }
    parts.push('');
  }

  if (errorFixes.length > 0) {
    parts.push('### Errors Encountered');
    for (const e of errorFixes) {
      parts.push(`- ${e}`);
    }
    parts.push('');
  }

  if (outcome) {
    parts.push(`### Outcome\n${outcome}\n`);
  }

  return parts.join('\n');
}

// updateKnowledgeFromSession() lived here and is gone.
//
// It appended one line per session to progress.md and decisions.md. Nobody read either, and the
// progress lines rendered as "- **Sep 6, 2026** (host/repo): <prompt fragment> — {}" because the
// outcome regex usually missed. The summary they were derived from is stored on the session row,
// which the Sessions tab already shows, so they were a lossy duplicate of data one click away.
//
// The per-run record that replaced them is `workflow_reports` — written once by the agent that
// did the work, and readable in the project journal.
