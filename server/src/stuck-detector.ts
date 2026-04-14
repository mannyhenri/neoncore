import db from './db.js';
import { getIO } from './ws.js';
import crypto from 'crypto';
import { pushNotify, getCartridgeNtfyUrl } from './lib/push-notify.js';

export interface StuckAlert {
  agentId: string;
  pattern: string;
  severity: 'high' | 'medium';
  suggestion: string;
  detectedAt: string;
}

// Track which agents have active alerts to avoid spamming
const activeAlerts = new Map<string, string>(); // agentId → pattern

const ERROR_PATTERNS = [
  /error/i, /Error:/, /failed/i, /FAILED/, /Cannot /, /No such /,
  /exit code [1-9]/, /ENOENT/, /EACCES/, /EPERM/, /command not found/,
  /ModuleNotFoundError/, /ImportError/, /SyntaxError/, /TypeError/,
];

function hasError(toolResult: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(toolResult));
}

function hashActivity(toolName: string, toolInput: string): string {
  const key = `${toolName}:${toolInput.slice(0, 200)}`;
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function analyzeAgent(agentId: string): StuckAlert | null {
  const activities = db
    .prepare('SELECT tool_name, tool_input, tool_result, timestamp FROM activity WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 15')
    .all(agentId) as { tool_name: string; tool_input: string; tool_result: string; timestamp: string }[];

  if (activities.length < 3) return null;

  // Pattern 1: Error loop — 3+ consecutive errors
  let consecutiveErrors = 0;
  let lastError = '';
  for (const act of activities) {
    if (hasError(act.tool_result)) {
      consecutiveErrors++;
      if (!lastError) {
        // Extract first error line
        const lines = act.tool_result.split('\n');
        lastError = lines.find((l) => ERROR_PATTERNS.some((p) => p.test(l)))?.trim().slice(0, 150) || 'Unknown error';
      }
    } else {
      break;
    }
  }
  if (consecutiveErrors >= 3) {
    return {
      agentId,
      pattern: `Error loop: ${consecutiveErrors} consecutive errors. Last: "${lastError}"`,
      severity: 'high',
      suggestion: `The agent is hitting repeated errors. Consider: check if a dependency is missing, verify file paths, or try a different approach.`,
      detectedAt: new Date().toISOString(),
    };
  }

  // Pattern 2: Repeated tool pattern — same tool+input 3+ times in last 10
  const recent10 = activities.slice(0, 10);
  const hashCounts = new Map<string, number>();
  for (const act of recent10) {
    const h = hashActivity(act.tool_name, act.tool_input);
    hashCounts.set(h, (hashCounts.get(h) || 0) + 1);
  }
  for (const [, count] of hashCounts) {
    if (count >= 3) {
      const repeated = recent10.find((a) => hashActivity(a.tool_name, a.tool_input) === [...hashCounts.entries()].find(([, c]) => c >= 3)?.[0]);
      return {
        agentId,
        pattern: `Repeated action: "${repeated?.tool_name}" called ${count} times with similar input`,
        severity: 'high',
        suggestion: `The agent is repeating the same action. It may be stuck in a loop. Try sending a different instruction or hint.`,
        detectedAt: new Date().toISOString(),
      };
    }
  }

  // Pattern 3: Long silence — working status but no activity for 3+ minutes
  if (activities.length > 0) {
    const lastActivity = new Date(activities[0].timestamp).getTime();
    const silenceMs = Date.now() - lastActivity;
    if (silenceMs > 60 * 60 * 1000) {
      const agent = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as { status: string } | undefined;
      if (agent?.status === 'working') {
        return {
          agentId,
          pattern: `Long silence: no activity for ${Math.floor(silenceMs / 60000)} minutes while status is "working"`,
          severity: 'medium',
          suggestion: `The agent appears stalled. It may be waiting for input or processing a large task. Check if it needs a response.`,
          detectedAt: new Date().toISOString(),
        };
      }
    }
  }

  // Pattern 5: Permission stall — pending permission older than 5 minutes
  const stalePerms = db.prepare(
    "SELECT id, tool_name FROM permissions WHERE agent_id = ? AND status = 'pending' AND created_at < ?"
  ).all(agentId, new Date(Date.now() - 5 * 60 * 1000).toISOString()) as { id: string; tool_name: string }[];

  if (stalePerms.length > 0) {
    return {
      agentId,
      pattern: `Permission stall: ${stalePerms.length} pending permission(s) waiting 5+ minutes (${stalePerms[0].tool_name})`,
      severity: 'high',
      suggestion: `Approve or deny the pending permission request to unblock the agent.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

export function startStuckDetector() {
  setInterval(() => {
    // Check all working/waiting agents
    const agents = db.prepare(
      "SELECT id FROM agents WHERE status IN ('working', 'waiting')"
    ).all() as { id: string }[];

    for (const { id } of agents) {
      const alert = analyzeAgent(id);

      if (alert) {
        const prev = activeAlerts.get(id);
        // Only emit if pattern changed (avoid spamming same alert)
        if (prev !== alert.pattern) {
          activeAlerts.set(id, alert.pattern);
          getIO().emit('agent_stuck' as any, alert);
          console.log(`[stuck] Agent ${id}: ${alert.pattern}`);
          // Fire mobile push so user knows even when away from dashboard
          const agentRow = db.prepare('SELECT repo_name, name, repo_path FROM agents WHERE id = ?')
            .get(id) as { repo_name: string; name: string; repo_path: string } | undefined;
          const label = agentRow?.repo_name || agentRow?.name || id;
          const ntfyUrl = agentRow?.repo_path ? getCartridgeNtfyUrl(agentRow.repo_path) : undefined;
          pushNotify(`${label} — Agent Stuck`, alert.pattern, ntfyUrl ?? undefined).catch((err) => {
            console.warn(`[stuck] pushNotify failed for agent ${id}:`, err);
          });
        }
      } else if (activeAlerts.has(id)) {
        // Agent unstuck — clear alert
        activeAlerts.delete(id);
        getIO().emit('agent_unstuck' as any, { agentId: id });
        console.log(`[stuck] Agent ${id}: unstuck`);
      }
    }
  }, 30_000); // Check every 30 seconds

  console.log('[stuck] Stuck detector started (30s interval)');
}
