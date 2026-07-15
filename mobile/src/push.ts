import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { api } from './api';
import { EAS_PROJECT_ID } from './config';

// Show the banner + play a sound even when the app is foregrounded. Without a handler,
// notifications that arrive while the app is open are silently swallowed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Ask for permission, mint an Expo push token, and register it with the server so the
 * server can push when a workflow finishes. Safe to call on every launch — registration is
 * idempotent server-side. Silently no-ops on a simulator (no push token) or if the user
 * declines. Returns the token, or null.
 */
export async function registerForPush(baseUrl: string): Promise<string | null> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return null;

    // getExpoPushTokenAsync throws on a simulator/emulator — treat that as "no push here".
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
    if (!token) return null;

    await api.registerPushToken(baseUrl, token, Platform.OS).catch(() => {});
    return token;
  } catch {
    // Push is a bonus — never let a failure here disrupt the app.
    return null;
  }
}

/**
 * Deep-link a workflow-finished notification to its run. Handles both a tap while running
 * and a cold start (app launched from the notification). `onOpenRun` receives the run's
 * workflowId; the caller fetches + navigates.
 */
export function usePushNavigation(baseUrl: string | null, onOpenWorkflow: (workflowId: string) => void) {
  // Keep the latest callback without re-subscribing the listener each render.
  const cb = useRef(onOpenWorkflow);
  cb.current = onOpenWorkflow;

  useEffect(() => {
    const handle = (data: unknown) => {
      const d = (data ?? {}) as { type?: string; workflowId?: string };
      if (d.type === 'workflow_finished' && d.workflowId) cb.current(d.workflowId);
    };

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      handle(resp.notification.request.content.data);
    });

    // Cold start: the app was opened by tapping the notification.
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) handle(resp.notification.request.content.data);
    });

    return () => sub.remove();
  }, [baseUrl]);
}
