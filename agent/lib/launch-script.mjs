/**
 * The launch script a cartridge terminal runs: cd into the repo, set the relay's environment,
 * start the relay. Shared by the machine runner (agent/runner/index.js) and the server's own
 * launcher (server/src/lib/open-directory.ts) so the two cannot drift.
 *
 * EVERY VALUE IS DATA, NEVER SHELL. The values come from HTTP requests and from text a person
 * typed — a launch context, a resume session id, a folder path. They used to be written as
 * `export K="<JSON string>"`: bash still expands `$(…)`, backticks and `$VAR` inside double
 * quotes, so a launch context containing ``run `npm test` `` ran npm test at launch, and a
 * crafted resume id ran anything at all.
 *
 *   POSIX   values are single-quoted; bash expands nothing inside single quotes.
 *   Windows cmd.exe has no quoting that survives `"`, `%` and newlines, so the environment goes
 *           in a JSON side file named by NEONCORE_LAUNCH_ENV_FILE, which the relay bootstrap
 *           (agent/relay/launch.js) reads and deletes. Only the side file's own path — which we
 *           generate — and the repo path are written into the .cmd script.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One POSIX shell word holding exactly `value`. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** A path for cmd.exe inside double quotes: `%` doubled (batch files expand %VAR%). */
export function cmdPath(value) {
  const s = String(value);
  if (/["\r\n]/.test(s)) throw new Error(`refusing a path cmd.exe cannot quote: ${JSON.stringify(s)}`);
  return s.replace(/%/g, '%%');
}

const PROFILE_LINES = [
  '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
  '[ -f "$HOME/.zshrc" ]  && source "$HOME/.zshrc"  2>/dev/null',
  '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
];

/**
 * @param {{cwd: string, env: Record<string,string>, argv: string[]}} o
 *   argv — the program and its arguments, each quoted as one word (e.g. [node, launch.js]).
 */
export function posixLaunchScript({ cwd, env, argv }) {
  for (const k of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`not an environment variable name: ${k}`);
  }
  return [
    '#!/usr/bin/env bash',
    `cd ${shQuote(cwd)}`,
    ...Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v ?? '')}`),
    // Source login files so PATH picks up claude/node even under launchd/systemd.
    ...PROFILE_LINES,
    argv.map(shQuote).join(' '),
  ].join('\n') + '\n';
}

/**
 * @param {{cwd: string, env: Record<string,string>, argv: string[], envFile: string}} o
 *   envFile — where the environment is written (JSON); the script only names it.
 */
export function windowsLaunchScript({ cwd, env, argv, envFile }) {
  fs.writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
  return [
    '@echo off',
    `cd /d "${cmdPath(cwd)}"`,
    `set "NEONCORE_LAUNCH_ENV_FILE=${cmdPath(envFile)}"`,
    argv.map((a) => `"${cmdPath(a)}"`).join(' '),
  ].join('\r\n') + '\r\n';
}

/** A fresh path in the temp dir for a launch script or its env file. */
export function launchTempPath(ext) {
  return path.join(os.tmpdir(), `neoncore-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}
