/**
 * Settings → Notifications. Two sources of OS notifications, and what each can do:
 *
 *   · the SERVER shows them in the notification centre of the machine it runs on — permission
 *     requests, questions, decisions, held steps, stuck agents, a Goal Pilot waiting on you —
 *     with no dashboard open (server/src/lib/channels/desktop.ts);
 *   · this BROWSER tab shows them only while a dashboard tab is open and permission was granted.
 *     When the server already covers this machine, the tab stands down (lib/osNotify.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { setDesktopStatus } from '../lib/osNotify';
import type { DesktopNotificationStatus } from '../types';

const MODES: { value: DesktopNotificationStatus['mode']; label: string; hint: string }[] = [
  { value: 'action', label: 'When something needs me', hint: 'Permissions, questions, decisions, held steps, stuck agents, a feature pipeline waiting on you.' },
  { value: 'all', label: 'Everything', hint: 'Also finished runs, completed pipelines and gates released without you.' },
  { value: 'off', label: 'Off', hint: 'Nothing on this computer\'s notification centre.' },
];

export function NotificationSettings() {
  const [status, setStatus] = useState<DesktopNotificationStatus | null>(null);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');
  const [browserPerm, setBrowserPerm] = useState<string>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));

  useEffect(() => {
    api.getDesktopNotifications().then((s) => { setStatus(s); setDesktopStatus(s); }).catch((e) => setError((e as Error).message));
  }, []);

  const choose = useCallback(async (mode: DesktopNotificationStatus['mode']) => {
    setError('');
    try {
      const s = await api.setDesktopNotifications(mode);
      setStatus(s);
      setDesktopStatus(s);
    } catch (e) { setError((e as Error).message); }
  }, []);

  const test = useCallback(async () => {
    setTestResult('');
    try {
      const r = await api.sendTestNotification();
      setTestResult(r.channels.length ? `Sent through: ${r.channels.join(', ')}.` : (r.note || 'No channel is configured.'));
    } catch (e) { setTestResult((e as Error).message); }
  }, []);

  return (
    <div className="px-7 py-3 space-y-6">
      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-100">Desktop notifications</h3>
        <p className="text-[13px] text-gray-400">
          Shown by NeonCore itself in the notification centre of the computer it runs on — even with no dashboard open.
        </p>
        {status === null ? (
          <p className="text-[13px] text-gray-400">{error || 'Checking…'}</p>
        ) : (
          <>
            <p className={`text-[12px] ${status.available ? 'text-emerald-400' : 'text-amber-300'}`}>
              {status.available ? `Available on this computer (via ${status.notifier}).` : `Not available: ${status.reason}.`}
            </p>
            {status.envOverride && (
              <p className="text-[12px] text-amber-300/90">NEONCORE_DESKTOP_NOTIFY is set on the server; it wins over the choice below.</p>
            )}
            <div className="space-y-2.5">
              {MODES.map((m) => (
                <label key={m.value} className={`flex items-start gap-3 cursor-pointer p-3.5 rounded-xl border ${status.mode === m.value ? 'bg-neon-500/10 border-neon-500/55' : 'bg-gl-code border-white/[0.1]'}`}>
                  <input type="radio" name="desktop-mode" className="accent-[#5AAEFF] mt-1" checked={status.mode === m.value} onChange={() => choose(m.value)} />
                  <span>
                    <span className="text-sm font-semibold text-gray-100">{m.label}</span>
                    <span className="block text-[13px] text-gray-400 mt-0.5">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="flex items-center gap-3 pt-1">
          <button onClick={test} className="btn-primary h-[42px] px-4 text-[13px] font-semibold rounded-[10px]">
            Send a test notification
          </button>
          {testResult && <span className="text-[13px] text-gray-400">{testResult}</span>}
        </div>
        {error && status && <p className="text-[12px] text-amber-300">{error}</p>}
      </section>

      <section className="space-y-3 pt-2">
        <h3 className="text-lg font-semibold text-gray-100">Browser notifications</h3>
        <p className="text-[13px] text-gray-400">
          Raised by this dashboard tab — only while it is open. Useful when NeonCore runs on another machine; when it runs
          on this one and shows desktop notifications, the tab does not repeat them.
        </p>
        {browserPerm === 'unsupported' ? (
          <p className="text-[13px] text-gray-400">This browser does not support notifications.</p>
        ) : browserPerm === 'granted' ? (
          <p className="text-[12px] text-emerald-400">Allowed.</p>
        ) : browserPerm === 'denied' ? (
          <p className="text-[12px] text-amber-300">Blocked — allow notifications for this site in the browser's settings.</p>
        ) : (
          <button
            onClick={() => Notification.requestPermission().then(setBrowserPerm)}
            className="btn-ghost h-[42px] px-4 text-[13px] font-semibold rounded-[10px]"
          >
            Allow browser notifications
          </button>
        )}
      </section>
    </div>
  );
}
