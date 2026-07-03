// Deterministic assertion helpers shared by task assert.mjs files.
//
// Assertions read the END-STATE of the fixture (files the model wrote, verify-
// command exit codes) — never the model's streamed prose. A content check on
// the transcript is a false-positive machine: the answer token shows up the
// moment the agent reads the file, and stderr noise (even NeonCore's own :4040)
// can satisfy it. So "answer" tasks make the model WRITE its answer to a file,
// and we assert on that file.

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Build a {pass, checks[]} result from a list of {name, pass, detail} checks. */
export function result(checks) {
  return { pass: checks.every((c) => c.pass), checks };
}

export async function fileMatches(cwd, rel, re, name) {
  try {
    const txt = await readFile(path.join(cwd, rel), 'utf8');
    const ok = re.test(txt);
    return { name: name || `matches:${rel}:${re}`, pass: ok, detail: ok ? '' : `no match for ${re}` };
  } catch (err) {
    return { name: name || `matches:${rel}`, pass: false, detail: `read failed: ${err.message}` };
  }
}

export async function fileNotMatches(cwd, rel, re, name) {
  try {
    const txt = await readFile(path.join(cwd, rel), 'utf8');
    const ok = !re.test(txt);
    return { name: name || `notMatches:${rel}:${re}`, pass: ok, detail: ok ? '' : `unexpected match for ${re}` };
  } catch (err) {
    return { name: name || `notMatches:${rel}`, pass: false, detail: `read failed: ${err.message}` };
  }
}

/** Pass iff the file's trimmed content exactly equals `expected`. */
export async function fileTextEquals(cwd, rel, expected, name) {
  try {
    const txt = (await readFile(path.join(cwd, rel), 'utf8')).trim();
    const ok = txt === String(expected);
    return { name: name || `equals:${rel}`, pass: ok, detail: ok ? '' : `got "${txt.slice(0, 40)}", want "${expected}"` };
  } catch (err) {
    return { name: name || `equals:${rel}`, pass: false, detail: `read failed: ${err.message}` };
  }
}

/**
 * Pass iff the file's non-empty lines, as a SET, exactly equal `expected` —
 * order-independent, and (crucially) rejects extra entries so a bare `ls` dump
 * that includes the distractor file fails.
 */
export async function fileLineSetEquals(cwd, rel, expected, name) {
  try {
    const lines = (await readFile(path.join(cwd, rel), 'utf8'))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const got = new Set(lines);
    const want = new Set(expected);
    const ok = got.size === want.size && [...want].every((e) => got.has(e));
    return { name: name || `lineSet:${rel}`, pass: ok, detail: ok ? '' : `got [${[...got]}], want [${[...want]}]` };
  } catch (err) {
    return { name: name || `lineSet:${rel}`, pass: false, detail: `read failed: ${err.message}` };
  }
}

// Env allowlist mirrors runner.mjs — verify commands run model-written code
// (require of files the model authored), which must not see the developer's
// third-party secrets.
function scrubbedEnv() {
  const allow = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TERM', 'NODE']);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (allow.has(k)) env[k] = v;
  return env;
}

/** Run a verify command in cwd with a scrubbed env; pass iff it exits 0. */
export function commandSucceeds(cwd, cmd, args, name) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe', env: scrubbedEnv(), timeout: 15000 });
    return { name: name || `cmd:${cmd} ${args.join(' ')}`, pass: true, detail: '' };
  } catch (err) {
    return { name: name || `cmd:${cmd} ${args.join(' ')}`, pass: false, detail: `exit ${err.status ?? err.code}` };
  }
}
