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

// ─────────────────────────────────────────────────────────────────────────────
// Transcript verification — the relay's veto on a resume it cannot honour.
//
// The server PROPOSES a session id: it reads the last one the hooks reported for that
// machine+repo. It cannot check whether the file is still there, because on a fleet the repo
// lives on someone else's disk. The relay runs ON that disk, so it gets the veto. Without it,
// resuming a session whose transcript was deleted or rotated exits the CLI with an
// unknown-session error and leaves a dead terminal — strictly worse than the cold start it
// replaced, and the exact failure that made D1 distrust `--resume` in the first place.
// ─────────────────────────────────────────────────────────────────────────────

import fsSync from 'fs';
import osSync from 'os';
import pathSync from 'path';

/**
 * Claude Code keys its transcript directory on the session's CWD with every non-alphanumeric
 * character replaced by `-`. Verified against real directories: `/Users/me/code/gl-dev` →
 * `-Users-me-code-gl-dev`, and `/private/var/.../13mc78td1z79w_n2508x35zw0000gn/T` →
 * `-private-var-...-13mc78td1z79w-n2508x35zw0000gn-T` (note the `_` folded to `-` too).
 */
function claudeTranscript(cwd, sessionId, homeDir) {
  const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const direct = pathSync.join(homeDir, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  if (fsSync.existsSync(direct)) return direct;

  // Fallback scan. The encoding above is inferred from observed directories rather than
  // documented, so a path shape it gets wrong must not read as "the session is gone" — that
  // would silently downgrade a perfectly resumable session to a cold start.
  const root = pathSync.join(homeDir, '.claude', 'projects');
  try {
    for (const dir of fsSync.readdirSync(root)) {
      const candidate = pathSync.join(root, dir, `${sessionId}.jsonl`);
      if (fsSync.existsSync(candidate)) return candidate;
    }
  } catch { /* no projects dir — nothing to find */ }
  return null;
}

/**
 * Engine → how to find a session's transcript on this disk, or null when the layout is not
 * modelled. Null means "cannot verify", which means "do not AUTO-resume" — an explicit resume
 * a person asked for is still honoured, because that is them saying they know it exists.
 */
export const TRANSCRIPT_LOCATORS = {
  claude: claudeTranscript,
  // Codex stores sessions under ~/.codex, but its on-disk layout is not modelled here and
  // guessing a path that silently never matches would downgrade every codex resume to cold
  // while looking like it worked. Explicit resume still passes through.
  codex: null,
  // No resume at all, so nothing to locate. See RESUME_ARGS above.
  gridlight: null,
};

/** True only when this engine's transcript for `sessionId` is confirmed present on this disk. */
export function transcriptExists(agentType, cwd, sessionId, homeDir = osSync.homedir()) {
  if (!sessionId || !cwd) return false;
  const locate = TRANSCRIPT_LOCATORS[agentType];
  if (typeof locate !== 'function') return false;
  return Boolean(locate(cwd, sessionId, homeDir));
}

/**
 * Can this engine's transcripts be located at all?
 *
 * The veto must only apply where verification is POSSIBLE. Treating "no locator" as "not found"
 * would block every codex resume forever while looking like a considered safety decision.
 */
export function canVerifyTranscript(agentType) {
  return typeof TRANSCRIPT_LOCATORS[agentType] === 'function';
}
