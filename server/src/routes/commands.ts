import { Router } from 'express';
import db from '../db.js';
import { sendCommandToAgent } from '../lib/send-command.js';
import { forwardMessageToOwner } from '../lib/peer-forward.js';
import { guardBusy } from '../lib/queue-if-busy.js';
import type { Command, CommandAttachmentInput } from '../types.js';

const router = Router();

// Send a command to an agent (from dashboard)
router.post('/send', async (req, res) => {
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
  // OPT-IN, and that is load-bearing rather than cautious: this same route carries in-flight
  // confer traffic to participants on OTHER machines (peer-forward.ts posts here). If queueing
  // were the default, a milestone dispatch to a remote participant would be parked behind the
  // very confer it belongs to and the session would never advance. User surfaces ask for it;
  // system delivery does not.
  if (queueIfBusy === true) {
    const guard = guardBusy({
      kind: 'prompt', targets: [agentId], payload: { text },
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
      item: guard.item,
      // The caller must be able to tell "it ran" from "it is next", or the UI reports a
      // dispatch that has not happened yet.
      note: 'the cartridge is busy — this was added to its queue',
    });
  }

  let command: Command | null;
  try {
    command = sendCommandToAgent(agentId, text, includeMemory !== false, validAttachments, { deliverNow: deliverNow === true });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  // Not ours — ask the fleet. A cartridge registers with exactly ONE server, so an agent
  // missing here is routinely alive on a peer; before this, that was simply a 404 and any
  // cross-machine coordination (a confer, an agent messaging its peer) died right here.
  if (!command) {
    const forwarded = await forwardMessageToOwner(agentId, text);
    if (forwarded.ok) {
      return res.status(201).json({ forwardedTo: forwarded.origin, delivered: true });
    }
    return res.status(404).json({ error: `Agent not found locally; ${forwarded.reason}` });
  }

  res.status(201).json(command);
});

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
