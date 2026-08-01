/**
 * Nothing types into a terminal unless a human has explicitly turned that on.
 *
 * send-command.ts had a fallback: if a claude/codex cartridge has no live socket, run
 * AppleScript that writes the command into the FRONTMOST terminal window. Its own comment
 * admitted the flaw — "it cannot target a specific window, so it lands wherever focus happens
 * to be."
 *
 * That is how mystery text kept appearing in the user's session for two days. Any dispatch to
 * a socket-less claude agent typed into whichever window had focus, including a session the
 * user was reading. Test suites hit it hardest: they use a stub io with no sockets, so EVERY
 * prompt they dispatched took the fallback and typed into the developer's real terminal.
 *
 * It also defeated an egress guard I had already run and trusted: that guard instrumented
 * fetch, TCP connect and listen, and `osascript` is a CHILD PROCESS. I measured "zero egress"
 * and was wrong, because the measurement was scoped to the wrong exits.
 *
 * So: OFF unless explicitly enabled. A capability that types into an unknown window is not a
 * sensible default, and tests must never be able to reach it at all.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');
const SEND = fs.readFileSync(path.join(SRC, 'lib/send-command.ts'), 'utf8');

test('the terminal fallback is gated, not unconditional', () => {
  // The gate must be INSIDE typeIntoTerminal, so every present and future caller inherits it.
  // Guarding at the one call site would leave the next caller unprotected.
  const fn = SEND.slice(SEND.indexOf('function typeIntoTerminal'), SEND.indexOf('function typeIntoTerminal') + 900);
  assert.match(
    fn, /terminalFallbackEnabled|TERMINAL_FALLBACK|isTerminalFallbackEnabled/,
    'typeIntoTerminal runs osascript with no opt-in check — any dispatch to a socket-less ' +
    'cartridge types into whatever window has focus',
  );
});

test('it is OFF by default', () => {
  // Default-on would mean an upgrade silently restores keystroke injection for everyone who
  // never knew it existed.
  assert.match(
    SEND, /NEONCORE_TERMINAL_FALLBACK\s*===\s*['"]1['"]|=== 'true'/,
    'the gate does not read as opt-in — it must require an explicit value to enable',
  );
});

test('a test process can NEVER reach it, whatever the setting says', () => {
  // Belt and braces, and deliberately so: the suite is what caused the harm, an isolated DB
  // does not isolate a child process, and a developer with the flag enabled would otherwise be
  // typing their own test payloads into their own terminal again.
  assert.match(
    SEND, /NODE_ENV\s*===\s*['"]test['"]|NEONCORE_TEST/,
    'nothing stops a test run from typing into the developer\'s terminal',
  );
});

test('the runtime gate actually blocks it here, in this test process', async () => {
  // Not a source assertion — call it. This suite is exactly the context that used to inject.
  const mod = await import('../src/lib/send-command.ts') as unknown as {
    __typeIntoTerminalForTests?: (t: string) => boolean;
  };
  if (typeof mod.__typeIntoTerminalForTests !== 'function') {
    assert.fail('send-command must expose the fallback for this assertion, or it cannot be proven blocked');
  }
  assert.equal(
    mod.__typeIntoTerminalForTests('this text must never reach a terminal'), false,
    'the fallback returned true inside a test process — it would have typed into a real window',
  );
});
