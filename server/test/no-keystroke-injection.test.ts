/**
 * NOTHING IN THIS SERVER TYPES INTO A TERMINAL. The capability is gone, and this
 * test exists to keep it gone.
 *
 * ── WHAT IT COST, AND WHY THE GUARD OUTLIVED THE CODE ─────────────────────────
 * send-command.ts had a fallback: a claude/codex cartridge with no live socket got
 * its command written into the FRONTMOST terminal window by AppleScript. Its own
 * comment admitted the flaw — "it cannot target a specific window, so it lands
 * wherever focus happens to be." That is how mystery text kept appearing in the
 * user's session for two days. Test suites hit it hardest: they use a stub io with
 * no sockets, so EVERY prompt they dispatched typed into the developer's real
 * terminal.
 *
 * It also defeated an egress guard that had already been run and trusted, because
 * that guard instrumented fetch, TCP connect and listen — and `osascript` is a
 * CHILD PROCESS. "Zero egress" was measured and wrong, scoped to the wrong exits.
 *
 * ── WHY THIS FILE GOT STRONGER WHEN THE CODE WAS DELETED ──────────────────────
 * It used to assert the capability was GATED: that an opt-in check sat inside
 * typeIntoTerminal, that the flag defaulted to off, and that a test process could
 * not reach it. Every one of those assertions describes a function that no longer
 * exists, so keeping them would have meant keeping the function alive to be
 * tested — a guard that requires the hazard to exist.
 *
 * It now asserts ABSENCE, across the WHOLE server source rather than one file.
 * That is strictly stronger: the old version could not have caught the capability
 * reappearing in a different module, which is exactly how a deleted convenience
 * comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * THE HAZARD IS WRITING INTO A WINDOW WE DID NOT CREATE — not `osascript` itself.
 *
 * That distinction is the whole difference between a guard people keep and one
 * they switch off. `lib/open-directory.ts` legitimately runs AppleScript to LAUNCH
 * a cartridge: it does `create window with default profile` and writes into the
 * window it just made, or `do script`, which also opens a new one. A blanket ban
 * on osascript would fire on that every time — and a check that cries wolf on
 * ordinary work gets disabled, taking the real protection with it.
 *
 * What was deleted did the opposite: it wrote into `current session of current
 * window` — the FRONTMOST window, whatever the user happened to be reading.
 *
 * So these patterns name the act of reaching a window that already exists and
 * belongs to somebody else.
 */
const KEYSTROKE_PRIMITIVES: { pattern: RegExp; what: string }[] = [
  { pattern: /current session of current window/, what: 'writes into the FRONTMOST window — the exact deleted hazard' },
  { pattern: /of current window/, what: 'targets a window we did not create' },
  { pattern: /System Events/, what: 'AppleScript UI scripting — synthetic keystrokes to whatever has focus' },
  { pattern: /\bkeystroke\b/, what: 'the AppleScript verb for typing into the focused window' },
  { pattern: /\bxdotool\b/, what: 'the X11 equivalent — same hazard, different platform' },
  { pattern: /\bwtype\b/, what: 'the Wayland equivalent — same hazard, different platform' },
  { pattern: /NEONCORE_TERMINAL_FALLBACK/, what: 'the flag that used to enable it' },
  { pattern: /typeIntoTerminal/, what: 'the removed function itself' },
];

/**
 * Comments are stripped before scanning.
 *
 * Without this the sweep matches its OWN prose — the word "keystroke" in the
 * paragraphs above, the name of the removed function in a note explaining that it
 * was removed. A mention is not a use, and a guard that cannot tell them apart
 * reports the documentation of a fix as the return of the bug.
 */
function code(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('no keystroke-injection primitive appears anywhere in the server source', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 50,
    `only ${files.length} source files scanned — the walk is broken, and a broken walk finds `
    + 'nothing and passes');

  const hits: string[] = [];
  for (const f of files) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const k of KEYSTROKE_PRIMITIVES) {
      if (k.pattern.test(src)) hits.push(`${path.relative(SRC, f)} — ${k.what}`);
    }
  }
  assert.deepEqual(hits, [],
    'the capability that typed into whatever window had focus is back:\n  ' + hits.join('\n  '));
});

test('the delivery vocabulary no longer offers a terminal transport', () => {
  /*
   * A transport name nothing can produce is a lie in the type: it invites a
   * caller to branch on a case that cannot happen, and it invites a future
   * implementer to fill it in. Both copies of the union are checked — the server's
   * and the shared client's — because leaving it in one is how they come to
   * disagree about what the system can do.
   */
  const unions = [
    path.join(SRC, 'types.ts'),
    path.join(SRC, '..', '..', 'packages', 'client', 'src', 'types.ts'),
  ];
  for (const u of unions) {
    const src = fs.readFileSync(u, 'utf8');
    assert.match(src, /DeliveryTransport/, `${u} no longer declares DeliveryTransport`);
    assert.ok(!/'terminal-fallback'/.test(src),
      `${path.basename(path.dirname(u))}/types.ts still offers 'terminal-fallback', a transport `
      + 'nothing can produce');
  }
});

test('send-command has no branch left that could reach a terminal', () => {
  /*
   * The delivery chain is where it lived. Asserting on the chain specifically —
   * as well as on the whole tree above — means a reintroduction there fails with
   * a message that names the place, rather than only the generic sweep.
   */
  const send = fs.readFileSync(path.join(SRC, 'lib', 'send-command.ts'), 'utf8');
  const sites = [...send.matchAll(/conclude\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(sites.length >= 4, `only ${sites.length} delivery conclusions found — scan broken`);
  assert.ok(!sites.includes('terminal-fallback'),
    'the delivery chain still concludes with a terminal transport');
  assert.ok(!/execSync|spawnSync|child_process/.test(send),
    'send-command spawns a child process again — that is the exit the original egress guard '
    + 'missed, and how the keystroke fallback went unnoticed');
});

test('the one place that still scripts a terminal only writes into a window it CREATED', () => {
  /*
   * open-directory.ts launches cartridges, which is a legitimate use of the same
   * tool. It is checked positively rather than exempted by name: an exemption
   * would excuse a future change inside it, which is precisely where a deleted
   * convenience would come back wearing a permitted file's name.
   */
  const f = path.join(SRC, 'lib', 'open-directory.ts');
  const src = code(fs.readFileSync(f, 'utf8'));
  if (!/osascript/.test(src)) return;                    // nothing to police
  assert.match(src, /create window with default profile|do script/,
    'open-directory scripts a terminal without creating a window to write into');
  assert.ok(!/current session of current window/.test(src),
    'open-directory now writes into the FRONTMOST window — the deleted hazard, relocated');
});
