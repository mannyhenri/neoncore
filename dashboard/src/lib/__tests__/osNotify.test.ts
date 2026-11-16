import { describe, it, expect } from 'vitest';
import { serverCoversDesktop, setDesktopStatus, browserNotificationsWanted } from '../osNotify';

describe('who raises the OS notification on this computer', () => {
  const on = { available: true, mode: 'action' as const, notifier: 'osascript', reason: '' };
  it('the server, when it runs HERE and can show them — the tab would only duplicate', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) expect(serverCoversDesktop(on, host), host).toBe(true);
  });
  it('this tab, when the server is another machine — its notifications appear over there', () => {
    expect(serverCoversDesktop(on, 'studio.local')).toBe(false);
    expect(serverCoversDesktop(on, '192.168.1.50')).toBe(false);
  });
  it('this tab, when the server cannot or will not', () => {
    expect(serverCoversDesktop({ ...on, available: false }, 'localhost')).toBe(false);
    expect(serverCoversDesktop({ ...on, mode: 'off' }, 'localhost')).toBe(false);
    expect(serverCoversDesktop(null, 'localhost')).toBe(false);
  });
  it('the switch the notifiers read follows the status', () => {
    setDesktopStatus(on, 'localhost');
    expect(browserNotificationsWanted()).toBe(false);
    setDesktopStatus({ ...on, mode: 'off' }, 'localhost');
    expect(browserNotificationsWanted()).toBe(true);
  });
});
