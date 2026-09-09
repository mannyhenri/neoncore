/**
 * ADX-001 is a SPIKE, so its deliverable is a FINDING — and a finding nobody
 * can re-check is a rumour. This test holds the finding document to the four
 * things the task actually asked, and holds its factual claims to the code and
 * to the machine, so a finding that drifts fails rather than misleads.
 *
 * WHY EACH CLAIM IS PINNED TO SOMETHING EXECUTABLE. The whole epic behind this
 * (GRD-3713) rests on the spike's answer: eight tasks assume a transport that
 * ADX-001 either proved or did not. A document asserting "the relay can obtain
 * the token" that nothing re-checks is exactly how an epic gets built on a
 * belief. So the relay's spawn site, the socket directory, the version floor
 * and the chokepoint count are all read from the source at test time.
 *
 * The QUESTIONS are derived from the task's own acceptance criteria rather
 * than typed here as prose, so a finding that answers three of four fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FINDING = path.join(ROOT, 'docs', 'plans', 'adx-001-inbox-socket-spike.md');

const doc = (): string => {
  assert.ok(fs.existsSync(FINDING), `ADX-001 finding not written: ${FINDING}`);
  return fs.readFileSync(FINDING, 'utf8');
};

/**
 * The four questions, each with the evidence marker its answer must carry.
 * `answered` is a predicate over the document rather than a substring, because
 * a finding may legitimately word its answer either way — what it may NOT do
 * is leave the question unaddressed or answer it without evidence.
 */
const QUESTIONS = [
  {
    id: 'token-from-child',
    asks: 'can the relay read CLAUDE_CODE_MESSAGING_TOKEN from its PTY child',
    /* Either outcome is a valid finding; silence is not. */
    answered: (d: string) => /ps eww/.test(d) && /CLAUDE_CODE_MESSAGING_TOKEN/.test(d),
    evidence: /exec[- ]time|after exec|not visible|NOT visible/i,
  },
  {
    id: 'post-without-auth',
    asks: 'does a post to /tmp/cc-socks/<pid>.sock succeed WITHOUT the auth line on macOS',
    answered: (d: string) => /without the auth line|no auth line/i.test(d),
    evidence: /delivered/i,
  },
  {
    id: 'post-with-auth',
    asks: 'does a post succeed WITH the auth line',
    answered: (d: string) => /with the auth line|correct token/i.test(d),
    evidence: /"type"\s*:\s*"auth"/,
  },
  {
    id: 'epic-shape',
    asks: 'is the consequence for the epic stated',
    answered: (d: string) => /ADX-002/.test(d) && /ADX-003/.test(d),
    evidence: /shape|consequence|changes|unchanged/i,
  },
];

test('the ADX-001 finding answers every question the task asked, with evidence', () => {
  const d = doc();
  const missing = QUESTIONS.filter((q) => !q.answered(d)).map((q) => `${q.id} (${q.asks})`);
  assert.deepEqual(missing, [], `unanswered spike questions:\n  ${missing.join('\n  ')}`);

  const unevidenced = QUESTIONS.filter((q) => !q.evidence.test(d)).map((q) => q.id);
  assert.deepEqual(unevidenced, [], `answered with no evidence: ${unevidenced.join(', ')}`);
});

test('a negative result is recorded as a negative, not softened away', () => {
  const d = doc();
  /*
   * The one outcome that would quietly wreck the epic is a spike that could
   * not obtain the token and says so vaguely. If the finding claims the token
   * IS obtainable, it must say by what mechanism — reading it and injecting it
   * are completely different capabilities with different costs for ADX-002.
   */
  assert.match(d, /inject/i,
    'the finding must state whether the token is READ from the child or INJECTED into it');
});

test('the claims about the relay are still true of the relay', () => {
  const relay = fs.readFileSync(path.join(ROOT, 'agent', 'relay', 'index.js'), 'utf8');
  const d = doc();

  /* The finding rests on the relay controlling the env it spawns with. */
  assert.match(relay, /env:\s*process\.env/,
    'the relay no longer spawns with env: process.env — the injection finding is stale');

  /* And on it owning the child, so it knows the pid the socket is named for. */
  assert.match(relay, /pty\.spawn\(/, 'the relay no longer spawns a PTY child');

  if (/index\.js:(\d+)/.test(d)) {
    const line = Number(/index\.js:(\d+)/.exec(d)![1]);
    const total = relay.split('\n').length;
    assert.ok(line > 0 && line <= total,
      `the finding cites agent/relay/index.js:${line}, which is past the file's ${total} lines`);
  }
});

test('the chokepoint the epic depends on has not moved', () => {
  /*
   * The epic's central architectural claim is that ONE function serves every
   * caller. If sendCommandToAgent stops being the sole entry, the spike's
   * conclusion is still true and the epic's plan is not.
   */
  const send = fs.readFileSync(path.join(ROOT, 'server', 'src', 'lib', 'send-command.ts'), 'utf8');
  assert.match(send, /export function sendCommandToAgent/,
    'sendCommandToAgent is no longer exported from send-command.ts');
});

test('the version floor the finding was measured against is recorded', () => {
  const d = doc();
  assert.match(d, /2\.1\.\d+/, 'the finding must record the Claude Code version it was measured on');
});
