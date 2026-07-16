import React, { useEffect, useState } from 'react';
import { View, StyleSheet, StatusBar, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { theme } from './src/theme';
import { loadServerUrl } from './src/config';
import { registerForPush, usePushNavigation } from './src/push';
import { api } from './src/api';
import { NeonCoreProvider } from './src/NeonCoreProvider';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { CartridgeListScreen } from './src/screens/CartridgeListScreen';
import { CartridgeDetailScreen } from './src/screens/CartridgeDetailScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { WorkflowsScreen } from './src/screens/WorkflowsScreen';
import { WorkflowRunDetailScreen } from './src/screens/WorkflowRunDetailScreen';
import { TabBar, type TabName } from './src/components/TabBar';
import { BrandHeader } from './src/components/BrandHeader';
import { useFonts, PressStart2P_400Regular } from '@expo-google-fonts/press-start-2p';
import type { Agent, Workflow } from './src/types';

type Route =
  | { name: 'list' }
  | { name: 'detail'; agent: Agent }
  | { name: 'approvals' }
  | { name: 'workflows' }
  | { name: 'workflowRun'; run: Workflow };

export default function App() {
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [fontsLoaded] = useFonts({ PressStart2P_400Regular });

  useEffect(() => {
    loadServerUrl().then((url) => {
      setServerUrl(url);
      setBooting(false);
    });
  }, []);

  // Once we know the server, register this device for push so it can tell us when a
  // workflow finishes. Idempotent server-side, so re-running on url change is fine.
  useEffect(() => {
    if (serverUrl) registerForPush(serverUrl);
  }, [serverUrl]);

  // Tapping a push deep-links to the right place: workflow/decision pushes open that run,
  // approval pushes open the Approvals screen.
  usePushNavigation(serverUrl, {
    onOpenWorkflow: (workflowId) => {
      if (!serverUrl) return;
      api.getWorkflowV2(serverUrl, workflowId)
        .then((data) => setRoute({ name: 'workflowRun', run: data.workflow }))
        .catch(() => {});
    },
    onOpenApprovals: () => setRoute({ name: 'approvals' }),
  });

  return (
    // Two stacked SafeAreaViews so the top and bottom insets can be painted
    // different colors. The bottom strip (home indicator) takes the SAME color as
    // the tab bar / input bar, so those bars read as running to the screen edge
    // instead of floating above a band of page background.
    // (react-native-safe-area-context would be the tidier tool, but it ships
    // native code — this stays pure JS so it can go out over EAS Update.)
    <>
      <SafeAreaView style={styles.safeTop} />
      <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      {booting ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : !serverUrl ? (
        <ConnectScreen onConnected={(url) => { setServerUrl(url); setRoute({ name: 'list' }); }} />
      ) : (
        <NeonCoreProvider baseUrl={serverUrl}>
          {/* Persistent brand bar on the tab screens (pushed detail screens own their surface). */}
          {route.name !== 'detail' && route.name !== 'workflowRun' && (
            <BrandHeader pixel={fontsLoaded} />
          )}
          <View style={styles.body}>
            {route.name === 'list' && (
              <CartridgeListScreen onOpen={(agent) => setRoute({ name: 'detail', agent })} />
            )}
            {route.name === 'detail' && (
              <CartridgeDetailScreen agent={route.agent} onBack={() => setRoute({ name: 'list' })} />
            )}
            {route.name === 'approvals' && <ApprovalsScreen />}
            {route.name === 'workflows' && (
              <WorkflowsScreen onOpenRun={(run) => setRoute({ name: 'workflowRun', run })} />
            )}
            {route.name === 'workflowRun' && (
              <WorkflowRunDetailScreen run={route.run} onBack={() => setRoute({ name: 'workflows' })} />
            )}
          </View>

          {/* Detail + run detail are pushed screens — they own the full surface and have their own back. */}
          {route.name !== 'detail' && route.name !== 'workflowRun' && (
            <TabBar
              active={route.name as TabName}
              onSelect={(t) => setRoute({ name: t } as Route)}
            />
          )}
        </NeonCoreProvider>
      )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  // Takes only the top inset (flex:0), painted in the page background.
  safeTop: { flex: 0, backgroundColor: theme.bg },
  // Takes the rest. Its bottom inset padding is painted in the bar color, which is
  // what closes the gap under the tab bar / input bar.
  safe: {
    flex: 1,
    backgroundColor: theme.bgElevated,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  // The page itself keeps the normal background; only the inset strip is elevated.
  body: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
});
