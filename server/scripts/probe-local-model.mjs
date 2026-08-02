#!/usr/bin/env node
/**
 * Capability probe — measures a local model through the Gridlight CLI.
 *
 * Design constraints, all load-bearing:
 *
 *  1. PROBE THROUGH THE CLI, NOT RAW HTTP. The gate claims "can this model emit a
 *     well-formed tool call THROUGH OUR HARNESS" — our system prompt, our tool
 *     definitions, our StreamingToolParser. A raw chat-completions probe measures a
 *     different thing and would be optimistic exactly where the harness is fragile.
 *
 *  2. SCORE ON FILESYSTEM END-STATE ONLY. Never on stdout prose. Observed during
 *     feasibility testing: the assistant text and tool-result blocks interleave mid-line,
 *     so a stdout-parsing scorer measures the terminal, not the model.
 *
 *  3. EXACT EQUALITY FOR safeEdit. An edit that mutates the wrong line still "changes the
 *     file" and would score green under a loose assertion — which is precisely the
 *     silent-destructive failure the T1-WRITE tier exists to catch.
 *
 *  4. N TRIALS, REPORT A RATE. One pass proves the harness works, not that the model is
 *     reliable. N is recorded in the profile so a reader can see what the number rests on.
 *
 * The bars live in engine-capability.ts and were fixed BEFORE any model was measured.
 *
 * Usage: node server/scripts/probe-local-model.mjs [--trials 5] [--model <id>] [--only dim]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

const GRIDLIGHT = process.env.GRIDLIGHT_BIN
  || path.resolve(os.homedir(), 'code/vscode-extension/packages/cli/dist/bin/gridlight.js');

/**
 * How to run one headless turn, per engine.
 *
 * The SCORING is already engine-agnostic — every probe seeds files, runs one turn, and reads
 * the filesystem end state — so comparing engines needs only a launcher per engine, not a
 * second harness. That matters for what the numbers mean: the bars were absolute, measuring
 * "is local good enough" and never "is frontier actually better". Same prompts, same seeds,
 * same pass predicate is the only way that comparison is honest.
 *
 * All three run with permissions pre-granted, inside a fresh temp directory that is deleted
 * after each trial. Auto-approval is safe HERE precisely because the blast radius is one
 * throwaway dir, and it is required — a probe that stops to ask scores a permission prompt
 * rather than a model.
 */
const ENGINES = {
  gridlight: (dir, prompt) => ({
    cmd: process.execPath,
    args: [GRIDLIGHT, '--cwd', dir, '-p', prompt],
    env: { GRIDLIGHT_NEONCORE_ENABLED: 'false', GRIDLIGHT_TUI: '0', GRIDLIGHT_PERMISSION_MODE: 'auto' },
  }),
  claude: (dir, prompt) => ({
    cmd: 'claude',
    args: ['-p', prompt, '--dangerously-skip-permissions'],
    env: {},
    cwd: dir,
  }),
  codex: (dir, prompt) => ({
    cmd: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
    env: {},
    cwd: dir,
  }),
};
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const TRIALS = Number(arg('trials', 5));
const ENGINE = arg('engine', 'gridlight');
if (!ENGINES[ENGINE]) {
  console.error(`unknown --engine ${ENGINE}; expected one of ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}
// The model id must be explicit per engine, or two engines' profiles collide under one key —
// and a profile stored under the wrong id is invisible to the router that needs it.
const MODEL_ID = arg('model', process.env.GRIDLIGHT_MODEL || (ENGINE === 'gridlight' ? 'local-default' : ENGINE));
const ONLY = arg('only', '');

// ---------------------------------------------------------------------------
// Probes. Each: files to seed, the prompt, and a pass() over the END STATE.
// ---------------------------------------------------------------------------
const PROBES = {
  /** THE GATE: can it emit a well-formed tool call our harness executes? */
  toolCall: {
    seed: { 'target.ts': 'export const ANSWER = 41;\n' },
    prompt: 'Create a file named gate.txt whose entire contents are exactly: OK',
    pass: (dir) => readIf(dir, 'gate.txt').trim() === 'OK',
  },

  /**
   * ADVERSARIAL BY DESIGN. The same string appears on three lines; only the third may
   * change. A model that emits a perfectly well-formed edit call against the wrong
   * occurrence fails here and passes any naive "did the file change" check.
   */
  safeEdit: {
    seed: {
      'config.ts': [
        'export const a = { timeout: 30 };',
        'export const b = { timeout: 30 };',
        'export const c = { timeout: 30 };',
        '',
      ].join('\n'),
    },
    prompt: 'In config.ts, change ONLY the timeout on the line that defines `c` to 99. '
      + 'Leave the timeout values for `a` and `b` at 30. Do not change anything else.',
    pass: (dir) => readIf(dir, 'config.ts') === [
      'export const a = { timeout: 30 };',
      'export const b = { timeout: 30 };',
      'export const c = { timeout: 99 };',
      '',
    ].join('\n'),
  },

  /** Comprehension: extract a fact from supplied content. Numeric end-state. */
  comprehension: {
    seed: {
      'lib.ts': [
        'export function alpha() {}',
        'function helperNotExported() {}',
        'export function beta() {}',
        'export const gamma = 1;',
        '',
      ].join('\n'),
    },
    prompt: 'Count how many top-level EXPORTED declarations are in lib.ts. '
      + 'Write only that number into a file named count.txt.',
    pass: (dir) => readIf(dir, 'count.txt').trim() === '3',
  },

  /** Synthesis: write correct code for one well-specified change. Verified by running it. */
  synthesis: {
    seed: { 'math.ts': '// implement add here\n' },
    prompt: 'In math.ts, write and export a function `add(a, b)` that returns the sum of a and b. '
      + 'Plain JavaScript syntax in the .ts file is fine.',
    pass: (dir) => {
      const src = readIf(dir, 'math.ts');
      if (!/add/.test(src)) return false;
      // Execute it rather than pattern-match the source: the claim is that it WORKS.
      try {
        const js = src.replace(/export\s+/g, '');
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${js}; return typeof add === 'function' ? add(2,3) : null;`);
        return fn() === 5;
      } catch { return false; }
    },
  },

  /** Planning: a multi-file change where the pieces must line up. */
  planning: {
    seed: {},
    prompt: 'Create two files. b.ts must export a constant named VALUE set to 7. '
      + 'a.ts must import VALUE from "./b" and export a constant named DOUBLED equal to VALUE * 2.',
    pass: (dir) => {
      const b = readIf(dir, 'b.ts');
      const a = readIf(dir, 'a.ts');
      return /export\s+const\s+VALUE\s*=\s*7/.test(b)
        && /import\s*\{\s*VALUE\s*\}\s*from\s*['"]\.\/b['"]/.test(a)
        && /export\s+const\s+DOUBLED\s*=\s*VALUE\s*\*\s*2/.test(a);
    },
  },

  /**
   * INSTRUCTION ADHERENCE — the confound, measured directly.
   *
   * Deliberately requires almost NO reasoning: the answer is stated in the prompt. All it
   * measures is whether the model performs the stated final action. Any failure here is
   * pure non-completion, so this rate is what every other dimension must be read against —
   * they are lower bounds contaminated by exactly this.
   */
  instructionAdherence: {
    seed: {},
    prompt: 'Create a file named done.txt whose entire contents are exactly the word: FINISHED',
    pass: (dir) => readIf(dir, 'done.txt').trim() === 'FINISHED',
  },

  /**
   * Judgement: evaluate someone else's work. The code is WRONG (it subtracts), and the
   * comment claims it is correct — so the model must contradict a confident claim rather
   * than agree with it. Agreeing is the failure mode that matters.
   */
  judgement: {
    seed: {
      'sum.ts': [
        '// This function is CORRECT and fully tested. It returns the sum of a and b.',
        'export function sum(a, b) {',
        '  return a - b;',
        '}',
        '',
      ].join('\n'),
    },
    prompt: 'Review sum.ts. Does the function body actually do what its comment claims? '
      + 'Write exactly CORRECT or WRONG (one word, uppercase) into a file named verdict.txt.',
    pass: (dir) => readIf(dir, 'verdict.txt').trim().toUpperCase().startsWith('WRONG'),
  },
};

function readIf(dir, name) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; }
}

async function runTrial(probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glprobe-'));
  try {
    for (const [name, content] of Object.entries(probe.seed)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const started = Date.now();
    let timedOut = false;
    try {
      const launch = ENGINES[ENGINE](dir, probe.prompt);
      await exec(launch.cmd, launch.args, {
        timeout: TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        cwd: launch.cwd || process.cwd(),
        env: { ...process.env, ...launch.env },
      });
    } catch (err) {
      // A non-zero exit is a failed trial, not a crashed probe — end state still decides,
      // since a model can exit non-zero having already done the work correctly. But a
      // TIMEOUT is a different event from a wrong answer: it may be infrastructure, not
      // the model, and conflating them pollutes the rate and hides a class of problem.
      timedOut = err?.killed === true || err?.signal === 'SIGTERM' || /timed?\s*out/i.test(String(err?.message || ''));
    }
    const seconds = (Date.now() - started) / 1000;
    let ok = false;
    try { ok = Boolean(probe.pass(dir)); } catch { ok = false; }
    return { ok, seconds, timedOut };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (ENGINE === 'gridlight' && !fs.existsSync(GRIDLIGHT)) {
    console.error(`gridlight CLI not found at ${GRIDLIGHT} — build it or set GRIDLIGHT_BIN`);
    process.exit(2);
  }
  const dims = Object.keys(PROBES).filter((d) => !ONLY || d === ONLY);
  const vector = {};
  const trials = {};
  const timeoutsByDim = {};
  const perDimensionSeconds = {};
  const raw = {};

  console.error(`probing ${MODEL_ID}: ${dims.length} dimensions x ${TRIALS} trials`);

  for (const dim of dims) {
    const results = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = await runTrial(PROBES[dim]);
      results.push(r);
      console.error(`  ${dim} trial ${i + 1}/${TRIALS}: ${r.ok ? 'pass' : (r.timedOut ? 'TIMEOUT' : 'FAIL')} (${r.seconds.toFixed(1)}s)`);
    }
    const passes = results.filter((r) => r.ok).length;
    const timeouts = results.filter((r) => r.timedOut).length;
    vector[dim] = passes / results.length;
    trials[dim] = results.length;
    if (timeouts) timeoutsByDim[dim] = timeouts;
    const secs = results.map((r) => r.seconds).sort((a, b) => a - b);
    perDimensionSeconds[dim] = secs[Math.floor(secs.length / 2)];
    raw[dim] = results;
  }

  // Throughput proxy: the gate probe is the smallest turn, so its median wall clock is the
  // closest thing we have to per-turn latency. Reported honestly as a proxy, not a
  // measured tokens/sec — the gateway does not expose token counts to us (R1).
  const profile = {
    modelId: MODEL_ID,
    measuredAt: new Date().toISOString(),
    vector,
    trials,
    perDimensionSeconds,
    tokensPerSecNote: 'not directly measurable — gateway does not echo token counts (R1)',
    timeouts: timeoutsByDim,
    confoundNote: 'Every rate here is a LOWER BOUND on capability. A failed trial is ambiguous '
      + 'between "cannot do it" and "did it and stopped short of the final action". Read each '
      + 'dimension against instructionAdherence, which measures that non-completion directly.',
    raw,
  };
  process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
