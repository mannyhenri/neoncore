/**
 * Discord as a Channel. The bot lifetime and command dispatch stay in lib/discord-bot.ts;
 * this is only the outbound adapter.
 *
 * Discord is the first driver written against the interface, not the design — nothing above
 * this file knows it exists. Swapping it for Slack means adding a sibling here and registering
 * it, and changing nothing else.
 */
import { isDiscordConfigured, sendToDiscord, discordRouting as routing } from '../discord-bot.js';
import { channelForTarget } from '../channel-targets.js';
import { targetForNotice } from '../notice-target.js';
import type { Channel, Notice, Delivery } from '../channels.js';

/** Discord's button styles. An unknown style is rendered rather than refused. */
const STYLES = new Set(['primary', 'success', 'danger', 'secondary']);
type DiscordStyle = 'primary' | 'success' | 'danger' | 'secondary';

function renderBody(notice: Notice): string {
  if (!notice.detail || Object.keys(notice.detail).length === 0) return notice.body;
  const lines = Object.entries(notice.detail).map(([k, v]) => `**${k}:** ${v}`);
  return `${notice.body}\n${lines.join('\n')}`;
}

export const discordChannel: Channel = {
  name: 'discord',

  isConfigured: () => isDiscordConfigured(),

  async send(notice: Notice): Promise<Delivery> {
    /*
     * Deliver where the conversation is. A cartridge with its own channel gets its notices
     * there; everything else goes to the primary channel exactly as before.
     *
     * NeonCore says which CARTRIDGE a notice is about (`targetForNotice`, from the ids the
     * notices already carry); this driver decides which of ITS rooms that means. Neither half
     * knows the other's vocabulary, which is what lets a second driver map the same target onto
     * something that is not a channel at all.
     */
    const { target } = targetForNotice(notice.data);
    const channelId = channelForTarget(target, routing());

    const ok = await sendToDiscord(notice.title, renderBody(notice), {
      channelId,
      files: notice.attachments,
      buttons: notice.actions?.map((a) => ({
        id: a.id,
        label: a.label,
        style: (a.style && STYLES.has(a.style) ? a.style : 'secondary') as DiscordStyle,
      })),
    });

    // Nothing is dropped: Discord carries files, buttons and detail. An oversized attachment is
    // NAMED in the message by sendToDiscord rather than vanishing, which is the same contract
    // one level down.
    return { ok, dropped: [], ...(ok ? {} : { error: 'send failed or bot not ready' }) };
  },
};
