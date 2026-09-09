/**
 * ADX-003 — POST A MESSAGE TO A CARTRIDGE'S ADDRESSED INBOX.
 *
 * Every Claude Code session binds a Unix socket at `/tmp/cc-socks/<pid>.sock` (a named pipe on
 * native Windows) and reads newline-delimited JSON from it. A message posted there is delivered
 * BETWEEN TOOL CALLS during an active turn — the running tool is never interrupted. That is the
 * property the whole epic exists for: it is how NeonCore reaches a cartridge that is already
 * mid-turn without typing into its PTY and colliding with whatever it is doing.
 *
 * ── THE RESULT IS A KIND, NOT A BOOLEAN ───────────────────────────────────────────────
 * `sendCommandToAgent` (ADX-005) will use this as one branch among several, and it has to decide
 * whether to stop or fall through to the next transport. "It didn't work" cannot drive that
 * decision: a missing socket means the session EXITED and the relay path is worth trying, while
 * an auth rejection means the peer is alive and refusing us, which retrying will not fix. So the
 * failures are named and distinguishable.
 *
 * ── WHY THE ENDPOINT IS VERIFIED AND THE PATH IS NOT TRUSTED ──────────────────────────
 * The socket is named by PID, and the OS recycles PIDs. ADX-001's spike says this outright: the
 * CLI's own client verifies the endpoint's pid and uid before writing, "since a stale socket path
 * can be re-bound by a recycled pid". A path that reads `.../4242.sock` is a claim, not a fact,
 * and writing a prompt to whatever now owns 4242 is the one failure here whose blast radius is
 * another person's session.
 *
 * ── WHY THE PAYLOAD IS BUILT BEFORE THE CONNECTION OPENS ──────────────────────────────
 * Claude Code closes a connection whose first complete line has not arrived within 30 seconds.
 * Connecting and then assembling the message spends someone else's budget on our work. The bytes
 * are ready before `net.connect` is called, so the deadline is only ever spent on transmission.
 *
 * ── WHAT `ok` DOES NOT MEAN ───────────────────────────────────────────────────────────
 * It means the bytes were written and the peer did not reject them. It is NOT proof a human saw
 * anything: ADX-001 measured that a session parked on the trust-this-folder prompt accepts a
 * connection, takes the write, and delivers nothing, with no error on either side. ADX-005 must
 * not read a silent socket as confirmation.
 */
import net from 'node:net';
import fs from 'node:fs';

/**
 * Our own write deadline. Deliberately well under the peer's 30 seconds: this covers a local
 * Unix socket write, which either completes in milliseconds or is not going to. Sitting near the
 * peer's limit would turn a dead cartridge into a 30-second stall in the dispatch path.
 */
export const INBOX_DEADLINE_MS = 5_000;

/** Where a session's inbox lives, by pid. Exported so callers do not rebuild the convention. */
export function inboxPathFor(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cc-sock-${pid}`
    : `/tmp/cc-socks/${pid}.sock`;
}

export type InboxFailureKind =
  /** No socket at that path — the session exited. The spike measured that exit removes it. */
  | 'no-socket'
  /** The path exists but nothing is listening: a stale socket left behind by a crash. */
  | 'refused'
  /** Connected, and the write did not complete inside the deadline. */
  | 'timeout'
  /** The peer rejected the credential. Unreachable on macOS today; mandatory on Windows. */
  | 'auth'
  /** The path names a pid that is not the process we meant. A recycled pid, not our cartridge. */
  | 'stale-pid';

export type InboxResult =
  | { ok: true; bytes: number }
  | { ok: false; kind: InboxFailureKind; detail: string };

export interface PostToInboxInput {
  /** The cartridge's PTY child pid, as ADX-002 reports it. */
  pid: number;
  /** The message to deliver. */
  text: string;
  /** Credential. Optional on macOS/Linux, required on Windows — pass null when unknown. */
  token?: string | null;
  /** Override the derived path. Tests use this; production should not. */
  socketPath?: string;
  /** Fail an auth handshake rather than assuming silence means acceptance. */
  requireAuth?: boolean;
  /** Override the write deadline. */
  timeoutMs?: number;
}

/**
 * Is `pid` a process we can see? `kill(pid, 0)` sends no signal — it asks the kernel whether the
 * process exists and whether we may signal it, which is exactly the "same user, still alive"
 * question. EPERM means it exists but belongs to someone else, and that is a REFUSAL, not a pass:
 * a socket owned by another user's process is precisely the case worth stopping for.
 */
function pidIsOurs(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;                       // ESRCH (gone) or EPERM (not ours) — neither is our peer
  }
}

/**
 * Deliver `text` to the session listening on `pid`'s inbox.
 *
 * Never throws: every outcome is a value, because the caller is a dispatch path that must choose
 * a next branch rather than unwind.
 */
export function postToInbox(input: PostToInboxInput): Promise<InboxResult> {
  const { pid, text, token = null, requireAuth = false } = input;
  const socketPath = input.socketPath ?? inboxPathFor(pid);
  const deadline = input.timeoutMs ?? INBOX_DEADLINE_MS;

  // ── Build every byte BEFORE connecting. The peer's 30s clock starts when we connect. ──
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: 'auth', token }));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  const payload = `${lines.join('\n')}\n`;

  // ── Verify the endpoint before we trust the filename. ──
  // A pid check on Windows named pipes is meaningless (the path carries no pid the OS honours),
  // so it applies where the convention is pid-named: the Unix socket.
  if (process.platform !== 'win32' && !pidIsOurs(pid)) {
    return Promise.resolve({
      ok: false, kind: 'stale-pid',
      detail: `pid ${pid} is not a live process owned by this user — refusing to write to ${socketPath}`,
    });
  }
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
    return Promise.resolve({
      ok: false, kind: 'no-socket',
      detail: `${socketPath} does not exist — the session has exited`,
    });
  }

  return new Promise<InboxResult>((resolve) => {
    let settled = false;
    const done = (r: InboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => done({ ok: false, kind: 'timeout', detail: `no write completion within ${deadline}ms` }),
      deadline,
    );

    const sock = net.connect(socketPath);

    sock.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT here rather than above is a race: the session exited between our check and the
      // connect. ECONNREFUSED is the stale-socket case — a path left behind with no listener.
      const kind: InboxFailureKind = err.code === 'ENOENT' ? 'no-socket' : 'refused';
      done({ ok: false, kind, detail: `${err.code ?? 'ERR'}: ${err.message}` });
    });

    // The peer speaks only to reject: a rejection is a line back, acceptance is silence.
    sock.on('data', (d) => {
      const reply = d.toString('utf8');
      if (/auth_error|unauthorized|invalid[_ ]token/i.test(reply)) {
        done({ ok: false, kind: 'auth', detail: reply.trim().slice(0, 200) });
      }
    });

    sock.on('connect', () => {
      sock.write(payload, (err) => {
        if (err) { done({ ok: false, kind: 'refused', detail: err.message }); return; }
        if (requireAuth && token) {
          // Give a rejecting peer a moment to answer before calling it delivered. Silence is
          // acceptance on every platform measured, so this only ever costs the grace period.
          setTimeout(() => done({ ok: true, bytes: Buffer.byteLength(payload) }), 120);
          return;
        }
        done({ ok: true, bytes: Buffer.byteLength(payload) });
      });
    });
  });
}
