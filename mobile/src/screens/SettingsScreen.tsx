import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { useUpdateStatus, describeUpdate, OTA_RUNTIME } from '../ota';
import { Card, CardTop, ScreenTitle, StatusPill, ActionButton, useAdaptiveContent } from '../components/ui';
import { FleetSheet } from '../components/FleetSheet';

/** SETTINGS — the servers this phone talks to, and its version (updates come from the server). */
export function SettingsScreen() {
  const { servers, serverStatuses } = useNeonCore();
  const { status, refresh, checkNow } = useUpdateStatus();
  const adaptive = useAdaptiveContent();
  const [fleetOpen, setFleetOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  return (
    <ScrollView style={s.page} contentContainerStyle={[s.content, adaptive]}>
      <ScreenTitle title="Settings" />

      <Text style={s.kicker}>SERVERS</Text>
      {servers.map((srv) => {
        const st = serverStatuses.find((x) => x.url === srv.url);
        const state = st?.authFailed ? { label: 'token refused', color: theme.danger } : st?.reachable === false ? { label: 'unreachable', color: theme.ember } : { label: 'connected', color: theme.success };
        return (
          <Card key={srv.url}>
            <CardTop>
              <Text style={s.name} numberOfLines={1}>{srv.name}</Text>
              <StatusPill label={srv.hidden ? 'hidden' : state.label} color={srv.hidden ? theme.textFaint : state.color} />
            </CardTop>
            <Text style={s.faint} numberOfLines={1}>{srv.url}</Text>
            {st?.lastError && st.reachable === false ? <Text style={s.err} numberOfLines={2}>{st.lastError}</Text> : null}
          </Card>
        );
      })}
      <View style={s.actions}><ActionButton label="Manage servers" tone="accent" onPress={() => setFleetOpen(true)} /></View>

      <Text style={s.kicker}>APP VERSION</Text>
      <Card>
        <Text style={s.body}>{describeUpdate(status)}</Text>
        <Text style={s.faint}>Updates come from {servers[0]?.name ?? 'your NeonCore server'} and install the next time the app opens. Runtime {OTA_RUNTIME}{status?.build ? ` · build ${status.build}` : ''}.</Text>
        <View style={s.actions}>
          <ActionButton label={checking ? 'Checking…' : 'Check for an update'} tone="accent" disabled={checking || !status}
            onPress={() => { setChecking(true); checkNow(); setTimeout(() => { setChecking(false); refresh(); }, 8000); }} />
        </View>
      </Card>

      <FleetSheet visible={fleetOpen} onClose={() => setFleetOpen(false)} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  content: { paddingBottom: 32 },
  kicker: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginHorizontal: 16, marginTop: 14, marginBottom: 8 },
  name: { color: theme.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  faint: { color: theme.textFaint, fontSize: 12, marginTop: 6 },
  err: { color: theme.dangerSoft, fontSize: 12, marginTop: 6 },
  body: { color: theme.text, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, marginHorizontal: 12 },
});
