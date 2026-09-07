/**
 * Native session resume, per engine.
 *
 * WHY THIS EXISTS. The recovery subsystem was designed around transcript replay and explicitly
 * ruled native resume out:
 *
 *   "D1 — Recovery mechanism: transcript replay (NeonCore-owned) ... NOT native `--resume`
 *    (that is the fragile path already failing us; it can be added later as a fidelity
 *    optimization)."   — .neoncore/docs/recovery-subsystem-plan.md
 *
 * The stated risk is real: SIGTERM can truncate a session JSONL mid-write, and a resume against
 * a torn file fails. But replay is lossy by construction — sixteen turns verbatim, 18k chars,
 * and the agent wakes up reading a summary of itself. So resume becomes the PREFERRED path and
 * replay stays the fallback: try to come back as yourself, and if the transcript will not load,
 * be handed one instead. That ordering is the whole change.
 *
 * WHY A SEPARATE ENV VAR. `NEONCORE_SESSION_ID` already travels to every launch script, and it
 * was tempting to just read it here. It carries SYNTHETIC ids on the ordinary paths —
 * `neoncore-claude-1757...`, `remote-8f3a91c2` — which are labels, not resumable sessions.
 * Reading it would turn every cold launch into `claude --resume neoncore-claude-1757...` and
 * break them all. `NEONCORE_RESUME_SESSION_ID` means one thing only: resume THIS real session.
 *
 * A NULL ENTRY IS A DECISION, NOT A GAP. `gridlight` is listed and set to null because its CLI
 * has no resume flag — not because nobody got to it. Inventing a flag opens a terminal that
 * dies on an unknown argument, which is worse than a cold start, and a missing key would let a
 * future engine fall through to claude's flags by accident.
 */

/**
 * Engine → the argv that resumes a session, or null when the CLI cannot resume.
 * Keys MUST cover every member of the `AgentType` union in server/src/types.ts; the set-based
 * test in server/test/session-resume.test.ts reads that union and fails on any type missing here.
 */
export const RESUME_ARGS = {
  // `claude --resume <id>` — stays interactive, and comes back under the SAME session id
  // rather than forking, which is what lets a recovered cartridge keep its identity in the
  // dashboard, its workflow step binding, and its transcript history.
  claude: (id) => ['--resume', id],

  // Codex resumes via a SUBCOMMAND, not a flag: `codex resume <SESSION_ID>`. Passing
  // `--resume` here would be an unknown-option exit, so the shape genuinely differs per engine
  // and this table cannot collapse into a single string.
  codex: (id) => ['resume', id],

  // The gridlight CLI has no resume of any kind. Verified: no `--resume` anywhere in its source
  // tree, and its `agent/` is a Rust inference binary rather than a resumable coding session.
  // A gridlight cartridge therefore falls back to transcript replay, which still works.
  gridlight: null,
};

/**
 * The argv to prepend for a resume, or null when no resume should be attempted.
 *
 * Null on: an empty/missing session id (the ordinary cold start — every launch path passes ''
 * when it is not recovering), an engine that cannot resume, and an engine this table has never
 * heard of. Never guesses.
 */
export function resumeArgsFor(agentType, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(RESUME_ARGS, agentType)) return null;
  const build = RESUME_ARGS[agentType];
  if (typeof build !== 'function') return null;
  return build(sessionId);
}
