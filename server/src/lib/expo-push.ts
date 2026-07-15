import db from '../db.js';

/**
 * Expo push for the NeonCore mobile app.
 *
 * The app registers its Expo push token (POST /api/push/register); we store one row per
 * device in `push_tokens`. When a workflow finishes, notifyWorkflowFinished() fans a push
 * out to every registered device via Expo's push service, carrying the workflowId so a tap
 * can deep-link straight into the run.
 *
 * This is distinct from lib/push-notify.ts (ntfy topics) — that path can't target the app
 * or deep-link; this one can.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'high';
  channelId?: string;
}

export function registerPushToken(token: string, platform: string): void {
  const now = new Date().toISOString();
  // Idempotent upsert keyed on the token (the device identity).
  db.prepare(`
    INSERT INTO push_tokens (token, platform, created_at, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, last_seen = excluded.last_seen
  `).run(token, platform || '', now, now);
}

export function removePushToken(token: string): void {
  db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

function allTokens(): string[] {
  const rows = db.prepare('SELECT token FROM push_tokens').all() as { token: string }[];
  return rows.map((r) => r.token);
}

/** Basic shape check — Expo tokens look like `ExponentPushToken[...]` or `ExpoPushToken[...]`. */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

/**
 * Send one notification to every registered device. Prunes tokens Expo reports as
 * DeviceNotRegistered so the table doesn't accumulate dead entries. Never throws — a push
 * failure must not affect workflow execution.
 */
export async function sendPushToAll(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const tokens = allTokens().filter(isExpoPushToken);
  if (tokens.length === 0) return;

  const messages: ExpoMessage[] = tokens.map((to) => ({
    to, title, body, data, sound: 'default', priority: 'high', channelId: 'default',
  }));

  try {
    // Expo accepts up to 100 messages per request; batch to be safe.
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.warn(`[expo-push] send returned ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { data?: Array<{ status: string; details?: { error?: string } }> };
      const tickets = json.data ?? [];
      tickets.forEach((t, idx) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          removePushToken(batch[idx].to);
          console.log(`[expo-push] Pruned unregistered token`);
        }
      });
    }
    console.log(`[expo-push] Sent "${title}" to ${tokens.length} device(s)`);
  } catch (err) {
    console.warn(`[expo-push] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Push that a workflow run reached a terminal state. Called from the executor's completion
 * path. `finalStatus` is 'completed' | 'failed'.
 */
export async function notifyWorkflowFinished(workflowId: string, finalStatus: string): Promise<void> {
  const row = db.prepare('SELECT name, run_number FROM workflows WHERE id = ?')
    .get(workflowId) as { name: string; run_number: number } | undefined;
  if (!row) return;

  const label = `${row.name}${row.run_number ? ` #${row.run_number}` : ''}`;
  const title = finalStatus === 'failed' ? 'Workflow failed' : 'Workflow complete';
  const body = finalStatus === 'failed'
    ? `${label} failed.`
    : `${label} finished.`;

  await sendPushToAll(title, body, {
    type: 'workflow_finished',
    workflowId,
    status: finalStatus,
  });
}
