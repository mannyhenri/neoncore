#!/usr/bin/env node
/**
 * Set up the Bug Triage demo:
 *   1. copy app/ to a fresh directory (a temp dir, or --dir <path>) and make it its own git repo
 *      (never nested inside neoncore's), one commit on `main`;
 *   2. start the Jira simulator seeded with the 11 issues (--port, default 4071);
 *   3. print the source config to paste into the Triage section.
 *
 *   node eval/triage-demo/setup.mjs [--dir /tmp/ledgerly] [--port 4071]
 *
 * Then set the two env names it prints (any non-empty values work with the simulator) in the
 * NeonCore server's environment, and add the source. Ctrl-C stops the simulator.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startJiraSim } from './jira-sim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTH_ENV = { email: 'TRIAGE_DEMO_JIRA_EMAIL', token: 'TRIAGE_DEMO_JIRA_TOKEN' };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Copy app/ into `dir` (created when missing; must be empty) and commit it as a new repo. */
export function makeRepo(dir) {
  const target = resolve(dir ?? mkdtempSync(join(tmpdir(), 'ledgerly-')));
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} is not empty`);
  cpSync(join(HERE, 'app'), target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, '-c', 'user.name=Ledgerly Demo', '-c', 'user.email=demo@ledgerly.test', 'add', '-A');
  git(target, '-c', 'user.name=Ledgerly Demo', '-c', 'user.email=demo@ledgerly.test', 'commit', '-q', '-m', 'Ledgerly 1.4.0');
  return target;
}

/** The Triage source config for this demo (docs/plans/bug-triage.md, "Source"). */
export function sourceConfig({ jiraBaseUrl, repoPath }) {
  return {
    name: 'Ledgerly demo (Jira simulator)',
    jiraBaseUrl,
    authEnv: { ...AUTH_ENV },
    projects: ['DEMO'],
    issueTypes: ['Bug'],
    repoFor: { DEMO: repoPath },
    reporters: 'internal',
    transitions: false,
    protectedPaths: ['src/auth/**', '**/payments/**', '**/migrations/**', '.github/**', '**/*.yml'],
    limits: { maxFiles: 5, maxLines: 200, minutesPerIssue: 30, dispatchesPerIssue: 8, reviewRounds: 2 },
    pollSeconds: 30,
  };
}

/** Everything at once; returns the repo path, the running simulator and the config. */
export async function setup({ dir, port = 4071 } = {}) {
  const repoPath = makeRepo(dir);
  const sim = await startJiraSim({ port });
  return { repoPath, sim, config: sourceConfig({ jiraBaseUrl: sim.baseUrl, repoPath }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const { repoPath, sim, config } = await setup({ dir: arg('dir'), port: Number(arg('port') ?? 4071) });
  console.log(`Demo repo:      ${repoPath}  (git, branch main; npm test runs its suite)`);
  console.log(`Jira simulator: ${sim.baseUrl}  (${sim.state.issues.size} issues in DEMO)`);
  console.log(`\nSet in the NeonCore server's environment (any non-empty values work here):`);
  console.log(`  ${AUTH_ENV.email}=triage-bot@ledgerly.test`);
  console.log(`  ${AUTH_ENV.token}=demo-token`);
  console.log('\nTriage source config:\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nCtrl-C stops the simulator.');
}
