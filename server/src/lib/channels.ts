/**
 * Channels — one notice, every configured delivery app.
 *
 * N1 of docs/plans/build-order.md. Before this, `stuck-detector.ts`,
 * `workflow-executor-v2.ts` and `routes/permissions.ts` each imported `sendPushToAll` from
 * `lib/apns-push.js` directly. That is survivable with one app and unmaintainable with two:
 * every new channel means editing every call site, and the one everybody forgets is silently
 * quiet forever.
 *
 * The interface is deliberately app-shaped-by-nobody. A `Notice` describes what a person needs
 * to know and what they can do about it; how that becomes a push payload, a Discord message
 * with buttons, or a webhook body is the adapter's problem. Nothing here may know an app
 * exists — that boundary is asserted in test/channels.test.ts over every file in src/.
 */

export interface Notice {
  title: string;
  body: string;
  /** Absolute paths on this machine. Channels that cannot carry files report them dropped. */
  attachments?: string[];
  /** Ordered, rendered as labelled lines by channels that can show them. */
  detail?: Record<string, string>;
  /** What can resolve this, e.g. approve/reject. `id` is routed by lib/commands-registry.ts. */
  actions?: { id: string; label: string; style?: string }[];
  /** Routing metadata — workflowId, stepId, type. Carried, never interpreted here. */
  data?: Record<string, unknown>;
}

/**
 * The result of one channel's attempt.
 *
 * The plan sketches `send(): Promise<boolean>` but also requires that a channel unable to carry
 * a field "says so in its return rather than pretending". A boolean cannot express that, and
 * the prose is the requirement: a missing screenshot must be a KNOWN limitation of the channel
 * rather than a mystery at the other end. So `dropped` names the fields that did not survive.
 */
export interface Delivery {
  ok: boolean;
  /** Notice fields this channel silently cannot carry. Empty is the good case. */
  dropped?: (keyof Notice)[];
  error?: string;
}

export interface Channel {
  readonly name: string;
  isConfigured(): boolean;
  send(notice: Notice): Promise<Delivery>;
}

/** What one fan-out did, in the terms a caller might log or surface. */
export interface FanoutReport {
  delivered: number;
  /** Channels that exist but are not configured. Not a failure — nothing to fix. */
  skipped: number;
  failed: number;
  dropped: { channel: string; fields: (keyof Notice)[] }[];
}

const registry: Channel[] = [];

/** Re-registering a name replaces it, so a restart cannot double-send. */
export function registerChannel(channel: Channel): void {
  const at = registry.findIndex((c) => c.name === channel.name);
  if (at >= 0) registry[at] = channel;
  else registry.push(channel);
}

export function clearChannels(): void {
  registry.length = 0;
}

export function listChannels(): readonly Channel[] {
  return [...registry];
}

/**
 * Fan one notice to every configured channel.
 *
 * NEVER THROWS, and never lets one channel's failure stop another's delivery. These fire from
 * the workflow executor and the stuck detector, where an exception would take a run down with
 * it — a notification path that can break its caller is worse than one that is quiet.
 */
export async function notifyAll(notice: Notice): Promise<FanoutReport> {
  const report: FanoutReport = { delivered: 0, skipped: 0, failed: 0, dropped: [] };

  const results = await Promise.all(registry.map(async (channel) => {
    let configured = false;
    try {
      configured = channel.isConfigured();
    } catch {
      // A channel whose own config check throws is broken, not unconfigured.
      return { channel, outcome: 'failed' as const, error: 'isConfigured threw' };
    }
    if (!configured) return { channel, outcome: 'skipped' as const };

    try {
      const delivery = await channel.send(notice);
      return { channel, outcome: delivery.ok ? ('sent' as const) : ('failed' as const), delivery };
    } catch (err) {
      return {
        channel,
        outcome: 'failed' as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  for (const r of results) {
    if (r.outcome === 'skipped') { report.skipped += 1; continue; }
    if (r.outcome === 'failed') {
      report.failed += 1;
      if ('error' in r && r.error) console.warn(`[channels] ${r.channel.name} failed: ${r.error}`);
      continue;
    }
    report.delivered += 1;
    const fields = ('delivery' in r ? r.delivery?.dropped : undefined) ?? [];
    if (fields.length) report.dropped.push({ channel: r.channel.name, fields });
  }

  return report;
}
