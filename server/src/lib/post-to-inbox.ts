/**
 * Write one message into a cartridge's addressed inbox socket.
 *
 * Claude Code binds a per-session socket named by its own pid, and a message
 * posted there is delivered BETWEEN TOOL CALLS during an active turn — the
 * running tool is never interrupted. That is the capability this epic exists to
 * reach: dispatch to a cartridge that is already busy, without waiting for it and
 * without typing into its terminal.
 *
 * WHAT THIS MODULE CANNOT TELL YOU, and the reason `ok` is called `handedOver`.
 * ADX-001 measured a real session parked on the trust-this-folder prompt: it
 * accepts the connection, accepts the bytes, and does nothing with them —
 * silently, on both sides. A clean write is therefore evidence that the socket
 * took the bytes and NOT evidence that the cartridge acted on them. Naming the
 * field `delivered` would licence the caller to mark a command row delivered on
 * the strength of a socket that swallowed it.
 *
 * WHY FAILURES ARE NAMED KINDS RATHER THAN THROWN ERRORS. The caller is a
 * delivery branch, and a branch has to decide what to do next: a missing socket
 * means fall through to the relay websocket; a timeout means the cartridge is
 * wedged and the row should stay pending; a bad pid means the agent row is stale
 * and wants re-registering. A string message cannot carry those decisions.
 *
 * THE AUTH LINE IS SENT WHENEVER WE HAVE A TOKEN, on every platform. ADX-001
 * proved macOS ignores it — the 0600 socket and uid ownership are the
 * authentication there — while Windows named pipes REQUIRE it. Sending it
 * unconditionally is what keeps this from being a macOS-only interface.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/** How Claude Code names the per-session socket on POSIX. Verified by ADX-001. */
const POSIX_SOCKET_DIR = '/tmp/cc-socks';

/**
 * The Windows named-pipe form.
 *
 * STATED AS AN ASSUMPTION rather than presented as measured: ADX-001 was run on
 * macOS, and the pipe name could not be recovered from the CLI bundle. It follows
 * the ordinary `\\.\pipe\<name>` convention and MUST be confirmed against a real
 * Windows session before Windows support is claimed anywhere. A wrong name here
 * surfaces as `no-socket`, which reads as "that session is gone" — so the failure
 * would be quiet and misattributed, which is exactly why it is written down.
 */
const WIN32_PIPE_PREFIX = '\\\\.\\pipe\\cc-sock-';

/** Claude Code closes a connection that has not sent a complete line in 30s. */
export const INBOX_DEADLINE_MS = 30_000;

export type InboxFailure =
  | 'bad-pid'            // the pid could never name a socket — refused before any I/O
  | 'no-socket'          // nothing at that path: the session is gone
  | 'refused'            // a stale socket file with nothing listening behind it
  | 'not-owned'          // the socket belongs to another user
  | 'timeout'            // connected, but no complete line inside the budget
  | 'auth-rejected'      // the peer hung up after our auth line
  | 'write-failed';      // the peer hung up mid-write, with no auth line in play

export type InboxResult =
  | { ok: true; handedOver: true; bytes: number }
  | { ok: false; failure: InboxFailure; detail: string };

export interface PostToInboxOptions {
  pid: number;
  text: string;
  token?: string;
  /** Overridable so tests can point at a fake server rather than a live cartridge. */
  socketPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Where a session's inbox lives, per platform. */
export function inboxSocketPath(pid: number, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `${WIN32_PIPE_PREFIX}${pid}`;
  return path.join(POSIX_SOCKET_DIR, `${pid}.sock`);
}

/**
 * Is this socket ours to write to?
 *
 * Writing to a socket owned by another user is speaking as their session. Pure
 * so it can be exercised without a second uid on the machine — a security check
 * skipped because the fixture is awkward is a security check that ships
 * unexercised. `undefined` ourUid means a platform with no uid concept, where
 * this rule simply does not apply.
 */
export function ownershipProblem(
  stat: { uid: number },
  ourUid: number | undefined,
): 'not-owned' | null {
  if (ourUid === undefined) return null;
  return stat.uid === ourUid ? null : 'not-owned';
}

/** One newline-terminated JSON line per protocol message. */
function buildPayload(text: string, token?: string): string {
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: 'auth', token }));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  return lines.join('\n') + '\n';
}

export function postToInbox(opts: PostToInboxOptions): Promise<InboxResult> {
  const { pid, text, token, timeoutMs = INBOX_DEADLINE_MS, platform = process.platform } = opts;
  const fail = (failure: InboxFailure, detail: string): InboxResult => ({ ok: false, failure, detail });

  /*
   * A pid NAMES A PATH. A 0, a negative or a fraction builds a path that is not a
   * cartridge — /tmp/cc-socks/0.sock either does not exist or belongs to
   * something else entirely. Refused here, before any I/O, so a caller's bug
   * never reaches the filesystem.
   */
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(fail('bad-pid', `pid ${JSON.stringify(pid)} cannot name an inbox socket`));
  }

  const sock = opts.socketPath ?? inboxSocketPath(pid, platform);

  /*
   * EVERYTHING THAT CAN BE DONE BEFORE CONNECTING IS DONE BEFORE CONNECTING.
   * The 30s deadline starts when the connection opens, so serialising the
   * payload, checking the path and checking ownership afterwards would spend the
   * cartridge's budget on our own bookkeeping.
   */
  const payload = buildPayload(text, token);
  const bytes = Buffer.byteLength(payload);

  let st: fs.Stats;
  try {
    st = fs.statSync(sock);
  } catch {
    return Promise.resolve(fail('no-socket', `no inbox at ${sock} — the session is gone`));
  }
  const owner = ownershipProblem({ uid: st.uid }, process.getuid?.());
  if (owner) {
    return Promise.resolve(fail(owner, `${sock} is owned by uid ${st.uid}, not by us`));
  }

  return new Promise<InboxResult>((resolve) => {
    let settled = false;
    let wroteAll = false;

    /*
     * A failure DESTROYS; a success does not. Tearing the socket down at the
     * moment the last byte is queued drops it — the first version of this
     * resolved straight out of the write callback and the peer received nothing
     * at all, which looked like a clean hand-over from our side and like silence
     * from theirs. Success is reported when the peer has actually closed.
     */
    const settle = (r: InboxResult, destroy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroy) { try { c.destroy(); } catch { /* already gone */ } }
      resolve(r);
    };
    const fell = (failure: InboxFailure, detail: string) => settle(fail(failure, detail), true);

    const timer = setTimeout(
      () => fell('timeout', `no complete line written to ${sock} within ${timeoutMs}ms`),
      timeoutMs,
    );

    const c = net.createConnection(sock);

    c.on('connect', () => {
      c.write(payload, (err) => {
        if (err) return;              // classified by the error/close handlers below
        wroteAll = true;
        /*
         * Half-close: the peer is entitled to finish reading what we sent, and
         * the CLI's own client does the same on macOS.
         */
        c.end();
      });
    });

    c.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTSOCK' || err.code === 'ENOENT') {
        return fell('refused', `${sock} exists but nothing is listening (${err.code})`);
      }
      /*
       * A peer that hangs up mid-write is the ONE ambiguous case, and the auth
       * line is what disambiguates it. Windows named pipes reject a bad token by
       * closing; macOS never does — ADX-001 posted a wrong token and it was
       * delivered anyway — so on macOS this can only mean the transport broke.
       */
      fell(token ? 'auth-rejected' : 'write-failed',
        `peer closed before the message was written (${err.code ?? err.message})`);
    });

    c.on('close', () => {
      if (settled) return;
      if (wroteAll) return settle({ ok: true, handedOver: true, bytes }, false);
      fell(token ? 'auth-rejected' : 'write-failed',
        'peer closed the connection before the message was written');
    });
  });
}
