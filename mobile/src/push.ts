import { useEffect, useRef } from 'react';

/**
 * Push notifications — DISABLED pending a native (APNs) implementation.
 *
 * This app was ejected from Expo, which removed `expo-notifications`. Push was an
 * end-to-end Expo-service dependency, not just a client library:
 *   - the client minted an Expo push token (`ExponentPushToken[...]`)
 *   - the server sends via Expo's push service (server/src/lib/expo-push.ts → exp.host)
 *
 * Re-enabling it therefore needs BOTH sides rewired to APNs directly (or Firebase):
 *   1. Client: register with APNs and hand the native device token to
 *      `api.registerPushToken(...)` in registerForPush() below.
 *   2. Server: replace the exp.host sender with an APNs sender (needs an APNs auth key)
 *      and accept native device tokens alongside/instead of Expo tokens.
 *
 * Until then these are honest no-ops: the app builds and runs, it simply never registers a
 * token, so the server has nothing to push to. The public API is unchanged so App.tsx and
 * every caller keep working untouched.
 */

/**
 * Register this device for push and hand the token to the server.
 * Currently a no-op returning null — see the note above.
 */
export async function registerForPush(_baseUrl: string): Promise<string | null> {
  return null;
}

/**
 * Deep-link a notification tap to the right screen. Routes by the payload's `data.type`:
 *   - workflow_finished / decision_gate → open that run (has workflowId)
 *   - permission_request               → open the Approvals screen
 *
 * The routing logic is kept intact so a native implementation only has to feed it payloads:
 * call `handleNotificationData(data)` from your APNs listener.
 */
export interface PushHandlers {
  onOpenWorkflow: (workflowId: string) => void;
  onOpenApprovals: () => void;
}

export function usePushNavigation(_baseUrl: string | null, handlers: PushHandlers) {
  // Keep the latest handlers without re-subscribing each render — preserved so wiring a
  // native listener here later is a one-line change.
  const cb = useRef(handlers);
  cb.current = handlers;

  useEffect(() => {
    // No native notification listener yet. When APNs is wired up, subscribe here and call
    // the same routing function used previously:
    //
    //   const d = (data ?? {}) as { type?: string; workflowId?: string };
    //   if ((d.type === 'workflow_finished' || d.type === 'decision_gate') && d.workflowId) {
    //     cb.current.onOpenWorkflow(d.workflowId);
    //   } else if (d.type === 'permission_request') {
    //     cb.current.onOpenApprovals();
    //   }
    return undefined;
  }, [_baseUrl]);
}
