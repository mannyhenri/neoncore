/**
 * Where commands and button actions are registered, independent of what delivers them.
 *
 * These registries were declared inside lib/discord-bot.ts. Nothing in them was Discord-shaped
 * — a command has a name and a handler, an action has a prefix and a handler — but living in
 * that file made Discord the only thing that could ever own them. The dashboard, a webhook or
 * a second app must register against the SAME table, or the same command has to be implemented
 * once per driver and they drift.
 *
 * Modules register what they own. A driver dispatches. A missing handler is reported to the
 * operator rather than swallowed, because a button that does nothing is indistinguishable from
 * a server that has died.
 */

export interface CommandContext {
  /** Raw arguments after the command word. */
  args: string;
  /** Reply to the operator. Safe to call more than once. */
  reply: (text: string) => Promise<void>;
  /**
   * What this command addresses when the operator named nothing — supplied by the driver from
   * ITS own config, e.g. a Discord channel that stands for one cartridge.
   *
   * A STRING THIS REGISTRY NEVER INTERPRETS. It is handed to the same resolver a typed argument
   * goes through, so a driver can make a channel an address without anything here learning what
   * lives behind the name. Absent means the operator must say.
   */
  defaultTarget?: string;
}

export interface ActionContext {
  /** Everything after the action prefix, e.g. "approve:perm_123" → "perm_123". */
  payload: string;
  reply: (text: string) => Promise<void>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;
export type ActionHandler = (ctx: ActionContext) => Promise<void> | void;

/**
 * Something that can bring commands IN — the inbound twin of a Channel. A driver owns its own
 * transport and lifetime; dispatch is shared through the registries below.
 */
export interface CommandSource {
  readonly name: string;
  isConfigured(): boolean;
  start(): Promise<void>;
  stop?(): Promise<void>;
}

const commands = new Map<string, CommandHandler>();
const actions = new Map<string, ActionHandler>();

/** e.g. registerCommand('prompt', ...) → "!prompt 1A do the thing" */
export function registerCommand(name: string, handler: CommandHandler): void {
  commands.set(name.toLowerCase(), handler);
}

/** e.g. registerAction('approve', ...) → button id "approve:perm_123" */
export function registerAction(prefix: string, handler: ActionHandler): void {
  actions.set(prefix.toLowerCase(), handler);
}

export function getCommand(name: string): CommandHandler | undefined {
  return commands.get(name.toLowerCase());
}

export function getAction(prefix: string): ActionHandler | undefined {
  return actions.get(prefix.toLowerCase());
}

/** For a driver's help output, and for tests asserting what is wired. */
export function listCommands(): string[] {
  return [...commands.keys()].sort();
}

export function listActions(): string[] {
  return [...actions.keys()].sort();
}

export function clearRegistries(): void {
  commands.clear();
  actions.clear();
}
