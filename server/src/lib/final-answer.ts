/**
 * THE AGENT'S FINAL ANSWER — in full, for the Agents screen.
 *
 * `agents.last_message` keeps the first 500 characters of the latest assistant text: enough for a
 * summary line, not for reading what the agent actually said. The hook reporter ships the whole
 * transcript into `messages` (reporter.py; up to 16,000 characters per message), so the answer is
 * read from there.
 *
 * The final answer is the trailing run of assistant TEXT in the latest session — what the agent
 * said after its last tool call, before handing back. While a turn is still running (it ends in a
 * tool call) there is no final answer yet: the latest text so far is returned, marked incomplete.
 */
import db from '../db.js';

/** Every content block type a transcript message carries (types.ts TranscriptEntry). */
export const TRANSCRIPT_BLOCK_TYPES = ['text', 'thinking', 'tool_use', 'tool_result'] as const;
/** Of those, what the person reads as the answer. Thinking and tool traffic never are. */
export const ANSWER_BLOCK_TYPES: ReadonlySet<string> = new Set(['text']);

export interface FinalAnswer {
  text: string;
  /** false while the turn is still running — the text is the latest so far, not the final word. */
  complete: boolean;
  sessionId: string;
  /** When the last message of the answer arrived. */
  at: string;
}

interface Row { role: string; content: string; ts: string; session_id: string }
interface Parsed { role: string; text: string; toolUse: boolean; ts: string }

function parse(r: Row): Parsed {
  let blocks: unknown;
  try { blocks = JSON.parse(r.content); } catch { blocks = r.content; }
  if (typeof blocks === 'string') return { role: r.role, text: blocks.trim(), toolUse: false, ts: r.ts };
  const list = Array.isArray(blocks) ? blocks as { type?: string; text?: string }[] : [];
  return {
    role: r.role,
    text: list.filter((b) => b && ANSWER_BLOCK_TYPES.has(String(b.type)) && typeof b.text === 'string').map((b) => b.text!.trim()).filter(Boolean).join('\n\n'),
    toolUse: list.some((b) => b?.type === 'tool_use'),
    ts: r.ts,
  };
}

/** The assistant text of the consecutive assistant messages ending at `end` (inclusive). */
function runEndingAt(msgs: Parsed[], end: number): Parsed[] {
  let start = end;
  while (start > 0 && msgs[start - 1].role === 'assistant') start--;
  return msgs.slice(start, end + 1).filter((m) => m.text);
}

export function finalAnswerOf(agentId: string): FinalAnswer | null {
  const latest = db.prepare('SELECT session_id FROM messages WHERE agent_id = ? ORDER BY ts DESC, seq DESC LIMIT 1').get(agentId) as { session_id: string } | undefined;
  if (!latest) return null;
  const msgs = (db.prepare('SELECT role, content, ts, session_id FROM messages WHERE agent_id = ? AND session_id = ? ORDER BY seq ASC')
    .all(agentId, latest.session_id) as Row[]).map(parse);
  if (msgs.length === 0) return null;

  const last = msgs[msgs.length - 1];
  // The turn handed back: it ends in assistant text with no tool call after it.
  const complete = last.role === 'assistant' && !!last.text && !last.toolUse;
  let end = msgs.length - 1;
  if (!complete) {
    // Still running: the latest assistant text so far.
    while (end >= 0 && !(msgs[end].role === 'assistant' && msgs[end].text)) end--;
    if (end < 0) return null;
  }
  const run = runEndingAt(msgs, end);
  if (run.length === 0) return null;
  return { text: run.map((m) => m.text).join('\n\n'), complete, sessionId: latest.session_id, at: run[run.length - 1].ts };
}
