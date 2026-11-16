import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../lib/api', () => ({
  api: {
    getDesktopNotifications: () => Promise.resolve({ mode: 'action', available: true, notifier: 'notify-send', reason: '' }),
    setDesktopNotifications: (mode: string) => { calls.push(['set', mode]); return Promise.resolve({ mode, available: true, notifier: 'notify-send', reason: '' }); },
    sendTestNotification: () => { calls.push(['test']); return Promise.resolve({ ok: true, channels: ['desktop'] }); },
  },
}));
import { NotificationSettings } from '../NotificationSettings';

describe('Settings → Notifications', () => {
  it('says what this computer can do, changes the mode, and sends a test', async () => {
    const view = render(<NotificationSettings />);
    await view.findByText(/Available on this computer \(via notify-send\)/);
    fireEvent.click(view.getByLabelText(/Everything/));
    await waitFor(() => expect(calls).toContainEqual(['set', 'all']));
    fireEvent.click(view.getByText('Send a test notification'));
    await waitFor(() => expect(calls).toContainEqual(['test']));
  });
});
