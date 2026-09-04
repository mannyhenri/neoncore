/**
 * APNs as a Channel. The transport itself stays in lib/apns-push.ts; this is the adapter.
 *
 * WHAT IT CANNOT CARRY, AND WHY THAT IS REPORTED. A push payload is a title, a body and custom
 * keys. It has no file transport, and its actionable buttons require notification categories
 * registered in the iOS app at build time — so a `Notice` carrying a screenshot or an
 * approve/reject pair arrives here with nowhere to put them. The plan is explicit that this is
 * named rather than hidden: "a missing picture is a known limitation and not a mystery."
 *
 * `detail` IS carried, folded into the body as labelled lines. Dropping it would lose the
 * substance of the notice, and a slightly long push is a far smaller loss than a silent one.
 */
import { isPushConfigured, sendPushToAll } from '../apns-push.js';
import type { Channel, Notice, Delivery } from '../channels.js';

function renderBody(notice: Notice): string {
  if (!notice.detail || Object.keys(notice.detail).length === 0) return notice.body;
  const lines = Object.entries(notice.detail).map(([k, v]) => `${k}: ${v}`);
  return `${notice.body}\n${lines.join('\n')}`;
}

export const apnsChannel: Channel = {
  name: 'apns',

  isConfigured: () => isPushConfigured(),

  async send(notice: Notice): Promise<Delivery> {
    const dropped: (keyof Notice)[] = [];
    if (notice.attachments?.length) dropped.push('attachments');
    if (notice.actions?.length) dropped.push('actions');

    const { sent } = await sendPushToAll(notice.title, renderBody(notice), notice.data);

    // `sent === 0` with push configured means no registered devices — a real non-delivery, and
    // reporting it as ok would be the same pretence as claiming to carry an attachment.
    return { ok: sent > 0, dropped, ...(sent === 0 ? { error: 'no devices registered' } : {}) };
  },
};
