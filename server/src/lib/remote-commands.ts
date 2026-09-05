/**
 * The commands that drive NeonCore from wherever you are — N2 of docs/plans/build-order.md.
 *
 * Registered against lib/commands-registry.ts, so they are not Discord's. The same two commands
 * are what a webhook, the dashboard, or a second app would dispatch; nothing in this file knows
 * which one is calling. That is the whole point of N1 having gone first.
 *
 * ADDRESSING. The plan writes `!prompt <cartridge> <text>`, and discord-bot.ts's own example
 * says "!prompt 1A do the thing" — but there is no short-handle column on `agents`, and never
 * was. Full names are `Mannys-Mac-Pro.local/film-engine`, which nobody is typing on a phone. So
 * a cartridge is addressed by any unambiguous fragment of its name, and an ambiguous one is
 * ANSWERED WITH THE CANDIDATES rather than resolved by picking the first row. Guessing which
 * cartridge you meant is the one failure mode that is worse than not understanding you: it
 * drops your prompt into a live session doing something else.
 */
import db from '../db.js';
import { registerCommand } from './commands-registry.js';
import { sendCommandToAgent } from './send-command.js';
import {
  AUTONOMY_LEVELS, SETTABLE_LEVELS, isAutonomyLevel, effectiveAutonomy,
  setWorkflowAutonomy, parseDuration, listAutoResolutions,
} from './autonomy.js';

export interface CartridgeRow {
  id: string;
  name: string;
  repo_name: string;
  status: string;
  last_seen: string;
}

export type Resolution =
  | { kind: 'found'; agent: CartridgeRow }
  | { kind: 'none'; query: string }
  | { kind: 'ambiguous'; query: string; candidates: CartridgeRow[] };

/**
 * Most specific match wins, and only an EXACT match may be ambiguous-free by luck.
 *
 * The order matters: a repo literally named `dev` must be reachable by typing `dev` even when
 * three other cartridges are on a branch containing those letters. Exact beats fuzzy, always.
 */
export function resolveCartridge(rows: CartridgeRow[], rawQuery: string): Resolution {
  const query = (rawQuery || '').trim();
  if (!query) return { kind: 'none', query };
  const q = query.toLowerCase();

  const byId = rows.find((r) => r.id === query);
  if (byId) return { kind: 'found', agent: byId };

  for (const field of ['repo_name', 'name'] as const) {
    const exact = rows.filter((r) => (r[field] || '').toLowerCase() === q);
    if (exact.length === 1) return { kind: 'found', agent: exact[0] };
    if (exact.length > 1) return { kind: 'ambiguous', query, candidates: exact };
  }

  const fuzzy = rows.filter((r) =>
    (r.repo_name || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
  if (fuzzy.length === 1) return { kind: 'found', agent: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: 'ambiguous', query, candidates: fuzzy };

  return { kind: 'none', query };
}

/** Split "film-engine go fix the tests" into its cartridge and its prompt. */
export function splitPromptArgs(args: string): { target: string; text: string } {
  const trimmed = (args || '').trim();
  const at = trimmed.search(/\s/);
  if (at < 0) return { target: trimmed, text: '' };
  return { target: trimmed.slice(0, at), text: trimmed.slice(at + 1).trim() };
}

function liveCartridges(): CartridgeRow[] {
  return db.prepare(`
    SELECT id, name, repo_name, status, last_seen FROM agents
    WHERE status != 'offline' AND dismissed_at IS NULL
    ORDER BY last_seen DESC
  `).all() as CartridgeRow[];
}

const label = (r: CartridgeRow) => r.repo_name || r.name || r.id;

export interface RunRow { id: string; name: string; run_number: number }

function runningRuns(): RunRow[] {
  return db.prepare(
    "SELECT id, name, run_number FROM workflows WHERE status = 'running' ORDER BY started_at DESC",
  ).all() as RunRow[];
}

const runLabel = (r: RunRow) => `${r.name}${r.run_number ? ` #${r.run_number}` : ''}`;

/**
 * Same rules as resolveCartridge: exact first, then a unique fragment, and an ambiguous query
 * is answered with its candidates rather than guessed. Raising a run's autonomy is exactly the
 * kind of thing that must not land on the wrong run.
 */
export function resolveRun(rows: RunRow[], rawQuery: string):
  | { kind: 'found'; run: RunRow }
  | { kind: 'none'; query: string }
  | { kind: 'ambiguous'; query: string; candidates: RunRow[] } {
  const query = (rawQuery || '').trim();
  if (!query) return { kind: 'none', query };
  const q = query.toLowerCase();

  const byId = rows.find((r) => r.id === query);
  if (byId) return { kind: 'found', run: byId };

  const exact = rows.filter((r) => (r.name || '').toLowerCase() === q);
  if (exact.length === 1) return { kind: 'found', run: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', query, candidates: exact };

  const fuzzy = rows.filter((r) => (r.name || '').toLowerCase().includes(q));
  if (fuzzy.length === 1) return { kind: 'found', run: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: 'ambiguous', query, candidates: fuzzy };

  return { kind: 'none', query };
}

/** Registered once at startup, before any driver starts. */
export function registerRemoteCommands(): void {
  registerCommand('cartridges', async ({ reply }) => {
    const rows = liveCartridges();
    if (rows.length === 0) return reply('No cartridges are online.');

    // The name you would TYPE is what is listed, not the id — a list you cannot act on is a
    // status page, and you already have one of those.
    const lines = rows.map((r) => `\`${label(r)}\` — ${r.status}`);
    await reply(`**Cartridges (${rows.length})**\n${lines.join('\n')}\n\nDrive one: \`!prompt <name> <text>\``);
  });

  registerCommand('prompt', async ({ args, reply }) => {
    const { target, text } = splitPromptArgs(args);
    if (!target) return reply('Usage: `!prompt <cartridge> <text>`');
    if (!text) return reply(`Nothing to send. Usage: \`!prompt ${target} <text>\``);

    const found = resolveCartridge(liveCartridges(), target);
    if (found.kind === 'none') {
      return reply(`No online cartridge matches \`${target}\`. Try \`!cartridges\`.`);
    }
    if (found.kind === 'ambiguous') {
      const names = found.candidates.map((c) => `\`${label(c)}\``).join(', ');
      return reply(`\`${target}\` matches ${found.candidates.length}: ${names}. Be more specific.`);
    }

    // The work standard rides along exactly as it does from the dashboard — a prompt sent from
    // a phone is not a lesser class of instruction.
    const command = sendCommandToAgent(found.agent.id, text, false, undefined, { standard: true });
    if (!command) return reply(`Could not reach \`${label(found.agent)}\` — it may have gone offline.`);

    await reply(`Sent to \`${label(found.agent)}\`.`);
  });

  registerCommand('autonomy', async ({ args, reply }) => {
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);

    // Bare `!autonomy` reports. You cannot raise a posture you cannot see.
    if (parts.length === 0) {
      const runs = runningRuns();
      if (!runs.length) return reply('No runs are in progress.');
      const lines = runs.map((r) => {
        const a = effectiveAutonomy(r.id);
        const until = a.expiresAt ? `, until ${a.expiresAt}` : '';
        const auto = listAutoResolutions(r.id, 1).length ? ' · has auto-resolutions' : '';
        return `\`${runLabel(r)}\` — **${a.level}** (${a.source}${until})${auto}`;
      });
      return reply(
        `**Autonomy**\n${lines.join('\n')}\n\n` +
        `Set: \`!autonomy <run> <${SETTABLE_LEVELS.join('|')}> [2h]\``,
      );
    }

    const [target, levelArg, durationArg] = parts;
    if (!levelArg) {
      return reply(`Usage: \`!autonomy <run> <${SETTABLE_LEVELS.join('|')}> [2h]\``);
    }

    const level = levelArg.toLowerCase();
    if (!isAutonomyLevel(level)) {
      return reply(`Unknown level \`${levelArg}\`. Known: ${AUTONOMY_LEVELS.join(', ')}.`);
    }
    // `full` exists in the schema and the audit, but grants nothing `advance` does not yet.
    // Accepting it would promise latitude the machinery to exercise safely is not written —
    // see docs/plans/build-order.md: ship advance first, live with it for a week.
    if (!SETTABLE_LEVELS.includes(level)) {
      return reply(
        `\`${level}\` is not available yet — it grants nothing \`advance\` does not, and the ` +
        `hold-if-no-default rule and override window it needs are unwritten. Use \`advance\`.`,
      );
    }

    const found = resolveRun(runningRuns(), target);
    if (found.kind === 'none') return reply(`No run in progress matches \`${target}\`.`);
    if (found.kind === 'ambiguous') {
      return reply(`\`${target}\` matches ${found.candidates.length}: ` +
        found.candidates.map((c) => `\`${runLabel(c)}\``).join(', ') + '. Be more specific.');
    }

    // A raise without a time-box is a grant you stop noticing. Refuse the typo rather than
    // treating an unparseable duration as "forever".
    let untilMs: number | null = null;
    if (durationArg) {
      const ms = parseDuration(durationArg);
      if (ms === null) return reply(`Could not read \`${durationArg}\` as a duration. Try \`2h\`, \`30m\`, \`1d\`.`);
      untilMs = Date.now() + ms;
    } else if (level !== 'manual') {
      return reply(`Raising autonomy needs a time-box: \`!autonomy ${target} ${level} 2h\`.`);
    }

    setWorkflowAutonomy(found.run.id, level, untilMs);
    const until = untilMs ? ` until ${new Date(untilMs).toISOString()}` : '';
    await reply(`\`${runLabel(found.run)}\` is now **${level}**${until}.`);
  });
}
