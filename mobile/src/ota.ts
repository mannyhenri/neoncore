/**
 * OVER-THE-AIR UPDATES — the JavaScript side (native: ios/NeonCore/NeonCorePush.swift
 * NeonCoreUpdates; server: server/src/lib/mobile-updates.ts).
 *
 * The native app downloads newer versions of this JavaScript from the NeonCore server. JS tells it
 * which server (and token) to ask; whenever the app comes to the front it switches to a version
 * already downloaded (a reload — iOS rarely relaunches an app, so "on the next launch" alone left
 * updates waiting for days, 2026-11-24), else asks it to look. It reports that the running version
 * started cleanly — a version that never does is rolled back by the native side after a few launches.
 *
 * Publish an update: `npm run ota:publish` in mobile/ (scripts/ota-publish.ts).
 */
import { useEffect, useState } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';

/**
 * The native build's compatibility number — must equal NeonCoreUpdates.runtime in
 * NeonCorePush.swift (src/__tests__/ota.test.ts). Bump BOTH when native code or a native
 * dependency changes: a bundle built for one runtime never runs on another.
 */
export const OTA_RUNTIME = '1';

/** How long the app runs before it reports the version healthy. */
export const HEALTHY_AFTER_MS = 4000;

export interface UpdateStatus {
  /** The downloaded version running now; '' = the code built into the app. */
  running: string;
  /** Downloaded and waiting for the next launch; ''. */
  next: string;
  lastCheck: string;
  lastError: string;
  runtime: string;
  build: string;
}

export interface UpdatesNative {
  otaConfigure: (server: string, token: string) => void;
  otaMarkHealthy: () => void;
  otaCheckNow: () => void;
  otaStatus: () => Promise<UpdateStatus>;
  /** Reload into the downloaded version now. Absent on builds before 45. */
  otaApplyNow?: () => void;
}

const native = (): UpdatesNative | null => {
  const m = (NativeModules as { NeonCorePush?: Partial<UpdatesNative> }).NeonCorePush;
  return Platform.OS === 'ios' && m && typeof m.otaConfigure === 'function' ? (m as UpdatesNative) : null;
};

/** What the phone says about its version, in words. */
export function describeUpdate(s: UpdateStatus | null): string {
  if (!s) return 'This build cannot update over the air.';
  const running = s.running ? `Version ${s.running}` : `As installed (build ${s.build || '?'})`;
  if (s.next) return `${running} — version ${s.next} is ready: it starts the next time you come back to the app.`;
  if (s.lastError) return `${running} — ${s.lastError}`;
  return `${running} — up to date${s.lastCheck ? ` (checked ${s.lastCheck.slice(11, 16)})` : ''}.`;
}

/**
 * Wire the app to its updates: which server to ask, a check whenever the app comes to the front,
 * and — a few seconds after it has started — "this version works".
 */
export function useUpdates(server: string | null, token: string | null | undefined, impl: UpdatesNative | null = native()): void {
  useEffect(() => {
    if (!impl || !server) return;
    impl.otaConfigure(server, token ?? '');
    // Check now: on a fresh install the native launch check had no server yet, and the next one
    // would wait for the app to go to the background and come back.
    impl.otaCheckNow();
  }, [impl, server, token]);
  useEffect(() => {
    if (!impl) return undefined;
    const healthy = setTimeout(() => impl.otaMarkHealthy(), HEALTHY_AFTER_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // Coming back to the app: a version already downloaded starts now; otherwise look for one.
      void impl.otaStatus().then((s) => (s.next && impl.otaApplyNow ? impl.otaApplyNow() : impl.otaCheckNow()), () => impl.otaCheckNow());
    });
    return () => { clearTimeout(healthy); sub.remove(); };
  }, [impl]);
}

/** The phone's version and update state, for Settings. Null on a build without updates. */
export function useUpdateStatus(impl: UpdatesNative | null = native()): { status: UpdateStatus | null; refresh: () => void; checkNow: () => void } {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const refresh = () => { if (impl) void impl.otaStatus().then(setStatus).catch(() => setStatus(null)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [impl]);
  return { status, refresh, checkNow: () => { impl?.otaCheckNow(); setTimeout(refresh, 8000); } };
}
