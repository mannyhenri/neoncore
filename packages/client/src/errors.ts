/**
 * Typed error taxonomy for the API client.
 *
 * Every failure used to arrive as a bare `Error` with whatever string the server sent, so
 * the UI could only ever render "something went wrong". With several servers in the grid
 * that is actively misleading: a 401 from a mis-tokened server and a genuinely asleep
 * laptop look identical, and both get shown as "unreachable". You then go debugging the
 * network for what is really a one-line token fix.
 *
 * The kinds are chosen for the DECISIONS a caller makes, not for HTTP taxonomy:
 *   unreachable  → show last-known-good, keep polling, disable writes
 *   auth         → stop retrying; a human must fix the token
 *   notFound     → this server is running an older build without the endpoint (D8)
 *   server       → the peer is up but unhealthy; retry is reasonable
 *   bad          → our request was wrong; retrying unchanged will not help
 */

export type ApiErrorKind = 'unreachable' | 'auth' | 'notFound' | 'server' | 'bad';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Which server produced this. Empty for the same-origin local server. */
  readonly origin: string;

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number | null; origin?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.origin = opts.origin ?? '';
  }

  /** True when the fault is the server's or the network's, not the request's. */
  get isTransient(): boolean {
    return this.kind === 'unreachable' || this.kind === 'server';
  }

  /**
   * True when a human has to intervene before this can possibly succeed. Retrying an auth
   * failure forever is how a mis-tokened server hides as a flaky one.
   */
  get needsOperator(): boolean {
    return this.kind === 'auth';
  }
}

export function classifyStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'server';
  return 'bad';
}

/**
 * A thrown value from `fetch` means the request never got an HTTP reply at all — DNS
 * failure, connection refused, TLS rejection, an aborted timeout. All of it is
 * "unreachable" from the caller's point of view.
 */
export function asUnreachable(err: unknown, origin: string): ApiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ApiError('unreachable', detail, { origin });
}
