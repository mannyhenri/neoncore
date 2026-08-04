/**
 * A confer must be able to BUILD MORE THAN ONCE.
 *
 * The real job that broke the old shape: an evaluation pass produces a document with 20 bugs
 * in it, and you hand that document to a confer. One Build milestone means the panel gets a
 * single pass at 20 fixes — so it either rushes them, or (what actually happens) fixes three,
 * signals done, and the confer sails on to Cross-review with 17 bugs still live. The cycle had
 * no way to say "go round again".
 *
 * So the build/fix milestone is the ONE step a confer may repeat: `buildRounds: N` expands the
 * plan to N build milestones, each with its own dispatch, its own all-participants-signalled
 * gate, and — the part that makes a round mean something — its own commit + push to the
 * ongoing branch. A round that leaves nothing on the remote is indistinguishable from a round
 * that did nothing.
 *
 * SET-BASED ON PURPOSE. Everything below iterates the mode registry (MILESTONE_SETS) rather
 * than testing `divide` and calling it a day. Both modes have a build-shaped step; a fix that
 * only teaches `divide` to iterate is exactly the half-done change this file exists to catch.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import {
  CONFER_MODES,
  MAX_BUILD_ROUNDS,
  clampBuildRounds,
  conferPlan,
  iteratingKeyFor,
  buildMilestonePrompt,
  startConfer,
  recordMilestoneDone,
  getConfer,
} from '../src/lib/confer-conductor.js';

installStubIO();

const ISO = new Date().toISOString();
let n = 0;

function agent(repoPath = '/tmp/confer-repo'): string {
  const id = `confer-p${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, agent_type, status, last_seen)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, `t/${id}`, 'test-machine', repoPath, 'confer-repo', 'claude', 'idle', ISO);
  return id;
}

/** A participant shaped the way the conductor's prompt builder wants one. */
const participant = (id: string) => ({
  id,
  agentType: 'claude',
  name: 'confer-repo',
  status: 'idle',
  repoPath: '/tmp/confer-repo',
});

// ── The registry itself ──────────────────────────────────────────────────────

test('EVERY confer mode designates exactly one iterating build/fix step', () => {
  const wrong: string[] = [];
  for (const mode of CONFER_MODES) {
    const key = iteratingKeyFor(mode);
    if (!key) { wrong.push(`${mode}: no milestone is marked as the iterating build step`); continue; }
    // One and only one — two iterating steps would multiply the plan in ways the round
    // numbering (and the UI stepper) cannot express.
    const single = conferPlan(mode, 3).filter((s) => s.key === key).length === 3;
    if (!single) wrong.push(`${mode}: '${key}' did not expand to exactly 3 steps at buildRounds=3`);
  }
  assert.deepEqual(wrong, [], `modes without a usable iterating step:\n  ${wrong.join('\n  ')}`);
});

// ── The plan ─────────────────────────────────────────────────────────────────

test('for EVERY mode and EVERY round count, only the build step repeats — everything else stays once, in order', () => {
  const ROUNDS = [1, 2, 5, MAX_BUILD_ROUNDS];
  const wrong: string[] = [];

  for (const mode of CONFER_MODES) {
    const base = conferPlan(mode, 1);
    const iterKey = iteratingKeyFor(mode);

    for (const rounds of ROUNDS) {
      const plan = conferPlan(mode, rounds);

      const expectedLen = base.length - 1 + rounds;
      if (plan.length !== expectedLen) {
        wrong.push(`${mode} @${rounds}: plan has ${plan.length} steps, expected ${expectedLen}`);
      }

      const build = plan.filter((s) => s.key === iterKey);
      if (build.length !== rounds) {
        wrong.push(`${mode} @${rounds}: ${build.length} build steps, expected ${rounds}`);
      }
      // Rounds are numbered 1..N in order, and every build step knows the total.
      const numbering = build.map((s) => `${s.round}/${s.rounds}`).join(',');
      const expectedNumbering = Array.from({ length: rounds }, (_, i) => `${i + 1}/${rounds}`).join(',');
      if (numbering !== expectedNumbering) {
        wrong.push(`${mode} @${rounds}: round numbering ${numbering}, expected ${expectedNumbering}`);
      }
      // The build steps must be CONTIGUOUS — the panel does not review between rounds.
      const idxs = plan.map((s, i) => (s.key === iterKey ? i : -1)).filter((i) => i >= 0);
      if (idxs.some((v, i) => i > 0 && v !== idxs[i - 1] + 1)) {
        wrong.push(`${mode} @${rounds}: build rounds are not contiguous (${idxs.join(',')})`);
      }
      // Every other milestone appears exactly once and keeps its relative order.
      const others = plan.filter((s) => s.key !== iterKey).map((s) => s.key);
      const baseOthers = base.filter((s) => s.key !== iterKey).map((s) => s.key);
      if (others.join('>') !== baseOthers.join('>')) {
        wrong.push(`${mode} @${rounds}: non-build milestones changed: ${others.join('>')} vs ${baseOthers.join('>')}`);
      }
      // A multi-round build must be tellable apart in the UI stepper.
      if (rounds > 1 && new Set(build.map((s) => s.name)).size !== rounds) {
        wrong.push(`${mode} @${rounds}: build rounds share a name — the stepper cannot tell them apart`);
      }
    }
  }
  assert.deepEqual(wrong, [], `plan expansion is wrong for:\n  ${wrong.join('\n  ')}`);
});

test('an unusable round count never produces an unusable plan', () => {
  const CASES: { input: unknown; want: number }[] = [
    { input: undefined, want: 1 },
    { input: null, want: 1 },
    { input: 0, want: 1 },
    { input: -4, want: 1 },
    { input: 'abc', want: 1 },
    { input: 2.7, want: 2 },
    { input: '6', want: 6 },
    { input: 9999, want: MAX_BUILD_ROUNDS },
  ];
  const wrong = CASES
    .map((c) => (clampBuildRounds(c.input) === c.want ? null : `${JSON.stringify(c.input)} → ${clampBuildRounds(c.input)}, expected ${c.want}`))
    .filter(Boolean);
  assert.deepEqual(wrong, [], `round clamping is wrong for:\n  ${wrong.join('\n  ')}`);
});

// ── The prompt ───────────────────────────────────────────────────────────────

test('EVERY build round, in EVERY mode, demands a commit + push before it may be signalled done', () => {
  const a = agent();
  const b = agent();
  const wrong: string[] = [];

  for (const mode of CONFER_MODES) {
    const session = startConfer({
      repoName: 'confer-repo',
      repoPath: '/tmp/confer-repo',
      participantIds: [a, b],
      task: 'Fix the 20 bugs listed in docs/bugs.md',
      mode: mode as 'divide' | 'collaborate',
      buildRounds: 4,
    });
    const full = getConfer(session.id)!;
    const iterKey = iteratingKeyFor(mode);
    const steps = full.milestones || [];

    steps.forEach((ms, idx) => {
      const prompt = buildMilestonePrompt(full, idx, participant(a), [participant(b)], {});
      const isBuild = ms.key === iterKey;
      if (!isBuild) return;

      // The commit is not advice — it is the definition of a finished round.
      for (const needle of ['git add', 'git commit', 'git push']) {
        if (!prompt.includes(needle)) wrong.push(`${mode} round ${ms.round}: prompt never says \`${needle}\``);
      }
      // The agent must know WHICH round it is on and how many remain, or "next batch" is
      // meaningless and every round re-does the same three fixes.
      if (!prompt.includes(`${ms.round}`) || !prompt.includes('4')) {
        wrong.push(`${mode} round ${ms.round}: prompt does not state the round number out of 4`);
      }
      // Same branch every round — a branch per round is not an "ongoing" branch.
      if (!/same .*branch/i.test(prompt)) {
        wrong.push(`${mode} round ${ms.round}: prompt does not pin the work to one ongoing branch`);
      }
    });

    // The milestone header must count against the EXPANDED plan, not the 5-step cycle —
    // "Milestone 2/5" on a 8-milestone confer is how an agent decides it is nearly done.
    const total = steps.length;
    const header = buildMilestonePrompt(full, 0, participant(a), [participant(b)], {});
    if (!header.includes(`1/${total}`)) {
      wrong.push(`${mode}: milestone header does not count out of ${total}`);
    }
  }
  assert.deepEqual(wrong, [], `build-round prompts are missing their contract:\n  ${wrong.join('\n  ')}`);
});

// ── Persistence + advancement ────────────────────────────────────────────────

test('for EVERY mode, a confer with N build rounds persists N build milestones and walks through all of them', () => {
  const a = agent();
  const b = agent();
  const ROUNDS = 3;
  const wrong: string[] = [];

  for (const mode of CONFER_MODES) {
    const started = startConfer({
      repoName: 'confer-repo',
      repoPath: '/tmp/confer-repo',
      participantIds: [a, b],
      task: 'Fix the 20 bugs listed in docs/bugs.md',
      mode: mode as 'divide' | 'collaborate',
      buildRounds: ROUNDS,
    });
    const session = getConfer(started.id)!;
    if (session.buildRounds !== ROUNDS) {
      wrong.push(`${mode}: session stored buildRounds=${session.buildRounds}, expected ${ROUNDS}`);
    }

    const plan = conferPlan(mode, ROUNDS);
    const stored = (session.milestones || []).map((m) => `${m.key}#${m.round}`);
    const expected = plan.map((s) => `${s.key}#${s.round}`);
    if (stored.join(',') !== expected.join(',')) {
      wrong.push(`${mode}: stored milestones ${stored.join(',')} != plan ${expected.join(',')}`);
    }

    // Walk the whole confer: both participants signal each milestone in turn. The confer must
    // stop at every single one — including each build round — and only complete at the end.
    for (let i = 0; i < expected.length; i++) {
      const before = getConfer(started.id)!;
      if (before.currentMilestone !== i) {
        wrong.push(`${mode}: at step ${i} the confer sits on milestone ${before.currentMilestone}`);
        break;
      }
      recordMilestoneDone(started.id, a, `round ${i}`);
      const half = getConfer(started.id)!;
      if (half.currentMilestone !== i) {
        wrong.push(`${mode}: milestone ${i} advanced on ONE signal — the all-hands gate is gone`);
        break;
      }
      recordMilestoneDone(started.id, b, `round ${i}`);
    }

    const done = getConfer(started.id)!;
    if (done.status !== 'completed') {
      wrong.push(`${mode}: after every milestone was signalled the confer is '${done.status}', not completed`);
    }
    if ((done.milestones || []).some((m) => m.status !== 'done')) {
      wrong.push(`${mode}: some milestones never reached 'done'`);
    }
  }
  assert.deepEqual(wrong, [], `multi-round confers do not run their rounds:\n  ${wrong.join('\n  ')}`);
});

test('a confer started without a round count behaves exactly as it always did', () => {
  const a = agent();
  const b = agent();
  const started = startConfer({
    repoName: 'confer-repo',
    repoPath: '/tmp/confer-repo',
    participantIds: [a, b],
    task: 'One pass, like before',
  });
  const session = getConfer(started.id)!;
  assert.equal(session.buildRounds, 1, 'the default must stay a single build');
  assert.equal((session.milestones || []).length, conferPlan('divide', 1).length);
  // No "1/1" round suffix on a single-build confer — the old names are the ones people know.
  assert.deepEqual(
    (session.milestones || []).map((m) => m.name),
    conferPlan('divide', 1).map((s) => s.name),
  );
});
