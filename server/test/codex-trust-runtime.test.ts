import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codexArgsForMode, CODEX_FULL_ACCESS_FLAG } from '../../agent/relay/codex-mode.mjs';
import { RELAY_LAUNCH_TYPES } from '../src/lib/open-directory.js';

const MODES = ['manual', 'plan', 'trust'] as const;

test('every Codex relay alias gives native full access only to Trust mode', () => {
  const codexAliases = Object.entries(RELAY_LAUNCH_TYPES)
    .filter(([, engine]) => engine === 'codex')
    .map(([alias]) => alias);
  assert.ok(codexAliases.length > 0, 'Codex has no relay launch aliases');

  for (const alias of codexAliases) {
    for (const mode of MODES) {
      const args = codexArgsForMode([], mode, 'session-123');
      assert.equal(args.includes(CODEX_FULL_ACCESS_FLAG), mode === 'trust', `${alias}/${mode}`);
      assert.deepEqual(args.slice(-2), ['resume', 'session-123'], `${alias}/${mode}: session must resume`);
    }
  }
});

test('mode changes travel from the Trust route to the relay runtime', () => {
  const trustRoute = fs.readFileSync(path.join(import.meta.dirname, '../src/routes/trust.ts'), 'utf8');
  const relay = fs.readFileSync(path.join(import.meta.dirname, '../../agent/relay/index.js'), 'utf8');
  assert.match(trustRoute, /agent_mode_changed/);
  assert.match(relay, /socket\.on\('agent_mode_changed'/);
  assert.match(relay, /codexArgsForMode/);
});

test('synthetic relay labels are never passed to Codex resume', () => {
  for (const sessionId of ['relay-123', 'neoncore-codex-123', 'remote-abc']) {
    assert.deepEqual(codexArgsForMode([], 'trust', sessionId), [CODEX_FULL_ACCESS_FLAG]);
  }
});

test('an existing resume command is replaced without dropping global arguments', () => {
  assert.deepEqual(
    codexArgsForMode(['--search', 'resume', 'old-session'], 'trust', 'new-session'),
    [CODEX_FULL_ACCESS_FLAG, '--search', 'resume', 'new-session'],
  );
});
