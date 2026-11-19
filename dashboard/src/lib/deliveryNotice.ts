/**
 * What the cartridge card says when a prompt reached NO session.
 *
 * Asked for (2026-11-18), after three prompts in a row sat "pending, no-channel" while the card
 * looked like it had sent them: a session started as plain `claude` (not under the NeonCore relay)
 * has no inbox, so the server stores the prompt and nothing ever reads it. The server already says
 * so (`transport: 'no-channel'`, routes/commands.ts → lib/send-command.ts); the card used to throw
 * that answer away. Now it shows it, with the one command that fixes it.
 */
import type { Agent } from '../types';

/** The part of the server's answer to a send that the card needs. */
export interface SendOutcome {
  delivered?: boolean;
  transport?: string;
  queued?: boolean;
}

export interface UndeliveredNotice {
  agentId: string;
  /** "neoncore · claude" */
  who: string;
  /** The command that relaunches the same conversation under the relay, when we can name it. */
  relaunch: string | null;
}

/** Was the prompt stored with no session listening? A queued prompt is not this: it runs later. */
export function isUndelivered(o: SendOutcome | null | undefined): boolean {
  if (!o || o.queued) return false;
  return o.transport === 'no-channel';
}

export function undeliveredNotice(
  agent: Pick<Agent, 'id' | 'repoName' | 'name' | 'agentType' | 'sessionId' | 'repoPath'>,
  o: SendOutcome | null | undefined,
): UndeliveredNotice | null {
  if (!isUndelivered(o)) return null;
  const cd = agent.repoPath ? `cd ${agent.repoPath} && ` : '';
  // The relay ships in the neoncore repo; agents/relay is found relative to the NeonCore install.
  const relaunch = agent.sessionId
    ? `${cd}node ~/.neoncore/relay/index.js -- --resume ${agent.sessionId}`
    : null;
  return { agentId: agent.id, who: `${agent.repoName || agent.name} · ${agent.agentType}`, relaunch };
}
