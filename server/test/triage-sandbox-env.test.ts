/**
 * A SANDBOX COMMAND NEVER SEES THE SERVER'S SECRETS. The repro and suite commands are written by a
 * cartridge, possibly steered by a ticket; they ran with the server's whole environment — the Jira
 * token, the fleet token, provider keys — and with a test runner's own context, which made a
 * failing reproduction report success. SET-BASED: every key of a hostile environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realSandbox, sandboxEnv, SANDBOX_ENV_KEYS } from '../src/lib/triage/sandbox.ts';

const HOSTILE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin', HOME: '/home/x', LANG: 'en_US.UTF-8',
  TRIAGE_DEMO_JIRA_TOKEN: 'jira-secret', JIRA_API_TOKEN: 'jira-secret', NEONCORE_FLEET_TOKEN: 'fleet-secret',
  ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'sk-secret', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret', DATABASE_URL: 'postgres://prod', NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: '--require evil.js',
};

test('only the allow-listed keys pass, plus CI=1', () => {
  const env = sandboxEnv(HOSTILE);
  for (const k of Object.keys(env)) assert.ok(k === 'CI' || (SANDBOX_ENV_KEYS as readonly string[]).includes(k), `${k} leaked into the sandbox`);
  for (const k of Object.keys(HOSTILE)) {
    if (!(SANDBOX_ENV_KEYS as readonly string[]).includes(k)) assert.equal(env[k], undefined, `${k} leaked into the sandbox`);
  }
  assert.equal(env.CI, '1');
  assert.equal(env.PATH, HOSTILE.PATH, 'the tools are still found');
});

test('a command run in the sandbox cannot read a server secret', async () => {
  process.env.NEONCORE_FLEET_TOKEN_PROBE = 'fleet-secret-probe';
  const r = await realSandbox.runCommand(process.cwd(), 'env', 10_000);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.output, /fleet-secret-probe/);
  assert.match(r.output, /CI=1/);
});
