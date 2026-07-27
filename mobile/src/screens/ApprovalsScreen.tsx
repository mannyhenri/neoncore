import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { PermissionCard } from '../components/PermissionCard';
import { CheckCircleIcon } from '../components/Icons';

export function ApprovalsScreen() {
  const { permissions, agents, refresh, urlForPermission } = useNeonCore();
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const agentName = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a?.repoName || a?.name || id.slice(0, 8);
  };

  const decide = async (id: string, decision: 'allowed' | 'denied', response?: string | object) => {
    try {
      await api.decidePermission(urlForPermission(id), id, decision, response);
    } catch {
      /* socket permission_decided will reconcile; ignore transient errors */
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabHeader}>
        <Text style={styles.screenTitle}>Approvals</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={theme.accent} />
        }
      >
        {permissions.length === 0 && (
          <View style={styles.emptyBox}>
            <CheckCircleIcon size={40} color={theme.textFaint} />
            <Text style={styles.empty}>Nothing waiting.</Text>
          </View>
        )}
        {permissions.map((p) => (
          <PermissionCard key={p.id} perm={p} agentName={agentName(p.agentId)} onDecide={decide} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  // flex:1 bounds the ScrollView to the available space so content taller than the screen
  // scrolls instead of overflowing and being clipped. paddingBottom clears the last option.
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 40 },
  tabHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  screenTitle: { color: theme.text, fontSize: 26, fontWeight: '800' },
  emptyBox: { alignItems: 'center', marginTop: 80, gap: 12 },
  empty: { color: theme.textFaint, textAlign: 'center' },
});
