import db from '../db.js';

function getGlobalNtfyUrl(): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('ntfy_url') as { value: string } | undefined;
  return row?.value?.trim() || null;
}

/**
 * Send a push notification via ntfy.
 *
 * @param title      Notification title shown in bold on the device.
 * @param message    Notification body text.
 * @param ntfyUrl    Optional per-cartridge topic URL. Falls back to the global
 *                   `ntfy_url` setting. Silently skips if neither is set.
 */
export async function pushNotify(title: string, message: string, ntfyUrl?: string): Promise<void> {
  const url = (ntfyUrl?.trim()) || getGlobalNtfyUrl();
  if (!url) return; // nothing configured — silent skip

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Title': title,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: message,
    });
    if (!res.ok) {
      console.warn(`[push-notify] ntfy returned ${res.status} for ${url}`);
    } else {
      console.log(`[push-notify] Sent: "${title}" → ${url}`);
    }
  } catch (err) {
    // Non-fatal — push failure must never crash the caller
    console.warn(`[push-notify] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Look up the ntfy URL for a virtual cartridge whose directory matches the
 * given repo path. Returns null if no matching cartridge or no URL set.
 */
export function getCartridgeNtfyUrl(repoPath: string): string | null {
  if (!repoPath) return null;
  const row = db.prepare(
    'SELECT ntfy_url FROM virtual_cartridges WHERE directory_path = ?'
  ).get(repoPath) as { ntfy_url: string } | undefined;
  return row?.ntfy_url?.trim() || null;
}
