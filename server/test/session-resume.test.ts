/**
 * A restored cartridge must come back as ITSELF, and a stall must be visible even when the
 * cartridge is busy.
 *
 * WHAT HAPPENED, on one night, twice. Four sessions were killed. They were relaunched with
 * `claude --resume` BY HAND, because nothing in NeonCore does it: `NEONCORE_SESSION_ID` is
 * written into every launch script by `open-directory.ts` and `runner/index.js` and read by
 * nobody, so every launch NeonCore performs starts a cold session. The recovery subsystem plan
 * locked this deliberately —
 *
 *   "D1 — Recovery mechanism: transcript replay (NeonCore-owned) ... NOT native `--resume`
 *    (that is the fragile path already failing us; it can be added later as a fidelity
 *    optimization)."
 *
 * — and "later" is now. Replay stays the fallback; native resume becomes the preferred path,
 * because a summary of sixteen turns capped at 18k chars is not the session.
 *
 * THEN THE SECOND HALF. Having been restored without a relay, the cartridge had no command
 * channel, its workflow dispatch bounced, and the step went `failed`. Restored again WITH a
 * relay, it auto-compacted at 20:31Z, lost the completion contract the dispatch had given it,
 * and worked for 2h53m while the engine sat on `Waiting for webhook callback`. Reason 5
 * (`agent-idle`) could not see it: that clause requires the agent to be NOT `working` and quiet
 * for ten minutes, and this agent was loudly, continuously busy the entire time. It is guarded
 * "so a working cartridge is never accused of stalling" — which is exactly how a working
 * cartridge stalls in silence.
 *
 * These tests are SET-BASED on purpose. An example-based test passes on a half-done fix: wire
 * resume for `claude`, forget `codex`, and a single-case test is green while two thirds of the
 * registry is cold. Each set below is read from the CODE — the `AgentType` union, the relay
 * alias table, the relay's own import list — so adding a fourth engine fails here first.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { RESUME_ARGS, resumeArgsFor } from '../../agent/relay/resume-args.mjs';
import {
  RELAY_LAUNCH_TYPES, relayLaunchEnv, RELAY_INSTALL_FILES, RELAY_INSTALL_SIBLINGS,
} from '../src/lib/open-directory.ts';
import {
  workflowNeedsAttention, ATTENTION_REASONS, DISPATCH_SILENT_AFTER_MS, STALE_AFTER_MS,
} from '../src/lib/workflow-attention.ts';

installStubIO();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SESSION = 'a447265c-f2fa-41da-9585-fe546cad702e';

/**
 * The agent-type registry, read from the type that DEFINES it rather than restated here.
 * A copy of the list in the test is a second source of truth that drifts silently.
 */
function agentTypesFromSource(): string[] {
  const src = fs.readFileSync(path.join(repoRoot, 'server/src/types.ts'), 'utf-8');
  const m = src.match(/export type AgentType\s*=([^;]+);/);
  assert.ok(m, 'could not find `export type AgentType` in server/src/types.ts');
  const types = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(types.length > 0, 'parsed an empty AgentType union');
  return types;
}

// ─────────────────────────────────────────────────────────────────────────────
// SET 1 — every engine NeonCore can launch has an explicit resume verdict.
// ─────────────────────────────────────────────────────────────────────────────

test('EVERY AgentType has an explicit entry in the resume registry', () => {
  const missing = agentTypesFromSource().filter(
    (t) => !Object.prototype.hasOwnProperty.call(RESUME_ARGS, t),
  );
  assert.deepEqual(missing, [],
    `these agent types can be launched but have no resume verdict: ${missing.join(', ')}. `
    + 'Add an entry — a function for a CLI that resumes, or null for one that cannot. '
    + 'Silence here means a cold session nobody asked for.');
});

test('EVERY resume-capable engine puts the session id into its argv', () => {
  const capable = Object.entries(RESUME_ARGS).filter(([, v]) => v !== null).map(([k]) => k);
  assert.ok(capable.length > 0, 'no engine claims native resume — the feature is inert');
  for (const type of capable) {
    const args = resumeArgsFor(type, SESSION);
    assert.ok(Array.isArray(args) && args.length > 0, `${type}: expected argv, got ${args}`);
    assert.ok(args!.includes(SESSION), `${type}: argv ${JSON.stringify(args)} omits the session id`);
  }
});

test('an engine with no native resume returns null rather than guessing a flag', () => {
  const incapable = Object.entries(RESUME_ARGS).filter(([, v]) => v === null).map(([k]) => k);
  for (const type of incapable) {
    assert.equal(resumeArgsFor(type, SESSION), null,
      `${type} has no documented resume flag; inventing one launches a broken terminal`);
  }
});

test('EVERY engine declines to resume when no session id is supplied', () => {
  // The launch paths pass '' for an ordinary cold start. A registry that turned that into
  // `--resume ''` would break every normal launch.
  for (const type of Object.keys(RESUME_ARGS)) {
    assert.equal(resumeArgsFor(type, ''), null, `${type} resumed on an empty session id`);
    assert.equal(resumeArgsFor(type, undefined as unknown as string), null,
      `${type} resumed on a missing session id`);
  }
});

test('an unknown engine gets no resume args — no fallback to claude', () => {
  assert.equal(resumeArgsFor('some-future-cli', SESSION), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// SET 2 — every relay-backed launch alias carries the resume id to the relay.
// ─────────────────────────────────────────────────────────────────────────────

test('EVERY relay-backed launch alias forwards a resume session id into the launch env', () => {
  const aliases = Object.keys(RELAY_LAUNCH_TYPES);
  assert.ok(aliases.length > 0, 'no relay-backed aliases — the table is empty');
  for (const alias of aliases) {
    const env = relayLaunchEnv(alias, 'neoncore-x-1', SESSION);
    assert.ok(env, `${alias}: expected relay env, got ${env}`);
    assert.equal(env!.NEONCORE_RESUME_SESSION_ID, SESSION,
      `${alias}: the resume id never reaches the relay, so the session starts cold`);
  }
});

test('EVERY relay-backed alias omits the resume var entirely on a cold start', () => {
  // An empty NEONCORE_RESUME_SESSION_ID is indistinguishable from an unset one to the relay,
  // but exporting an empty var into every launch script is noise that reads as a bug.
  for (const alias of Object.keys(RELAY_LAUNCH_TYPES)) {
    const env = relayLaunchEnv(alias, 'neoncore-x-1', '');
    assert.ok(env, `${alias}: expected relay env`);
    assert.ok(!('NEONCORE_RESUME_SESSION_ID' in env!),
      `${alias}: exported an empty resume var on a cold start`);
  }
});

test('EVERY relay-backed alias declares the agent type the relay will spawn', () => {
  // The relay derives its binary from NEONCORE_AGENT_TYPE when AGENT_CMD is unset. An alias
  // that forgets it silently spawns `claude` no matter which engine was asked for.
  for (const [alias, type] of Object.entries(RELAY_LAUNCH_TYPES)) {
    const env = relayLaunchEnv(alias, 'neoncore-x-1', SESSION);
    assert.equal(env!.NEONCORE_AGENT_TYPE, type, `${alias}: wrong or missing NEONCORE_AGENT_TYPE`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SET 3 — everything the relay imports actually ships with the relay.
// ─────────────────────────────────────────────────────────────────────────────

test('EVERY local module the relay imports is installed alongside it', () => {
  // ~/.neoncore/relay is a COPY on a fresh machine and a symlink to the repo on a dev box. The
  // symlink hides a missing file completely: `../lib/fleet-token.mjs` resolves through it and
  // works, then throws ERR_MODULE_NOT_FOUND on the first real install. A relay that cannot
  // boot is a cartridge that cannot be recovered.
  const declared = new Set([...RELAY_INSTALL_FILES, ...RELAY_INSTALL_SIBLINGS]);
  const missing: string[] = [];
  for (const entry of ['index.js', 'launch.js']) {
    const src = fs.readFileSync(path.join(repoRoot, 'agent/relay', entry), 'utf-8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      if (!declared.has(m[1]) && !declared.has(m[1].replace(/^\.\//, ''))) missing.push(`${entry} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [],
    `the relay imports these but the installer does not copy them: ${missing.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SET 4 — a stall is a stall whether the cartridge is quiet OR busy.
// ─────────────────────────────────────────────────────────────────────────────

let n = 0;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function run(): string {
  const id = `wf-res-${++n}`;
  db.prepare("INSERT INTO workflows (id, name, status, created_at, template_id, run_number) VALUES (?,?,'running',?,'tpl',1)")
    .run(id, `run ${id}`, iso(0));
  return id;
}

function agent(status: string, lastSeenMsAgo: number): string {
  const id = `ag-res-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen, pending_question)
              VALUES (?,?,?,?,?,?,?,?,'')`)
    .run(id, `t/${id}`, 'm', '/r', 'r', 'claude', status, iso(lastSeenMsAgo));
  return id;
}

function step(wf: string, o: { executor: string; startedMsAgo: number; result?: string; prompt?: string }): string {
  const id = `st-res-${++n}`;
  db.prepare(`INSERT INTO workflow_steps
      (id, workflow_id, name, position_y, status, executor_type, executor_id, executor_config,
       auto_advance, created_at, recovery_status, dispatched_prompt, result, started_at)
      VALUES (?,?,?,?,'running','claude-code',?,'{}',1,?,'',?,?,?)`)
    .run(id, wf, `step ${n}`, n, o.executor, iso(0), o.prompt ?? 'do the thing',
         o.result ?? '', iso(o.startedMsAgo));
  return id;
}

test('the attention registry names the busy-but-silent stall', () => {
  assert.ok(ATTENTION_REASONS.includes('agent-silent' as never),
    'a reason nothing can report is a stall nobody sees');
});

test('EVERY liveness shape of an unreported dispatch is flagged', () => {
  // The two halves of one failure. Reason 5 owns the quiet agent; without its sibling, the
  // BUSY agent — the one that auto-compacted and forgot the contract — is invisible forever,
  // and the busier it is the more thoroughly it hides.
  const CASES: { label: string; reason: string; build: () => string }[] = [
    {
      label: 'dispatched, then the cartridge went quiet (the original agent-idle)',
      reason: 'agent-idle',
      build: () => {
        const wf = run();
        step(wf, { executor: agent('idle', STALE_AFTER_MS * 2), startedMsAgo: STALE_AFTER_MS * 3 });
        return wf;
      },
    },
    {
      label: 'dispatched long ago, cartridge alive and working, still nothing reported',
      reason: 'agent-silent',
      build: () => {
        const wf = run();
        step(wf, {
          executor: agent('working', 5_000),
          startedMsAgo: DISPATCH_SILENT_AFTER_MS + 60_000,
        });
        return wf;
      },
    },
  ];

  const wrong: string[] = [];
  for (const c of CASES) {
    const got = workflowNeedsAttention(c.build());
    if (got?.reason !== c.reason) wrong.push(`${c.label}: expected ${c.reason}, got ${got?.reason ?? 'null'}`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('a busy cartridge inside the normal dispatch window is never accused', () => {
  // The false positive that would make this useless: a long but legitimate task. One loop of a
  // live epic ran 65 minutes and completed normally; nudging it would have been noise.
  const wf = run();
  step(wf, { executor: agent('working', 5_000), startedMsAgo: DISPATCH_SILENT_AFTER_MS - 60_000 });
  assert.equal(workflowNeedsAttention(wf), null);
});

test('a dispatch that already reported a result is never a stall, however old', () => {
  const wf = run();
  step(wf, {
    executor: agent('working', 5_000),
    startedMsAgo: DISPATCH_SILENT_AFTER_MS * 10,
    result: 'DONE GLW-022 · commit 941fd84 · 25 remaining',
  });
  assert.equal(workflowNeedsAttention(wf), null);
});
