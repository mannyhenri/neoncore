import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickAgentCandidate,
  normalizeRepoPath,
  DEFAULT_AGENT_TYPE,
  type AgentCandidate,
} from '../src/lib/resolve-agent.ts';

/**
 * Regression coverage for engine mis-attribution.
 *
 * The bug: a repo holding both a Claude and a Codex cartridge resolved untyped
 * payloads by insertion order (`sameRepo[0]`, from a SELECT with no ORDER BY).
 * When the Codex row happened to be created first, every Claude hook event was
 * recorded against the Codex cartridge — the cartridge list showed "codex
 * working" while the user was running Claude Code.
 *
 * `codex` is deliberately FIRST in these fixtures: that is the ordering that
 * reproduced the bug, so a regression here fails loudly.
 */
function twoEngines(): AgentCandidate[] {
  return [
    { id: 'codex-row', repo_path: '/code/baseback', agent_type: 'codex', session_id: 'sess-codex' },
    { id: 'claude-row', repo_path: '/code/baseback', agent_type: 'claude', session_id: 'sess-claude' },
  ];
}

test('untyped payload resolves to claude, not to whichever row was inserted first', () => {
  // The exact regression: no agentType, codex row first. Pre-fix this returned
  // 'codex-row' because it fell through to candidates[0].
  const picked = pickAgentCandidate(twoEngines(), {});
  assert.equal(picked?.id, 'claude-row');
  assert.equal(picked?.agent_type, DEFAULT_AGENT_TYPE);
});

test('untyped default matches the register endpoint default', () => {
  // routes/agents.ts register uses `agentType || 'claude'`. If these two ever
  // disagree, registration and attribution land on different rows again.
  assert.equal(DEFAULT_AGENT_TYPE, 'claude');
});

test('explicit agentType wins regardless of row order', () => {
  assert.equal(pickAgentCandidate(twoEngines(), { agentType: 'codex' })?.id, 'codex-row');
  assert.equal(pickAgentCandidate(twoEngines(), { agentType: 'claude' })?.id, 'claude-row');
});

test('exact sessionId disambiguates when agentType is absent', () => {
  const picked = pickAgentCandidate(twoEngines(), { sessionId: 'sess-codex' });
  assert.equal(picked?.id, 'codex-row', 'session identity must beat the untyped default');
});

test('agentType beats a conflicting sessionId', () => {
  const picked = pickAgentCandidate(twoEngines(), { agentType: 'claude', sessionId: 'sess-codex' });
  assert.equal(picked?.id, 'claude-row');
});

test('unknown agentType falls back to sessionId before position', () => {
  // e.g. a hook sending 'claude-code' instead of 'claude'.
  const picked = pickAgentCandidate(twoEngines(), { agentType: 'claude-code', sessionId: 'sess-claude' });
  assert.equal(picked?.id, 'claude-row');
});

test('unknown agentType with no sessionId is the one case that stays positional', () => {
  // Documents the deliberate last resort — nothing left to disambiguate on.
  assert.equal(pickAgentCandidate(twoEngines(), { agentType: 'gemini' })?.id, 'codex-row');
});

test('single-engine repos are unaffected by any of this', () => {
  const one: AgentCandidate[] = [
    { id: 'only', repo_path: '/code/solo', agent_type: 'codex', session_id: 's' },
  ];
  assert.equal(pickAgentCandidate(one, {})?.id, 'only');
  assert.equal(pickAgentCandidate(one, { agentType: 'claude' })?.id, 'only');
  assert.equal(pickAgentCandidate([], {}), undefined);
});

test('three engines in one repo still resolve untyped payloads to claude', () => {
  const three: AgentCandidate[] = [
    { id: 'codex-row', repo_path: '/r', agent_type: 'codex', session_id: 'a' },
    { id: 'gemini-row', repo_path: '/r', agent_type: 'gemini', session_id: 'b' },
    { id: 'claude-row', repo_path: '/r', agent_type: 'claude', session_id: 'c' },
  ];
  assert.equal(pickAgentCandidate(three, {})?.id, 'claude-row');
});

test('repo path matching is case- and separator-insensitive', () => {
  // The candidate filter depends on this, so a Windows runner reporting
  // C:\code\baseback matches a row stored as /c/code/baseback.
  assert.equal(normalizeRepoPath('C:\\code\\baseback'), '/c/code/baseback');
  assert.equal(normalizeRepoPath('/code/baseback/'), '/code/baseback');
  assert.equal(normalizeRepoPath('/Code/BaseBack'), '/code/baseback');
  assert.equal(normalizeRepoPath(''), '');
});
