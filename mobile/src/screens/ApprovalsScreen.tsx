import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { PermissionCard } from '../components/PermissionCard';

export function ApprovalsScreen() {
  const { baseUrl, permissions, agents } = useNeonCore();

  const agentName = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a?.repoName || a?.name || id.slice(0, 8);
  };

  const decide = async (id: string, decision: 'allowed' | 'denied', response?: string | object) => {
    try {
      await api.decidePermission(baseUrl, id, decision, response);
    } catch {
      /* socket permission_decided will reconcile; ignore transient errors */
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabHeader}>
        <Text style={styles.screenTitle}>Approvals</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12 }}>
        {permissions.length === 0 && <Text style={styles.empty}>Nothing waiting. 🎉</Text>}
        {permissions.map((p) => (
          <PermissionCard key={p.id} perm={p} agentName={agentName(p.agentId)} onDecide={decide} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  tabHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  screenTitle: { color: theme.text, fontSize: 26, fontWeight: '800' },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 80 },
});
