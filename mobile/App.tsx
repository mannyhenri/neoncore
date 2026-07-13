import React, { useEffect, useState } from 'react';
import { View, StyleSheet, StatusBar, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { theme } from './src/theme';
import { loadServerUrl } from './src/config';
import { NeonCoreProvider } from './src/NeonCoreProvider';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { CartridgeListScreen } from './src/screens/CartridgeListScreen';
import { CartridgeDetailScreen } from './src/screens/CartridgeDetailScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { WorkflowsScreen } from './src/screens/WorkflowsScreen';
import { TabBar, type TabName } from './src/components/TabBar';
import type { Agent } from './src/types';

type Route =
  | { name: 'list' }
  | { name: 'detail'; agent: Agent }
  | { name: 'approvals' }
  | { name: 'workflows' };

export default function App() {
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ name: 'list' });

  useEffect(() => {
    loadServerUrl().then((url) => {
      setServerUrl(url);
      setBooting(false);
    });
  }, []);

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
          <View style={styles.body}>
            {route.name === 'list' && (
              <CartridgeListScreen onOpen={(agent) => setRoute({ name: 'detail', agent })} />
            )}
            {route.name === 'detail' && (
              <CartridgeDetailScreen agent={route.agent} onBack={() => setRoute({ name: 'list' })} />
            )}
            {route.name === 'approvals' && <ApprovalsScreen />}
            {route.name === 'workflows' && <WorkflowsScreen />}
          </View>

          {/* Detail is a pushed screen — it owns the full surface and has its own back. */}
          {route.name !== 'detail' && (
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
