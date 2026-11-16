/**
 * A HELD STEP IS HANDLED THE MOMENT IT IS HELD — NOT ON THE NEXT MINUTE'S SWEEP.
 *
 * A step with manual advance finishes and holds its run for a person. The run's autonomy decides
 * what happens next: `advance` / `full` release it on their own, `manual` waits and TELLS the
 * person. Both used to happen only on the attention notifier's 60-second sweep, so a run the
 * person had explicitly allowed to advance by itself still sat for up to a minute at every held
 * step (seen as a Goal Pilot stage "stuck" on CE Phase 7's "Learn & Final Review").
 *
 * Set-based over the settable autonomy levels: each must act at once, in its own way.
 */
import './helpers/isolated-db.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { startWorkflowApp, verified } from './helpers/workflow-app.ts';
import { tickWorkflowsOnce } from '../src/lib/workflow-executor-v2.ts';
import { startAttentionNotifier, stopAttentionNotifier, __resetAttentionStateForTest } from '../src/lib/attention-notifier.ts';
import { registerChannel, clearChannels, type Notice } from '../src/lib/channels.ts';
import { SETTABLE_LEVELS, AUTO_RESOLVABLE } from '../src/lib/autonomy.ts';

const app = await startWorkflowApp('held-agent');
// A 10-minute interval: if anything happens within the test, the held-step signal did it.
startAttentionNotifier(10 * 60_000);
after(() => { stopAttentionNotifier(); app.close(); });

const notices: Notice[] = [];
clearChannels();
registerChannel({ name: 'collector', isConfigured: () => true, async send(n) { notices.push(n); return { ok: true, dropped: [] }; } });

async function until(what: string, fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}

for (const level of SETTABLE_LEVELS) {
  test(`autonomy "${level}": the held step is dealt with at once`, async () => {
    __resetAttentionStateForTest();
    notices.length = 0;
    const created = await app.post('/api/workflows/v2/create', {
      name: `Held ${level}`, skipStandardGate: true, skipReportStep: true,
      steps: [
        { id: 'a', name: `Learn ${level}`, executorConfig: { prompt: 'learn' }, autoAdvance: false },
        { id: 'b', name: `After ${level}`, dependsOn: ['a'], executorConfig: { prompt: 'then this' } },
      ],
    });
    const started = await app.post(`/api/workflows/v2/${created.json.workflow.id}/start`, { agentId: app.agent, queueIfBusy: false });
    const runId = started.json.workflow.id as string;
    db.prepare('UPDATE workflows SET autonomy = ? WHERE id = ?').run(level, runId);
    tickWorkflowsOnce();
    const held = db.prepare(`SELECT id FROM workflow_steps WHERE workflow_id = ? AND name = ?`).get(runId, `Learn ${level}`) as { id: string };
    const r = await app.post(`/api/workflows/webhook/${held.id}/complete`, verified('learned it'));
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const autoAdvance = () => (db.prepare('SELECT auto_advance FROM workflow_steps WHERE id = ?').get(held.id) as { auto_advance: number }).auto_advance;
    if (AUTO_RESOLVABLE[level].includes('manual-advance')) {
      await until(`"${level}" to release the held step`, () => autoAdvance() === 1);
      await until('the person to be told it was released', () => notices.some((n) => n.data?.type === 'workflow_auto_resolved'));
    } else {
      await until('the person to be told the run is waiting', () => notices.some((n) => n.data?.reason === 'manual-advance'));
      assert.equal(autoAdvance(), 0, 'manual must never release a hold on its own');
    }
    // Free the one cartridge for the next level's run.
    await app.post(`/api/workflows/${runId}/cancel`, {});
    db.prepare(`UPDATE workflow_steps SET status = 'skipped' WHERE workflow_id = ? AND status IN ('running', 'pending')`).run(runId);
  });
}
