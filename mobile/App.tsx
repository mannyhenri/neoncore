import React, { useEffect, useState } from 'react';
import { View, StyleSheet, StatusBar, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { theme } from './src/theme';
import { loadServerUrl } from './src/config';
import { NeonCoreProvider } from './src/NeonCoreProvider';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { CartridgeListScreen } from './src/screens/CartridgeListScreen';
import { CartridgeDetailScreen } from './src/screens/CartridgeDetailScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import type { Agent } from './src/types';

type Route =
  | { name: 'list' }
  | { name: 'detail'; agent: Agent }
  | { name: 'approvals' };

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
          {route.name === 'list' && (
            <CartridgeListScreen
              onOpen={(agent) => setRoute({ name: 'detail', agent })}
              onOpenApprovals={() => setRoute({ name: 'approvals' })}
            />
          )}
          {route.name === 'detail' && (
            <CartridgeDetailScreen agent={route.agent} onBack={() => setRoute({ name: 'list' })} />
          )}
          {route.name === 'approvals' && (
            <ApprovalsScreen onBack={() => setRoute({ name: 'list' })} />
          )}
        </NeonCoreProvider>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
