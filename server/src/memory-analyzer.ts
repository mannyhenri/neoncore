import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import db from './db.js';
import { getIO } from './ws.js';

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

function contentHash(text: string): string {
  return crypto.createHash('md5').update(text.slice(0, 100)).digest('hex').slice(0, 12);
}

function memoryExists(agentId: string, category: string, hashPrefix: string): boolean {
  // Dedup: check if a similar entry already exists
  const existing = db.prepare(
    'SELECT content FROM agent_memory WHERE agent_id = ? AND category = ?'
  ).all(agentId, category) as { content: string }[];

  return existing.some((e) => contentHash(e.content) === hashPrefix);
}

function createMemory(agentId: string, project: string, category: string, content: string) {
  const hash = contentHash(content);
  if (memoryExists(agentId, category, hash)) return; // Skip duplicate

  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_memory (id, agent_id, project, category, content, source, created_at, active)
    VALUES (?, ?, ?, ?, ?, 'auto', ?, 0)
  `).run(id, agentId, project, category, content, now);

  getIO().emit('memory_updated', { agentId });
  console.log(`[memory] Auto-captured for ${agentId}: [${category}] ${content.slice(0, 80)}...`);
}

function analyzeAgentMemory(agentId: string) {
  const agent = db.prepare('SELECT repo_name FROM agents WHERE id = ?').get(agentId) as { repo_name: string } | undefined;
  const project = agent?.repo_name || '';

  const activities = db.prepare(
    'SELECT tool_name, tool_input, tool_result, timestamp FROM activity WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 20'
  ).all(agentId) as { tool_name: string; tool_input: string; tool_result: string; timestamp: string }[];

  if (activities.length < 5) return;

  // Pattern 1: Error → Fix (error followed by different approach → success)
  // Look for: error in position N, then success (no error) in position N-1 or N-2
  for (let i = 2; i < activities.length; i++) {
    const errorAct = activities[i];
    const nextAct = activities[i - 1];
    const successAct = activities[i - 2]; // most recent

    if (
      hasError(errorAct.tool_result) &&
      !hasError(successAct.tool_result) &&
      errorAct.tool_name === successAct.tool_name &&
      errorAct.tool_input !== successAct.tool_input
    ) {
      const errorText = extractErrorLine(errorAct.tool_result);
      let fixDesc: string;
      try {
        const input = JSON.parse(successAct.tool_input);
        fixDesc = input.command || input.file_path || successAct.tool_input.slice(0, 150);
      } catch {
        fixDesc = successAct.tool_input.slice(0, 150);
      }

      createMemory(
        agentId,
        project,
        'common_error',
        `Error: "${errorText}" → Fix: ${fixDesc}`
      );
      break; // One capture per analysis cycle
    }
  }

  // Pattern 2: Repeated failure (same error 3+ times)
  const errorTexts: string[] = [];
  for (const act of activities.slice(0, 10)) {
    if (hasError(act.tool_result)) {
      errorTexts.push(extractErrorLine(act.tool_result));
    }
  }

  // Count identical errors
  const errorCounts = new Map<string, number>();
  for (const err of errorTexts) {
    const key = err.slice(0, 100);
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
  }

  for (const [err, count] of errorCounts) {
    if (count >= 3) {
      createMemory(
        agentId,
        project,
        'failed_approach',
        `Recurring error (${count}x): "${err}" — agent kept retrying same approach`
      );
      break;
    }
  }

  // Pattern 3: File co-change — track Edit/Write targets that appear together
  const editedFiles: string[] = [];
  for (const act of activities) {
    if (act.tool_name === 'Edit' || act.tool_name === 'Write') {
      try {
        const input = JSON.parse(act.tool_input);
        const filePath = input.file_path || '';
        if (filePath) {
          // Store just the filename for readability
          const fileName = filePath.split('/').pop() || filePath;
          if (!editedFiles.includes(fileName)) editedFiles.push(fileName);
        }
      } catch {
        // Skip unparseable input
      }
    }
  }

  if (editedFiles.length >= 3) {
    createMemory(
      agentId,
      project,
      'file_impact',
      `Files that change together: ${editedFiles.slice(0, 6).join(', ')}`
    );
  }
}

export function startMemoryAnalyzer() {
  setInterval(() => {
    const agents = db.prepare(
      "SELECT id FROM agents WHERE status IN ('working', 'idle') AND last_seen > ?"
    ).all(new Date(Date.now() - 10 * 60 * 1000).toISOString()) as { id: string }[];

    for (const { id } of agents) {
      try {
        analyzeAgentMemory(id);
      } catch (err) {
        console.error(`[memory] Error analyzing agent ${id}:`, err);
      }
    }
  }, 60_000); // Check every 60 seconds (less frequent than stuck detector)

  console.log('[memory] Memory analyzer started (60s interval)');
}
