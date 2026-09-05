/**
 * A channel is an address.
 *
 * Post in the film channel and it drives the film cartridge; post in the main one and it drives
 * the orchestrator. No prefix to type, and it reads like talking to the app rather than
 * commanding a bot about it.
 *
 * NEONCORE NEVER LEARNS WHAT A TARGET IS. The map is `channel id → a string`, read from this
 * driver's own config, and nothing here interprets that string — it is handed to the same
 * cartridge resolver an operator's typed argument goes through. That is what keeps the
 * abstraction honest: swapping Discord for Slack, or renaming a cartridge, touches config and
 * nothing else. A `film-engine` literal anywhere in this file would be the coupling the whole
 * channel layer exists to prevent, and the test asserts its absence.
 *
 * Config (this driver's, not NeonCore's):
 *   DISCORD_CHANNEL_TARGETS   "<channelId>=<target>, <channelId>=<target>"
 */

export interface ChannelRouting {
  /** The primary channel. Always accepted, and deliberately has NO default target. */
  channelId: string;
  /** Additional channels, each addressing one target. */
  targets: Map<string, string>;
}

/**
 * Parse the map.
 *
 * A malformed entry is DROPPED, never half-read. An entry that parsed to an empty target would
 * route every command in that channel at the empty string, which resolves to nothing and reads
 * as the bot ignoring you — worse than the channel simply not being mapped.
 */
export function parseChannelTargets(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(raw || '').split(',')) {
    const [id, ...rest] = part.split('=');
    const channelId = (id || '').trim();
    const target = rest.join('=').trim();
    // Both halves, or nothing. A channel id is digits; anything else is a typo
    // in config, and guessing at it routes commands somewhere nobody chose.
    if (!channelId || !target || !/^\d+$/.test(channelId)) continue;
    out.set(channelId, target);
  }
  return out;
}

/**
 * May this channel command NeonCore?
 *
 * The primary channel plus whatever is mapped, and NOTHING else — the bot can be invited to any
 * channel on a server, and one that answers everywhere is one that answers in the wrong place.
 * The operator check still applies on top: a mapped channel widens WHERE, never WHO.
 */
export function acceptsChannel(channelId: string, cfg: ChannelRouting): boolean {
  if (!channelId) return false;
  return channelId === cfg.channelId || cfg.targets.has(channelId);
}

/**
 * The target a channel addresses, or undefined.
 *
 * The primary channel returns undefined ON PURPOSE. Giving it a default would make every
 * untargeted command there silently address one cartridge, which is the opposite of what a
 * general channel is for — and it would be invisible, because the command would succeed.
 */
export function defaultTargetFor(channelId: string, cfg: ChannelRouting): string | undefined {
  if (channelId === cfg.channelId) return undefined;
  return cfg.targets.get(channelId);
}
