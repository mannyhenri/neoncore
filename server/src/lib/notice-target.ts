/**
 * Which cartridge a notice is ABOUT.
 *
 * Inbound routing made a channel an address; outbound was still single-channel, so you could
 * talk to a cartridge in its own channel and have every reply arrive somewhere else. A
 * half-built conversation is worse than no routing at all — you cannot tell a missing answer
 * from one that went to the wrong room.
 *
 * RESOLVED HERE, ONCE, FROM WHAT THE NOTICES ALREADY CARRY. Every `notifyAll` call site already
 * puts `agentId` or `workflowId` in `data` as routing metadata; threading a `target` through
 * eight call sites would be eight chances to forget one, and the one forgotten is the notice
 * that goes to the wrong place. So nothing above this changes.
 *
 * This says WHICH CARTRIDGE, never which channel — a channel is a Discord idea and lives in
 * that driver's config. NeonCore names the thing; the driver decides where its own rooms are.
 */

import db from '../db.js';

/** How a notice can identify its cartridge, in the order we trust them. */
export const TARGET_SOURCES = ['agentId', 'workflowId', 'target'] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];

export interface TargetResolution {
  target?: string;
  /** Which field answered. Null when nothing could. */
  via: TargetSource | null;
}

function repoNameOfAgent(agentId: string): string | undefined {
  try {
    const row = db.prepare('SELECT repo_name, name FROM agents WHERE id = ?').get(agentId) as
      { repo_name?: string; name?: string } | undefined;
    return row?.repo_name || row?.name || undefined;
  } catch { return undefined; }
}

/**
 * A workflow names the repos it runs against. One repo is an unambiguous address; several is
 * not, and guessing at the first would send a run's notices to whichever repo happened to be
 * listed first — wrong in a way nobody would notice.
 */
function repoNameOfWorkflow(workflowId: string): string | undefined {
  try {
    const row = db.prepare('SELECT target_repos FROM workflows WHERE id = ?').get(workflowId) as
      { target_repos?: string } | undefined;
    if (!row?.target_repos) return undefined;
    let repos: unknown = row.target_repos;
    try { repos = JSON.parse(String(repos)); } catch { /* a bare string is one repo */ }
    const list = Array.isArray(repos) ? repos : [repos];
    const names = list.map((r) => String(r || '').trim()).filter(Boolean);
    if (names.length !== 1) return undefined;
    // Stored as a path or a name; a channel map is written against the name.
    return names[0].split('/').filter(Boolean).pop();
  } catch { return undefined; }
}

/**
 * Resolve, and SAY HOW. `via` is what makes a mis-routed notice diagnosable: "it went to the
 * main channel" and "it went to the main channel because nothing in it named a cartridge" are
 * different problems, and only the second is a bug in the caller.
 */
export function targetForNotice(data: Record<string, unknown> | undefined): TargetResolution {
  const d = data || {};

  // An explicit target wins: a caller that knows better than this resolver should be able to say so.
  const explicit = typeof d.target === 'string' ? d.target.trim() : '';
  if (explicit) return { target: explicit, via: 'target' };

  const agentId = typeof d.agentId === 'string' ? d.agentId : '';
  if (agentId) {
    const name = repoNameOfAgent(agentId);
    if (name) return { target: name, via: 'agentId' };
  }

  const workflowId = typeof d.workflowId === 'string' ? d.workflowId : '';
  if (workflowId) {
    const name = repoNameOfWorkflow(workflowId);
    if (name) return { target: name, via: 'workflowId' };
  }

  return { via: null };
}
