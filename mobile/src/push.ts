import { useEffect, useRef } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { api } from './api';

/**
 * Push notifications over APNs — Apple frameworks only, no Expo and no third-party SDK.
 *
 * The native side (ios/NeonCore/AppDelegate.swift + NeonCorePush.swift) asks for permission,
 * registers with APNs, and emits the device token. We forward that token to the server,
 * which pushes to Apple directly (server/src/lib/apns-push.ts).
 *
 * The token is a hex string — nothing like the old `ExponentPushToken[...]`, so the server's
 * /api/push/register validates hex now.
 */

const { NeonCorePush } = NativeModules as {
  NeonCorePush?: {
    register: () => void;
    getDeviceToken: () => Promise<string | null>;
  };
};

const emitter = NeonCorePush ? new NativeEventEmitter(NativeModules.NeonCorePush) : null;

/**
 * Ask for permission, register with APNs, and hand the device token to the server so it can
 * push when a workflow finishes. Safe to call on every launch — registration is idempotent
 * server-side. Resolves to the token, or null (simulator, permission denied, non-iOS).
 */
export async function registerForPush(baseUrl: string): Promise<string | null> {
  // iOS-only for now: the native module is part of the iOS app. Android would need the
  // equivalent registration plus an FCM sender server-side.
  if (Platform.OS !== 'ios' || !NeonCorePush || !emitter) return null;

  try {
    // The token may already be cached from a previous launch in this process.
    const existing = await NeonCorePush.getDeviceToken().catch(() => null);
    if (existing) {
      await api.registerPushToken(baseUrl, existing, Platform.OS).catch(() => {});
      return existing;
    }

    // Otherwise kick off registration and wait for the token event (bounded, so a denied
    // permission or a simulator never leaves this hanging).
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (token: string | null) => {
        if (settled) return;
        settled = true;
        tokenSub.remove();
        errorSub.remove();
        clearTimeout(timer);
        resolve(token);
      };

      const tokenSub = emitter.addListener('NeonCorePushToken', (ev: { token?: string }) => {
        const token = ev?.token;
        if (!token) return finish(null);
        api.registerPushToken(baseUrl, token, Platform.OS).catch(() => {});
        finish(token);
      });
      const errorSub = emitter.addListener('NeonCorePushError', () => finish(null));
      const timer = setTimeout(() => finish(null), 15_000);

      NeonCorePush.register();
    });
  } catch {
    // Push is a bonus — never let a failure here disrupt the app.
    return null;
  }
}

/**
 * Deep-link a notification tap to its destination. Handles both a tap while running and a
 * cold start (the native side holds the launch payload until JS subscribes). Routes by the
 * payload's `type`, which the server sets:
 *   - workflow_finished / decision_gate → open that run (has workflowId)
 *   - permission_request               → open the Approvals screen
 */
export interface PushHandlers {
  onOpenWorkflow: (workflowId: string) => void;
  onOpenApprovals: () => void;
}

export function usePushNavigation(baseUrl: string | null, handlers: PushHandlers) {
  // Keep the latest handlers without re-subscribing the listener each render.
  const cb = useRef(handlers);
  cb.current = handlers;

  useEffect(() => {
    if (!emitter) return undefined;

    const sub = emitter.addListener('NeonCorePushOpened', (data: unknown) => {
      const d = (data ?? {}) as { type?: string; workflowId?: string };
      if ((d.type === 'workflow_finished' || d.type === 'decision_gate') && d.workflowId) {
        cb.current.onOpenWorkflow(d.workflowId);
      } else if (d.type === 'permission_request') {
        cb.current.onOpenApprovals();
      }
    });

    return () => sub.remove();
  }, [baseUrl]);
}
