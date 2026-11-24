import React from 'react';
import { Text, ScrollView, StyleSheet, RefreshControl } from 'react-native';
import { theme, statusColor, statusLabel } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { messageableAgents } from '../work';
import { Card, CardTop, ScreenTitle, StatusPill, useAdaptiveContent } from '../components/ui';
import type { Agent } from '../types';

/**
 * AGENTS — every agent you can message, on every server: waiting on you first, then working, in
 * the background, idle. Tap one to open it: its transcript, and a box that sends it a prompt.
 */
export function AgentsScreen({ onOpenAgent }: { onOpenAgent: (a: Agent) => void }) {
  const { agents, refresh } = useNeonCore();
  const adaptive = useAdaptiveContent();
  const reachable = messageableAgents(agents);
  return (
    <ScrollView style={s.page} contentContainerStyle={[s.content, adaptive]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void refresh(); }} tintColor={theme.accent} />}>
      <ScreenTitle title="Agents" right={<Text style={s.count}>{reachable.length}</Text>} />
      {reachable.length === 0 ? <Text style={s.empty}>No agent is online.</Text> : null}
      {reachable.map((a) => (
        <Card key={`${(a as { origin?: string }).origin ?? ''}:${a.id}`} onPress={() => onOpenAgent(a)}>
          <CardTop>
            <Text style={s.agent} numberOfLines={1}>{a.name}</Text>
            <StatusPill label={statusLabel[a.status].toLowerCase()} color={statusColor[a.status]} />
          </CardTop>
          <Text style={s.faint} numberOfLines={1}>{a.repoName || a.repoPath} · {a.agentType}{a.machine ? ` · ${a.machine}` : ''}</Text>
          {a.currentTask ? <Text style={s.task} numberOfLines={2}>{a.currentTask}</Text> : null}
          <Text style={s.message}>Message ›</Text>
        </Card>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  content: { paddingBottom: 24 },
  count: { color: theme.accentSoft, fontSize: 15, fontWeight: '700' },
  empty: { color: theme.textDim, fontSize: 14, marginHorizontal: 16, marginVertical: 8 },
  agent: { color: theme.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  faint: { color: theme.textFaint, fontSize: 12, marginTop: 4 },
  task: { color: theme.textDim, fontSize: 13, marginTop: 6 },
  message: { color: theme.accentSoft, fontSize: 12, fontWeight: '700', marginTop: 8 },
});
