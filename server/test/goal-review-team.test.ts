/**
 * THE INDEPENDENT REVIEW OF A GOAL THAT HAD A CONFER IN IT.
 *
 * Found by the sandbox's goal-with-a-Confer scenario (npm run sandbox:goal-confer): the checklist
 * reviewer of that goal was the diner-menu-api cartridge — a Confer PARTICIPANT, so it had done
 * half the work — reported as independent, and it judged `docs/<slug>/DELIVERED.md` in its own
 * repo, where nothing was ever written, so a met criterion was reported not met.
 *
 * Two causes, both asserted here:
 *   1. pickReviewer counted only a stage's `agent_id` as the worker. A Confer stage records its
 *      FIRST cartridge there; every other participant looked like a bystander.
 *   2. The review prompt never said WHERE the work is. The criteria's paths and the locked tests
 *      are relative to the contract's repo, and the reviewer may be in another one.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { pickReviewer } from '../src/lib/acceptance-runner.ts';
import { createContract, getContract } from '../src/lib/acceptance-contract.ts';
import { getPilot } from '../src/lib/goal-pilot.ts';
import { buildReviewPrompt } from '../src/lib/goal-pilot-prompts.ts';

const io = installStubIO();
const iso = () => new Date().toISOString();
let n = 0;

const LEDGER = '/tmp/review-team-ledger';
const MENU = '/tmp/review-team-menu';

function cartridge(repo: string, type: string): string {
  const id = `rt-${++n}`;
  db.prepare(`INSERT INTO agents (id, name, machine, repo_path, repo_name, status, last_seen, session_id, agent_type)
              VALUES (?, ?, 'box', ?, ?, 'idle', ?, ?, ?)`).run(id, id, repo, repo.split('/').pop(), iso(), `s-${id}`, type);
  io.connect(id);
  return id;
}

/** A running pilot whose only workflow stage was a Confer worked by the ledger AND the menu API. */
function pilotWithConferStage(ledgerAgent: string): string {
  const goalId = `rt-goal-${++n}`, pilotId = `rt-pilot-${n}`;
  db.prepare(`INSERT INTO goals (id, name, description, success_metric, status, created_at, updated_at) VALUES (?, 'Refunds', '', '', 'active', ?, ?)`).run(goalId, iso(), iso());
  db.prepare(`INSERT INTO goal_pilots (id, goal_id, phase, plan, staffing, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?)`)
    .run(pilotId, goalId, JSON.stringify({ brief: { slug: 'refunds', summary: 'Refunds end to end.' }, stages: [], criteria: [] }),
      JSON.stringify({ repos: [{ repoPath: LEDGER, agentType: 'claude' }, { repoPath: MENU, agentType: 'claude' }] }), iso(), iso());
  db.prepare(`INSERT INTO goal_pilot_stages (id, pilot_id, position, kind, template_name, repo_path, agent_type, agent_id, status, participants)
              VALUES (?, ?, 0, 'workflow', 'Confer', ?, 'claude', ?, 'completed', ?)`)
    .run(`rt-stage-${n}`, pilotId, LEDGER, ledgerAgent,
      JSON.stringify([{ repoPath: LEDGER, agentType: 'claude' }, { repoPath: MENU, agentType: 'claude' }]));
  createContract({ pilotId, goalId, repoPath: LEDGER, agentType: 'claude',
    criteria: [{ id: 'AC-1', text: 'The delivery note lists what was done.', expect: 'docs/refunds/DELIVERED.md lists it', verify: 'checklist' }] });
  return pilotId;
}

test('a Confer participant is never the "independent" reviewer — it did the work', () => {
  db.prepare(`UPDATE agents SET status = 'offline'`).run();
  const ledgerClaude = cartridge(LEDGER, 'claude');
  const menuClaude = cartridge(MENU, 'claude');
  const pilotId = pilotWithConferStage(ledgerClaude);

  // Only the two participants are live: whoever reviews did the work, and the review says so.
  const r = pickReviewer(getPilot(pilotId)!)!;
  assert.equal(r.independent, false, `${r.agentId === menuClaude ? 'the menu API participant' : 'a participant'} was reported as independent`);

  // A cartridge that did no work, of another engine, in the goal's repos: that one reviews.
  const menuCodex = cartridge(MENU, 'codex');
  assert.deepEqual(pickReviewer(getPilot(pilotId)!), { agentId: menuCodex, independent: true });
});

test('the review prompt says WHERE the work and the locked tests are', () => {
  const ledgerClaude = cartridge(LEDGER, 'claude');
  const pilotId = pilotWithConferStage(ledgerClaude);
  const prompt = buildReviewPrompt(getPilot(pilotId)!, getContract(pilotId)!, 'req-1', []);
  assert.match(prompt, new RegExp(`WHERE TO LOOK: ${LEDGER}`), 'a reviewer in another repo is not told where to look');
  assert.match(prompt, /"repoPath":\s*"\/tmp\/review-team-ledger"/, 'the machine-read data block does not carry the repo');
});
