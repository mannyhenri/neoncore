import { Router } from 'express';
import db from '../db.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { guardBusy } from '../lib/queue-if-busy.js';
import { publicQueueItem } from '../lib/queue-runner.js';
import { resolveSender, composePeerMessage } from '../lib/peer-message.js';
import type { Command, CommandAttachmentInput } from '../types.js';
import { asyncRoute } from '../lib/async-route.js';

const router = Router();

// Send a command to an agent (from dashboard)
router.post('/send', asyncRoute(async (req, res) => {
  const { agentId, text, includeMemory, attachments, queueIfBusy, deliverNow} = req.body;

  if (!agentId || !text) {
    return res.status(400).json({ error: 'agentId and text required' });
  }

  if (attachments !== undefined && !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'attachments must be an array' });
  }
  const validAttachments = (attachments || []) as CommandAttachmentInput[];
  for (const attachment of validAttachments) {
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      typeof attachment.dataBase64 !== 'string' ||
      typeof attachment.size !== 'number'
    ) {
      return res.status(400).json({ error: 'Each attachment needs name, size, and dataBase64' });
    }
  }

  // QUEUE INSTEAD OF INTERRUPT. A cartridge works one thing at a time, so a prompt typed while
  // it is busy used to land on top of work in progress. Now it lines up behind it.
  //
  // OPT-IN, and that is load-bearing rather than cautious: this same route carries agent-to-agent
  // messages (neoncore_message_agent) between confer participants. If queueing were the default,
  // a participant's message would be parked behind the very confer it belongs to and the session
  // would never advance. User surfaces ask for it; system delivery does not.
  if (queueIfBusy === true) {
    const guard = guardBusy({
      // Everything sendCommandToAgent takes, not just the text: the item dispatches later, and
      // an attachment that was validated here and not stored is simply gone — a picture sent to
      // a busy cartridge used to arrive as text alone.
      kind: 'prompt', targets: [agentId],
      payload: { text, attachments: validAttachments, includeMemory: includeMemory !== false },
      /*
       * ADX-007 — the operator asked for "now". guardBusy honours it only where
       * every busy target has a REACHABLE inbox, so this cannot become "drop the
       * work"; a cartridge with no mid-turn road still queues.
       */
      deliverNow: deliverNow === true,
    });
    if ('error' in guard) return res.status(400).json({ error: guard.error });
    if (guard.queued) return res.status(202).json({
      queued: true,
      item: publicQueueItem(guard.item),
      // The caller must be able to tell "it ran" from "it is next", or the UI reports a
      // dispatch that has not happened yet.
      note: 'the cartridge is busy — this was added to its queue',
    });
  }

  // ANOTHER AGENT is the author (neoncore_message_agent passes who it is): deliver a peer message
  // — header, no goal brief or work standard, the recipient's objective untouched — not a task.
  // See lib/peer-message.ts, which also re-opens a confer milestone a late comment lands in.
  const sender = resolveSender(req.body || {});
  const outgoing = sender && sender.id !== agentId ? composePeerMessage(sender, agentId, text) : text;

  let command: Command | null;
  try {
    command = sender && sender.id !== agentId
      ? sendCommandToAgent(agentId, outgoing, false, validAttachments, { standard: false, trackObjective: false, deliverNow: deliverNow === true })
      : sendCommandToAgent(agentId, text, includeMemory !== false, validAttachments, { deliverNow: deliverNow === true });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  // Not registered with this server: nothing to deliver to. (Servers are not linked — a
  // cartridge registered with another server is not reachable from here.)
  if (!command) return res.status(404).json({ error: 'Agent not found' });

  res.status(201).json(command);
}));

// Mark command as delivered (called by VS Code extension)
router.post('/delivered/:id', (req, res) => {
  const now = new Date().toISOString();
  db.prepare('UPDATE commands SET status = ?, delivered_at = ? WHERE id = ?')
    .run('delivered', now, req.params.id);
  res.json({ status: 'delivered' });
});

// Get pending commands for an agent
router.get('/pending/:agentId', (req, res) => {
  const commands = db
    .prepare('SELECT * FROM commands WHERE agent_id = ? AND status = ? ORDER BY created_at ASC')
    .all(req.params.agentId, 'pending') as Command[];
  res.json(commands);
});

export default router;
