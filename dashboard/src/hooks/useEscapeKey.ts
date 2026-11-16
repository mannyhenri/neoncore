import { useEffect, useRef } from 'react';

/**
 * Close on Escape — for every modal and popover, with ONE rule about nesting: only the most
 * recently opened one closes. A Send Context modal opened from the Project Memory panel must
 * not take the panel down with it on a single key press.
 *
 * "Most recently opened" is decided at RENDER time, when `enabled` turns true: React runs a
 * child's effects before its parent's, so ordering by effect would put a dialog rendered inside
 * another one UNDER it. Render order is parent first, which is the order they appear in.
 *
 * Before this, six of the dashboard's modals (Settings, New Repo, Confer, Send Context, Git,
 * Project Memory…) ignored Escape while the Guide, the task and goal modals honoured it — the
 * same key doing nothing on half the dialogs.
 */
interface Entry { order: number; close: () => void }
const open = new Set<Entry>();
let seq = 0;

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || open.size === 0) return;
  let top: Entry | null = null;
  for (const entry of open) if (!top || entry.order > top.order) top = entry;
  e.stopPropagation();
  top!.close();
}

export function useEscapeKey(onClose: () => void, enabled = true): void {
  const close = useRef(onClose);
  close.current = onClose;
  const order = useRef(0);
  const wasEnabled = useRef(false);
  if (enabled && !wasEnabled.current) order.current = ++seq;
  wasEnabled.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    const entry: Entry = { order: order.current, close: () => close.current() };
    open.add(entry);
    if (open.size === 1) window.addEventListener('keydown', onKey);
    return () => {
      open.delete(entry);
      if (open.size === 0) window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}
