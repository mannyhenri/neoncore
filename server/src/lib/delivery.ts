/**
 * THE ONE RULE FOR "DID THIS DISPATCH GO NOWHERE?"
 *
 * `delivered: false` means two different things. With transport `no-channel`, nothing was
 * listening. With transport `inbox-socket`, the command was handed to the cartridge's addressed
 * inbox and the result is not known yet (ADX-005): `sendCommandToAgent` is synchronous and the
 * post is not. Every caller used to read both as "nothing listening". So a workflow step
 * dispatched to a cartridge that had just been relaunched, whose relay was not up yet, failed
 * in 4ms while its inbox was still delivering the prompt (run 81). The inbox branch exists to
 * rescue exactly those dispatches.
 *
 * Dependency-free on purpose: the MCP server is a separate stdio process and reads the same
 * fields off JSON, so it must not pull in the database to apply this rule.
 */
export interface DeliveryLike {
  delivered?: boolean;
  transport?: string;
}

/** True only when nothing could carry the command. An inbox hand-off still in flight is not this. */
export function noChannel(cmd: DeliveryLike | null | undefined): boolean {
  return !cmd || (cmd.delivered === false && cmd.transport !== 'inbox-socket');
}

/** Handed to the inbox, result pending. Await `whenInboxSettles(id)` to learn the result. */
export function inboxPending(cmd: DeliveryLike | null | undefined): boolean {
  return !!cmd && cmd.delivered === false && cmd.transport === 'inbox-socket';
}
