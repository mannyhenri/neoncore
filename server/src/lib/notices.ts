/**
 * Notices NeonCore raises about its own work, phrased once for every channel.
 *
 * `notifyWorkflowFinished` used to live in lib/apns-push.ts. Nothing about "a workflow run
 * reached a terminal state" is specific to Apple push — it ended up there because push was the
 * only channel, which is precisely the coupling N1 exists to undo. Left where it was, a Discord
 * operator would never learn that a run had finished.
 *
 * This module builds Notices. It does not know which channels exist.
 */
import db from '../db.js';
import { notifyAll } from './channels.js';

/**
 * A workflow run reached a terminal state. `finalStatus` is 'completed' | 'failed'.
 */
export async function notifyWorkflowFinished(workflowId: string, finalStatus: string): Promise<void> {
  const row = db.prepare('SELECT name, run_number FROM workflows WHERE id = ?')
    .get(workflowId) as { name: string; run_number: number } | undefined;
  if (!row) return;

  const label = `${row.name}${row.run_number ? ` #${row.run_number}` : ''}`;
  const failed = finalStatus === 'failed';

  await notifyAll({
    title: failed ? 'Workflow failed' : 'Workflow complete',
    body: failed ? `${label} failed.` : `${label} finished.`,
    data: { type: 'workflow_finished', workflowId, status: finalStatus },
  });
}
