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
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
