/**
 * What we PRICED against what was BILLED — and the gap is the confidence figure.
 *
 * lib/projection.ts has carried `confidence: null` since GAS-005, with a comment saying why:
 * nothing compared local pricing against billed reality, so any number there would be
 * invented. This is the measurement that earns it. Local cost comes from a rate table applied
 * to tokens we counted ourselves; Anthropic's cost report is what was actually charged. Agree
 * to within a percent and the projection resting on them deserves trust. Diverge by forty and
 * the gauge is fiction, and should say so rather than keep printing days.
 *
 * ── THIS HAS NEVER RUN ────────────────────────────────────────────────────────────────
 * The Usage & Cost API needs an Admin credential (`sk-ant-admin…`), and there is none on this
 * machine. Everything here is exercised through an injected fetch. The behaviour that matters
 * today is the absent-key path: no key, no reconciliation, confidence stays null, badge
 * unchanged. A reconciliation that cannot run must not degrade into a made-up number — which
 * is the same rule every other task in this epic follows.
 */

/** Admin credentials are a distinct prefix. A workspace key would 401, so we do not send one. */
const ADMIN_PREFIX = 'sk-ant-admin';

export interface Reconciliation {
  localUsd: number;
  reportedUsd: number;
  /** |local - reported| / reported. Direction does not matter — too high is as wrong as too low. */
  deltaPct: number;
  /** 0..1. Not chosen: it IS the agreement. */
  confidence: number;
}

export function reconcile(localUsd: number, reportedUsd: number): Reconciliation | null {
  if (![localUsd, reportedUsd].every((n) => Number.isFinite(n) && n >= 0)) return null;
  // Nothing billed means nothing to compare. Two zeroes agree trivially and prove nothing.
  if (reportedUsd <= 0) return null;

  const deltaPct = Math.abs(localUsd - reportedUsd) / reportedUsd;
  return {
    localUsd, reportedUsd, deltaPct,
    confidence: Math.max(0, Math.min(1, 1 - deltaPct)),
  };
}

/**
 * The Admin key, or null. Checked by PREFIX, not merely presence: `anthropic_api_key` holds a
 * workspace key, which this endpoint rejects — sending it would produce a 401 that looks like
 * a reconciliation failure rather than a missing credential.
 */
export function adminKeyFrom(settings: Record<string, string | undefined>): string | null {
  for (const k of ['anthropic_admin_key', 'anthropic_api_key']) {
    const v = (settings?.[k] || '').trim();
    if (v.startsWith(ADMIN_PREFIX)) return v;
  }
  return null;
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean; status?: number; json: () => Promise<unknown>;
}>;

/**
 * Billed USD for a window, or null.
 *
 * NEVER THROWS. This runs behind a badge; a rate-limited or restructured cost report must
 * degrade to "no confidence figure", not to a broken header. Amounts come back as decimal
 * strings in CENTS, per the API docs, and are summed across every bucket and result.
 */
export async function fetchReportedCostUsd(opts: {
  key: string; startIso: string; endIso: string; fetchImpl?: FetchLike;
}): Promise<number | null> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch || !opts.key) return null;

  const url = 'https://api.anthropic.com/v1/organizations/cost_report'
    + `?starting_at=${encodeURIComponent(opts.startIso)}&ending_at=${encodeURIComponent(opts.endIso)}`;
  try {
    const res = await doFetch(url, {
      headers: { 'x-api-key': opts.key, 'anthropic-version': '2023-06-01' },
    });
    if (!res?.ok) return null;
    const body = (await res.json()) as { data?: { results?: { amount?: string }[] }[] };
    if (!Array.isArray(body?.data)) return null;

    let cents = 0;
    for (const bucket of body.data) {
      for (const r of bucket?.results ?? []) {
        const n = Number(r?.amount);
        if (Number.isFinite(n)) cents += n;
      }
    }
    return cents / 100;
  } catch {
    return null;                       // a broken report is not a broken badge
  }
}
