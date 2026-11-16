/**
 * Which side raises the OS notification on THIS computer — the server or this browser tab.
 *
 * The server now shows desktop notifications itself (server/src/lib/channels/desktop.ts), which
 * works with no dashboard open. When it runs on the same machine as this tab, the tab's own Web
 * Notification for the same event would be a duplicate, so the tab stands down. When the server
 * is another machine on the LAN, its notifications appear over THERE — this tab keeps notifying.
 */
import type { DesktopNotificationStatus } from '../types';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let serverCoversThisMachine = false;

export function serverCoversDesktop(status: Pick<DesktopNotificationStatus, 'available' | 'mode'> | null, hostname: string): boolean {
  return !!status && status.available && status.mode !== 'off' && LOOPBACK.has(hostname);
}

export function setDesktopStatus(status: DesktopNotificationStatus | null, hostname = typeof window === 'undefined' ? '' : window.location.hostname): void {
  serverCoversThisMachine = serverCoversDesktop(status, hostname);
}

/** Should this tab raise its own Web Notification? */
export function browserNotificationsWanted(): boolean {
  return !serverCoversThisMachine;
}
