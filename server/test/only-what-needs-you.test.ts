// FIRST import — this file reaches db.ts through the notifier. See helpers/isolated-db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.ts';
import { installStubIO } from './helpers/stub-io.ts';
import { ATTENTION_REASONS, PERSON_REASONS, REASONS, type Attention } from '../src/lib/workflow-attention.ts';
import { attentionNotice, sweepAttention, __resetAttentionStateForTest } from '../src/lib/attention-notifier.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';
import { createFeature } from '../src/routes/goals.ts';
import { createPilotRow } from '../src/lib/goal-pilot.ts';

/**
 * ONLY WHAT NEEDS YOU, HOLDS YOU — AND ALL OF IT REACHES YOU.
 *
 * REQUESTED: "there are warnings sometimes that don't require my involvement but also sometimes
 * where I need to be notified to act on something and have no warnings." And, of Beam's review
 * gate — "Triage complete. How do you want to proceed?" after a triage that found 0 P1, 0 P2,
 * 0 P3 — "these are the kind of processes that need to be removed if it holds anything without
 * needing my involvement."
 *
 * THE SETS:
 *   ATTENTION_REASONS — each says whether only a PERSON can clear it. Those notices interrupt
 *     (urgency action, "needs you"); the rest — what NeonCore handles itself, a quiet cartridge it
 *     nudges, a budget or grant running low — are information, never "needs you".
 *   A feature's run (a Goal Pilot stage) × involvement — on anything but hands-on, a template's
 *     decision gate that names a recommendation is taken without you (and said, quietly, with an
 *     override); hands-on, or a gate with no recommendation, holds and asks you.
 */
installStubIO();
const seen: Notice[] = [];
clearChannels();
registerChannel({ name: 'collector', isConfigured: () => true, async send(n) { seen.push(n); return { ok: true, dropped: [] }; } });

test('every attention reason says whether only a person can clear it', () => {
  assert.deepEqual(REASONS.map((r) => r.name).sort(), [...ATTENTION_REASONS].sort());
  for (const r of REASONS) assert.equal(typeof r.person, 'boolean', `${r.name} does not say whether it needs a person`);
  for (const must of ['failed', 'interrupted', 'decision', 'tasks-outstanding', 'blocked-on-person', 'agent-waiting', 'manual-advance', 'channel-lost']) {
    assert.ok(PERSON_REASONS.includes(must as Attention['reason']), `${must} needs a person`);
  }
  for (const not of ['agent-idle', 'agent-silent', 'budget-exhaustion', 'autonomy-expiring']) {
    assert.ok(!PERSON_REASONS.includes(not as Attention['reason']), `${not} is NeonCore's to handle, not yours`);
  }
});

test('every reason: a notice interrupts you ("needs you", action) exactly when only a person can clear it', () => {
  for (const reason of ATTENTION_REASONS) {
    const n = attentionNotice({ id: 'wf1', name: 'CE: Review', run_number: 1 }, { reason, stepId: 's1', stepName: 'Step', detail: 'd' });
    const person = PERSON_REASONS.includes(reason);
    assert.equal(n.urgency, person ? 'action' : 'info', reason);
    assert.equal(/needs you/.test(n.title), person, `${reason}: "${n.title}"`);
  }
});

// ── a feature's run × involvement ────────────────────────────────────────────

const ISO = new Date().toISOString();
let k = 0;
function featureDecision(involvement: string | null, recommendation: string | null): { stepId: string } {
  const id = ++k;
  db.prepare("UPDATE workflows SET status = 'cancelled' WHERE status = 'running'").run();
  db.prepare(`INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at) VALUES (?, NULL, ?, '', '/tmp/r', '#fff', ?, ?)`).run(`p${id}`, `P${id}`, ISO, ISO);
  const goalId = createFeature({ projectId: `p${id}`, name: `F${id}` });
  if (involvement) {
    const pilot = createPilotRow({ goalId, plannerAgentId: '', intake: { goal: 'x', involvement } });
    db.prepare("UPDATE goal_pilots SET phase = 'running' WHERE id = ?").run(pilot.id);
  }
  const autonomy = involvement === 'hands-on' ? 'manual' : 'advance';
  db.prepare(`INSERT INTO workflows (id, name, description, status, created_at, run_number, goal_id, autonomy) VALUES (?, 'CE: Phase 4 — Review', '', 'running', ?, 1, ?, ?)`).run(`wf${id}`, ISO, goalId, autonomy);
  const cfg = { question: 'Triage complete. How do you want to proceed?', options: [{ id: 'fix-p1s', label: 'Fix P1s, then proceed' }, { id: 'proceed-as-is', label: 'Accept risk and proceed' }], ...(recommendation ? { recommendation } : {}) };
  db.prepare(`INSERT INTO workflow_steps (id, workflow_id, name, status, executor_type, executor_id, executor_config, auto_advance, position_y, created_at)
              VALUES (?, ?, 'Review Decision', 'running', 'decision', '', ?, 1, 0, ?)`).run(`s${id}`, `wf${id}`, JSON.stringify(cfg), ISO);
  return { stepId: `s${id}` };
}
const statusOf = (stepId: string) => (db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(stepId) as { status: string }).status;

const CASES = [
  { name: 'balanced feature, gate with a recommendation', involvement: 'balanced', rec: 'fix-p1s', decided: true },
  { name: 'hands-off feature, gate with a recommendation', involvement: 'hands-off', rec: 'fix-p1s', decided: true },
  { name: 'hands-on feature, gate with a recommendation', involvement: 'hands-on', rec: 'fix-p1s', decided: false },
  { name: 'balanced feature, gate with NO recommendation', involvement: 'balanced', rec: null, decided: false },
  { name: 'a run that is no feature\'s, at advance', involvement: null, rec: 'fix-p1s', decided: false },
];
for (const c of CASES) {
  test(`decision gate × ${c.name}: ${c.decided ? 'taken without you, said quietly' : 'holds and asks you'}`, async () => {
    __resetAttentionStateForTest();
    seen.length = 0;
    const { stepId } = featureDecision(c.involvement, c.rec);
    await sweepAttention();
    assert.equal(seen.length, 1, JSON.stringify(seen.map((n) => n.title)));
    if (c.decided) {
      assert.notEqual(statusOf(stepId), 'running', 'the gate still holds');
      assert.equal(seen[0].urgency, 'info', 'an automatic choice is information, not a request');
      assert.match(seen[0].body, /Fix P1s, then proceed/);
      assert.ok(seen[0].actions?.some((a) => /override/i.test(a.label)), 'it can be taken back');
    } else {
      assert.equal(statusOf(stepId), 'running');
      assert.equal(seen[0].urgency, 'action');
      assert.match(seen[0].title, /needs you/);
    }
  });
}
