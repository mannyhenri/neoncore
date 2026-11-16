/**
 * The operating system's own notifications, raised by the server — no browser tab required.
 *
 * Before this, a desktop notification existed only as the dashboard's Web Notification: it showed
 * in the OS notification centre, but only while a dashboard tab was open somewhere and had been
 * granted permission. Close the browser and "a run needs you" reached nobody on the machine you
 * were sitting at. This channel raises it from the server process with the platform's notifier:
 *
 *   macOS    `terminal-notifier` when installed (click opens the dashboard), else `osascript`
 *   Linux    `notify-send` (libnotify) — needs a desktop session (DISPLAY / WAYLAND / D-Bus)
 *   Windows  a PowerShell toast through Windows.UI.Notifications
 *
 * ── WHAT IS SHOWN ──────────────────────────────────────────────────────────────────────
 * Setting `desktop_notifications`:  `action` (default) — only what needs you: a permission, a
 * question, a decision, a held step, a stuck agent, a Goal Pilot waiting on you · `all` — also
 * "finished" and "released without you" · `off`. Env NEONCORE_DESKTOP_NOTIFY overrides it (the
 * sandbox's headless check sets `off`).
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────────────
 * Title and body are NEVER spliced into a script. They travel as argv (osascript `on run argv`,
 * notify-send, terminal-notifier) or as environment variables (PowerShell), so a notice quoting
 * an agent's output — which can contain anything — cannot execute as code.
 */
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import db from '../../db.js';
import type { Channel, Notice, Delivery } from '../channels.js';

export type DesktopMode = 'action' | 'all' | 'off';
export const DESKTOP_MODES: DesktopMode[] = ['action', 'all', 'off'];
export const DESKTOP_SETTING_KEY = 'desktop_notifications';

/**
 * Notice types that ask a person to DO something. Anything else is information. A notice carrying
 * action buttons needs a person too, whatever its type — and `urgency` on the notice, when set,
 * is the caller saying so outright.
 */
export const ACTION_TYPES = new Set([
  'permission_request',        // approve / deny, or answer a question
  'workflow_attention',        // a run is blocked on a person (decision, question, failure, held step…)
  'workflow_manual_advance',   // a step finished and is held for you
  'workflow_decision',
  'workflow_failed',
  'agent_stuck',
  'goal_pilot_action',         // a Goal Pilot is waiting on you
  'test',
]);

export function needsAction(notice: Notice): boolean {
  if (notice.urgency) return notice.urgency === 'action';
  if (notice.actions && notice.actions.length > 0) return true;
  return ACTION_TYPES.has(String(notice.data?.type ?? ''));
}

export function desktopMode(): DesktopMode {
  const env = (process.env.NEONCORE_DESKTOP_NOTIFY || '').trim().toLowerCase();
  if ((DESKTOP_MODES as string[]).includes(env)) return env as DesktopMode;
  if (['0', 'false', 'no'].includes(env)) return 'off';
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DESKTOP_SETTING_KEY) as { value?: string } | undefined;
    const v = (row?.value || '').trim() as DesktopMode;
    if (DESKTOP_MODES.includes(v)) return v;
  } catch { /* no settings table yet */ }
  return 'action';
}

export interface DesktopCommand { cmd: string; args: string[]; env?: Record<string, string> }

const MAX_TITLE = 120;
const MAX_BODY = 400;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The command that shows `notice` on `platform`, or null when this machine has no way to. Pure
 * apart from the `has` probe, so every platform's shape is testable on any machine.
 */
export function desktopCommand(
  platform: NodeJS.Platform,
  notice: Notice,
  opts: { has: (bin: string) => boolean; url?: string; env?: NodeJS.ProcessEnv },
): DesktopCommand | null {
  const title = clip(notice.title || 'NeonCore', MAX_TITLE);
  const body = clip(notice.body || '', MAX_BODY);
  const urgent = needsAction(notice);

  if (platform === 'darwin') {
    if (opts.has('terminal-notifier')) {
      const args = ['-title', 'NeonCore', '-subtitle', title, '-message', body || ' ', '-group', String(notice.data?.type ?? 'neoncore')];
      if (urgent) args.push('-sound', 'Glass');
      if (opts.url) args.push('-open', opts.url);
      return { cmd: 'terminal-notifier', args };
    }
    if (!opts.has('osascript')) return null;
    const script = urgent
      ? 'on run argv\ndisplay notification (item 2 of argv) with title "NeonCore" subtitle (item 1 of argv) sound name "Glass"\nend run'
      : 'on run argv\ndisplay notification (item 2 of argv) with title "NeonCore" subtitle (item 1 of argv)\nend run';
    return { cmd: 'osascript', args: ['-e', script, title, body || ' '] };
  }

  if (platform === 'linux') {
    if (!opts.has('notify-send')) return null;
    const env = opts.env ?? process.env;
    // notify-send talks to the session's notification daemon; a server started over SSH or as a
    // system service has none, and the call would fail every time.
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY && !env.DBUS_SESSION_BUS_ADDRESS) return null;
    return { cmd: 'notify-send', args: ['--app-name=NeonCore', `--urgency=${urgent ? 'critical' : 'normal'}`, title, body] };
  }

  if (platform === 'win32') {
    if (!opts.has('powershell')) return null;
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$x = $t.GetElementsByTagName("text")',
      '$x.Item(0).AppendChild($t.CreateTextNode($env:NEONCORE_NOTIFY_TITLE)) > $null',
      '$x.Item(1).AppendChild($t.CreateTextNode($env:NEONCORE_NOTIFY_BODY)) > $null',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NeonCore").Show([Windows.UI.Notifications.ToastNotification]::new($t))',
    ].join('; ');
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', ps],
      env: { NEONCORE_NOTIFY_TITLE: title, NEONCORE_NOTIFY_BODY: body },
    };
  }
  return null;
}

const found = new Map<string, boolean>();
function has(bin: string): boolean {
  if (!found.has(bin)) {
    const probe = process.platform === 'win32'
      ? spawnSync('where', [bin], { stdio: 'ignore' })
      : spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    found.set(bin, probe.status === 0 || (bin === 'osascript' && fs.existsSync('/usr/bin/osascript')));
  }
  return found.get(bin)!;
}

/** Where a click should land: the goal a Goal Pilot notice is about, else the dashboard. */
function dashboardUrl(notice: Notice): string {
  const port = process.env.PORT || process.env.NEONCORE_PORT || '4040';
  const goalId = notice.data?.goalId;
  return `http://localhost:${port}/${typeof goalId === 'string' && goalId ? `#goal=${encodeURIComponent(goalId)}` : ''}`;
}

export type Spawner = (c: DesktopCommand) => Promise<{ ok: boolean; error?: string }>;

const realSpawn: Spawner = (c) => new Promise((resolve) => {
  try {
    const child = spawn(c.cmd, c.args, { env: { ...process.env, ...(c.env || {}) }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ ok: false, error: 'timed out' }); }, 10_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: `${path.basename(c.cmd)} exited ${code}` }); });
  } catch (err) {
    resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

let spawner: Spawner = realSpawn;
let platform: NodeJS.Platform = process.platform;
let probe: (bin: string) => boolean = has;

/** Tests only: run the channel against a fake OS. */
export function __setDesktopForTests(o: { spawner?: Spawner; platform?: NodeJS.Platform; has?: (bin: string) => boolean }): void {
  if (o.spawner) spawner = o.spawner;
  if (o.platform) platform = o.platform;
  if (o.has) probe = o.has;
}

/** Can this server raise a desktop notification at all, and if not, why not. For the settings UI. */
export function desktopStatus(): { mode: DesktopMode; available: boolean; notifier: string; reason: string } {
  const cmd = desktopCommand(platform, { title: 't', body: 'b' }, { has: probe });
  const mode = desktopMode();
  if (!cmd) {
    const reason = platform === 'linux'
      ? 'notify-send (libnotify) and a desktop session are needed on Linux'
      : platform === 'darwin' ? 'osascript was not found' : platform === 'win32' ? 'PowerShell was not found' : `no desktop notifier for ${platform}`;
    return { mode, available: false, notifier: '', reason };
  }
  return { mode, available: true, notifier: cmd.cmd, reason: '' };
}

export const desktopChannel: Channel = {
  name: 'desktop',

  isConfigured: () => desktopMode() !== 'off' && desktopCommand(platform, { title: 't', body: 'b' }, { has: probe }) !== null,

  async send(notice: Notice): Promise<Delivery> {
    const mode = desktopMode();
    // Not wanted is not a failure: an informational notice in `action` mode is simply not shown.
    if (mode === 'off' || (mode === 'action' && !needsAction(notice))) return { ok: true, dropped: [] };
    const cmd = desktopCommand(platform, notice, { has: probe, url: dashboardUrl(notice) });
    if (!cmd) return { ok: false, error: 'no desktop notifier on this machine' };
    const dropped: (keyof Notice)[] = [];
    if (notice.attachments?.length) dropped.push('attachments');
    if (notice.actions?.length) dropped.push('actions');     // buttons live in the dashboard and the phone
    if (notice.detail && Object.keys(notice.detail).length) dropped.push('detail');
    const out = await spawner(cmd);
    return { ok: out.ok, dropped, ...(out.error ? { error: out.error } : {}) };
  },
};
