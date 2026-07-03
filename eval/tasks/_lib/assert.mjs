// Deterministic assertion helpers shared by task assert.mjs files.
//
// Assertions read the END-STATE of the fixture (files, verify-command exit
// codes), not the model's prose. Prefer these over stdout matching: the goal is
// "did the change actually happen", which the agent cannot talk its way past.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Build a {pass, checks[]} result from a list of {name, pass, detail} checks. */
export function result(checks) {
  return { pass: checks.every((c) => c.pass), checks };
}

export function fileExists(cwd, rel) {
  const ok = existsSync(path.join(cwd, rel));
  return { name: `exists:${rel}`, pass: ok, detail: ok ? '' : 'missing' };
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

/** Run a shell verify command in cwd; pass iff it exits 0. */
export function commandSucceeds(cwd, cmd, args, name) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe' });
    return { name: name || `cmd:${cmd} ${args.join(' ')}`, pass: true, detail: '' };
  } catch (err) {
    return { name: name || `cmd:${cmd} ${args.join(' ')}`, pass: false, detail: `exit ${err.status}` };
  }
}

/** Count regex matches across a grep-like search of the fixture (via git grep-free rg fallback). */
export async function stdoutContains(stdout, needle, name) {
  const ok = String(stdout).includes(needle);
  return { name: name || `stdout~${needle}`, pass: ok, detail: ok ? '' : 'not in output' };
}
