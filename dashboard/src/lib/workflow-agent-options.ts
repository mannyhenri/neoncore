/**
 * WHICH CARTRIDGES A WORKFLOW MAY BE LAUNCHED ONTO — the single policy, shared by every
 * selector (WorkflowPanel's launch popup and WorkflowCanvasEditor's per-step pickers).
 *
 * Reported as "the dropdown shows a lot of projects and duplicates". Measured on the live
 * database at the time: 34 options, 24 of them offline with the oldest 7.5 days idle, and one
 * pair — "gl-dev · codex" — rendering as two visually identical rows.
 *
 * THE DEFAULT LIST IS THE LIVE CARTRIDGES — the same set the app's own header counts
 * (`agents.filter(a => a.status !== 'offline')`, App.tsx). Two surfaces answering "which
 * cartridges do I have" with 10 and 21 is the bug being fixed.
 *
 * AND THAT RE-OPENS A CLOSED ONE, SO IT IS FENCED. Filtering offline cartridges out was tried
 * and reverted on 2026-08-15 (894144d): a disconnected cartridge SILENTLY vanished, launching
 * onto it became impossible with no explanation, and it was reported as the workflow "not
 * sending". *Silently* is the load-bearing word — offline is a queueable state and the run
 * waits for the cartridge to come back. So they are absent from the default list and never
 * unreachable:
 *
 *   · `includeOffline` reveals them, behind a control that says how many there are. Missing is
 *     the bug; folded away with a count is not.
 *   · `keepIds` pins anything already assigned into the list unconditionally, whatever its
 *     state. A step pinned to a sleeping cartridge must still render its own name, or the
 *     <select> falls back to blank and the next save writes that blank back — unassigning the
 *     step silently, which is the 894144d bug wearing different clothes.
 *
 * WHY THE DUPLICATE HAPPENS AND WHAT IT IS SAFE TO DO ABOUT IT. The same checkout can register
 * more than once: `/api/agents/register` deduplicates on machine + repoPath, so a session whose
 * host reports a different name — a Codex sandbox calling itself "local" where every other
 * process on the box says "Mannys-Mac-Pro.local" — becomes a second row for the same directory.
 * An absolute path plus an engine identifies a checkout, so an offline row sitting beside a live
 * one is a stale predecessor and is dropped.
 *
 * The exception is load-bearing: two machines really can hold the same absolute path
 * (`/Users/manny/code/gl-dev` exists on both laptops). When more than one row in a group is
 * LIVE, they are two real cartridges on two disks and both survive — collapsing them would
 * silently send a run's files to the box the user did not pick. WorkflowCanvasEditor puts the
 * host in the label whenever the fleet spans more than one, which is what makes that pair
 * distinguishable once both are shown.
 */

/** Statuses that mean "this cartridge is reachable right now". */
const LIVE = new Set(['working', 'idle', 'waiting']);

/**
 * How long an OFFLINE cartridge keeps its place in the dropdown.
 *
 * A number, once, because the alternative is it being typed into two components that then
 * disagree about which cartridges exist. Three days: long enough to cover a weekend laptop and
 * anything you were working on yesterday, short enough that a week of dead checkouts does not
 * bury the handful you actually use. Nothing is deleted — these rows stay in the database and
 * on the fleet screen, they only stop being offered as a launch target.
 */
export const STALE_OPTION_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

interface AgentLike {
  dismissedAt?: string;
  status?: string;
  lastSeen?: string;
  repoPath?: string;
  agentType?: string;
}

const isLive = (a: AgentLike) => LIVE.has((a.status || '').trim().toLowerCase());

/** Milliseconds since this row last showed proof of life, or null when it has no timestamp. */
function idleFor(a: AgentLike, now: number): number | null {
  const t = Date.parse(a.lastSeen || '');
  return Number.isNaN(t) ? null : now - t;
}

/**
 * A checkout: the absolute path plus the engine running in it. Deliberately NOT keyed on the
 * machine — the whole point is to collapse the rows that disagree about what this host is
 * called. The "more than one live" exception below is what keeps genuinely different machines
 * apart.
 */
const checkoutKey = (a: AgentLike) =>
  `${(a.repoPath || '').trim().toLowerCase()}|${(a.agentType || '').trim().toLowerCase()}`;

export interface AgentOptionsOpts {
  now?: number;
  /** Reveal the offline-but-queueable cartridges. Off by default — see the header. */
  includeOffline?: boolean;
  /** Cartridges already assigned to a step. Always listed, whatever their state. */
  keepIds?: Iterable<string>;
}

export function workflowAgentOptions<T extends AgentLike & { id?: string }>(
  agents: readonly T[],
  opts: AgentOptionsOpts = {},
): T[] {
  const now = opts.now ?? Date.now();
  const pinned = new Set(opts.keepIds ?? []);
  const isPinned = (a: T) => !!a.id && pinned.has(a.id);

  const visible = agents.filter((a) => {
    // A pinned row skips every rule below it. Dropping the cartridge a step still points at is
    // strictly worse than showing a dead one.
    if (isPinned(a)) return true;
    if (a.dismissedAt) return false;
    if (isLive(a)) return true; // a live cartridge is never aged out, however quiet
    if (!opts.includeOffline) return false;
    const idle = idleFor(a, now);
    // No timestamp means a hand-inserted or pre-column row. Treating a blank as infinitely old
    // would remove it from every dropdown with nothing to explain why.
    if (idle === null) return true;
    return idle <= STALE_OPTION_DAYS * DAY_MS;
  });

  // Collapse stale predecessors, keeping source order for everything that survives.
  const groups = new Map<string, T[]>();
  for (const a of visible) {
    const k = checkoutKey(a);
    const g = groups.get(k);
    if (g) g.push(a); else groups.set(k, [a]);
  }

  const dropped = new Set<T>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const live = group.filter(isLive);
    // Two or more live rows for one path = two machines holding the same directory. Real, and
    // never collapsed.
    if (live.length > 1) continue;
    const keep = live.length === 1
      ? live[0]
      // All offline: the most recently seen one is the current row; the rest are its history.
      : group.reduce((best, a) => (idleFor(a, now) ?? Infinity) < (idleFor(best, now) ?? Infinity) ? a : best);
    // …but a row a step still points at is never collapsed into its twin, for the same reason
    // it is never aged out: the assignment has to keep rendering.
    for (const a of group) if (a !== keep && !isPinned(a)) dropped.add(a);
  }

  return visible
    .filter((a) => !dropped.has(a))
    // Live first. A dropdown that buries the ten cartridges you use under the twenty you don't
    // is the complaint, and sorting is the half of the fix that hides nothing.
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
}

/** True when this option is only queueable, not reachable — for grouping it in the UI. */
export function isOfflineOption(a: AgentLike): boolean {
  return !isLive(a);
}

/**
 * How many offline cartridges the reveal control would add.
 *
 * Derived by asking the policy itself rather than counting `status === 'offline'` by hand —
 * the aged-out and collapsed ones are not coming back, so a raw count would promise rows the
 * reveal does not deliver.
 */
export function offlineOptionCount<T extends AgentLike & { id?: string }>(
  agents: readonly T[],
  opts: AgentOptionsOpts = {},
): number {
  return workflowAgentOptions(agents, { ...opts, includeOffline: true })
    .filter(isOfflineOption).length;
}

/**
 * How a cartridge reads in a confer picker.
 *
 * ONE REPO CAN HOLD TWO CARTRIDGES. `checkoutKey` above is `repoPath|agentType` precisely so a
 * claude cartridge and a codex cartridge on the same checkout both survive the collapse — but
 * every picker rendered `{a.repoName || a.name}`, so the two arrived as two identical chips
 * and choosing between them was guesswork. Reported as "we should see also with the repo name
 * (cartridge) if it's claude or codex ... so I can pick the right instance".
 *
 * Shared rather than inlined because there are three pickers. The confer LAUNCH GATE lived in
 * three places too and was reported three separate times, each fix landing on whichever
 * surface the reporter happened to be looking at.
 */
export function conferOptionLabel(a: AgentLike & { repoName?: string; name?: string }): string {
  const repo = (a.repoName || '').trim() || (a.name || '').trim() || 'cartridge';
  const engine = (a.agentType || '').trim();
  // No engine on pre-column rows. "baseback · undefined" is worse than "baseback".
  return engine ? `${repo} · ${engine}` : repo;
}
