/**
 * ── Discord as the remote control ────────────────────────────────────────────
 *
 * NeonCore is reachable on the LAN or over a VPN (SETUP.md:16). Away from the
 * desk it is not reachable at all, so a workflow that stops for a decision stops
 * until you get home — which is the problem this exists to end.
 *
 * A bot solves it the right way round: the gateway connection is OUTBOUND, a
 * persistent WebSocket dialled by this process. Nothing listens, no port is
 * forwarded, nothing is exposed to the internet, and the phone needs no VPN
 * client. That is a better network posture than a tunnel, not a worse one.
 *
 * THIS FILE IS A TRANSPORT, NOT A SECOND BRAIN. It holds no workflow state and
 * makes no decisions. Commands and buttons are registered by the modules that
 * own the behaviour (see registerCommand / registerAction), so the bot never
 * imports the executor or the routes — that keeps the dependency arrow pointing
 * one way and keeps Discord from becoming a second source of truth.
 *
 * Sits beside lib/apns-push.ts and deliberately mirrors its shape: config from
 * env, a public `isConfigured()` so callers can tell "off" from "broken", and a
 * send function that never throws into its caller. Push is not replaced — the
 * two are channels of the same notification.
 *
 * Requires: npm i discord.js --workspace=server
 *
 * Env:
 *   DISCORD_BOT_TOKEN     bot token. Absent ⇒ the whole feature is off.
 *   DISCORD_CHANNEL_ID    channel that receives attention events and approvals.
 *   DISCORD_OPERATOR_ID   the ONE Discord user id allowed to command NeonCore.
 */

import fs from 'fs';
import path from 'path';
import {
  Client, GatewayIntentBits, AttachmentBuilder, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type Interaction, type TextBasedChannel,
} from 'discord.js';
import { getCommand, getAction, listCommands, type CommandSource } from './commands-registry.js';

/*
 * Discord's attachment ceiling is 10MB on a free tier and higher with Nitro or
 * a boosted server. Held BELOW the real limit on purpose: a rejected upload
 * costs the whole message, and an approval that silently arrives with no
 * picture is worse than one that says the picture was too big.
 *
 * Film Engine is expected to hand over a proxy and a still (see
 * film-engine/docs/plans/remote-approvals.md, W3) rather than a master. This is
 * the backstop for when it does not.
 */
const MAX_ATTACHMENT_BYTES = 9 * 1024 * 1024;

/** Discord hard-caps message content. Truncate here so a long body never 400s. */
const MAX_CONTENT = 1900;

interface DiscordConfig {
  token: string;
  channelId: string;
  operatorId: string;
}

function readConfig(): DiscordConfig | null {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  const channelId = process.env.DISCORD_CHANNEL_ID || '';
  const operatorId = process.env.DISCORD_OPERATOR_ID || '';
  if (!token || !channelId) return null;
  if (!operatorId) {
    // Refuse rather than degrade. Without an operator id every member of the
    // channel could start agent work on this machine.
    console.warn('[discord] DISCORD_OPERATOR_ID is not set — bot disabled. '
      + 'Channel membership is not an authorisation model.');
    return null;
  }
  return { token, channelId, operatorId };
}

export function isDiscordConfigured(): boolean {
  return readConfig() !== null;
}

// ── Handler registries ───────────────────────────────────────────────────────
//
// MOVED to lib/commands-registry.ts. Nothing in them was Discord-shaped, and leaving them here
// made Discord the only thing that could ever own a command. This file is now one driver
// against that shared table — a CommandSource — not the place commands live.

// ── Client lifecycle ─────────────────────────────────────────────────────────

let client: Client | null = null;
let ready = false;

export async function startDiscordBot(): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    console.log('[discord] not configured — remote control disabled');
    return;
  }
  if (client) return;

  client = new Client({
    // MessageContent is privileged and must also be enabled in the Developer
    // Portal. Without it message commands arrive with an empty body, which
    // looks exactly like the bot ignoring you.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    ready = true;
    console.log(`[discord] connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (msg.channelId !== cfg.channelId) return;
    if (!msg.content.startsWith('!')) return;

    // The identity gate. Anyone can be in the channel; one person can drive.
    if (msg.author.id !== cfg.operatorId) {
      console.warn(`[discord] ignored command from ${msg.author.id}`);
      return;
    }

    const [word, ...rest] = msg.content.slice(1).trim().split(/\s+/);
    const handler = getCommand(word || '');
    const reply = async (text: string) => { await msg.reply(clip(text)); };

    if (!handler) {
      await reply(`Unknown command \`${word}\`. Known: ${listCommands().join(', ') || 'none registered'}`);
      return;
    }
    try {
      await handler({ args: rest.join(' '), reply });
    } catch (err) {
      console.error('[discord] command failed', err);
      await reply(`\`${word}\` failed: ${(err as Error).message}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== cfg.operatorId) {
      await interaction.reply({ content: 'Not authorised.', ephemeral: true });
      return;
    }
    const [prefix, ...rest] = interaction.customId.split(':');
    const handler = getAction(prefix || '');
    if (!handler) {
      await interaction.reply({ content: `No handler for \`${prefix}\`.`, ephemeral: true });
      return;
    }
    // Acknowledge inside 3s or Discord shows the click as failed; the work
    // behind these buttons routinely takes longer than that.
    await interaction.deferReply({ ephemeral: true });
    try {
      await handler({
        payload: rest.join(':'),
        reply: async (text: string) => { await interaction.editReply(clip(text)); },
      });
    } catch (err) {
      console.error('[discord] action failed', err);
      await interaction.editReply(`Failed: ${(err as Error).message}`);
    }
  });

  await client.login(cfg.token);
}

export async function stopDiscordBot(): Promise<void> {
  if (!client) return;
  await client.destroy();
  client = null;
  ready = false;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export interface SendOptions {
  /** Absolute paths on this machine. Oversized ones are named, not dropped silently. */
  files?: string[];
  /** Buttons: [{ id: 'approve:perm_123', label: 'Approve', style: 'success' }] */
  buttons?: { id: string; label: string; style?: 'primary' | 'success' | 'danger' | 'secondary' }[];
}

function clip(text: string): string {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;
}

/**
 * Mirrors sendPushToAll(title, body, data) so it can be dropped in at the same
 * call sites — stuck-detector.ts, workflow-executor-v2.ts, routes/permissions.ts.
 * Never throws: a notification channel that can break its caller is worse than
 * one that is quiet.
 */
export async function sendToDiscord(
  title: string,
  body: string,
  opts: SendOptions = {},
): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg || !client || !ready) return false;

  try {
    const channel = await client.channels.fetch(cfg.channelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[discord] channel ${cfg.channelId} is not a text channel`);
      return false;
    }

    const skipped: string[] = [];
    const files: AttachmentBuilder[] = [];
    for (const p of opts.files || []) {
      try {
        const { size } = fs.statSync(p);
        if (size > MAX_ATTACHMENT_BYTES) {
          skipped.push(`${path.basename(p)} (${(size / 1048576).toFixed(1)}MB)`);
          continue;
        }
        files.push(new AttachmentBuilder(p));
      } catch {
        skipped.push(`${path.basename(p)} (unreadable)`);
      }
    }

    let content = `**${title}**\n${body}`;
    if (skipped.length) content += `\n\n_Not attached — too large: ${skipped.join(', ')}._`;

    await (channel as TextBasedChannel & { send: Function }).send({
      content: clip(content),
      files,
      components: buildRows(opts.buttons),
    });
    return true;
  } catch (err) {
    console.error('[discord] send failed', err);
    return false;
  }
}

/** Discord allows 5 buttons per row, 5 rows. More than that is a design smell. */
function buildRows(buttons?: SendOptions['buttons']): ActionRowBuilder<ButtonBuilder>[] {
  if (!buttons?.length) return [];
  const STYLES = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
  } as const;

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + 5).map((b) =>
          new ButtonBuilder()
            // Discord's hard limits: custom_id 100 chars, label 80.
            .setCustomId(b.id.slice(0, 100))
            .setLabel(b.label.slice(0, 80))
            .setStyle(STYLES[b.style || 'secondary'])),
      ),
    );
  }
  return rows;
}

/**
 * Discord as a CommandSource — the inbound twin of lib/channels/discord.ts.
 *
 * Declared rather than merely implied: a future driver that forgets `isConfigured` or `start`
 * fails to typecheck here instead of failing quietly at runtime on someone's phone.
 */
export const discordSource: CommandSource = {
  name: 'discord',
  isConfigured: isDiscordConfigured,
  start: startDiscordBot,
  stop: stopDiscordBot,
};
