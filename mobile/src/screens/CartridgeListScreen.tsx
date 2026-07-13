import React, { useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { theme, statusColor, statusLabel, type AgentStatus } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import type { Agent } from '../types';
import { QuestionIcon } from '../components/Icons';
import { SwipeToDismiss } from '../components/SwipeToDismiss';

export function CartridgeListScreen({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const { agents, connected, refresh, dismissAgent, restoreAgent } = useNeonCore();
  const [refreshing, setRefreshing] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // Three buckets, and the distinction matters:
  //   hidden  — YOU put it away. Often still running.
  //   offline — the session actually ended.
  //   live    — everything else; the glanceable list.
  // `dismissedAt` and `status` are orthogonal, so these are separate checks.
  const hidden = agents.filter((a) => a.dismissedAt);
  const notHidden = agents.filter((a) => !a.dismissedAt);
  const offlineCount = notHidden.filter((a) => a.status === 'offline').length;
  const visible = showOffline ? notHidden : notHidden.filter((a) => a.status !== 'offline');

  // Live agents first, then by most-recently-seen.
  const sorted = [...visible].sort((a, b) => {
    const rank = (s: string) => (s === 'offline' ? 1 : 0);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (b.lastSeen || '').localeCompare(a.lastSeen || '');
  });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Cartridges</Text>
        <View style={styles.headerRight}>
          <View style={[styles.dot, { backgroundColor: connected ? theme.teal : theme.danger }]} />
          <Text style={styles.conn}>{connected ? 'live' : 'offline'}</Text>
        </View>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={theme.accent} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {hidden.length > 0
              ? `No live cartridges.\n${hidden.length} hidden.`
              : offlineCount > 0
                ? `No live cartridges.\n${offlineCount} offline.`
                : 'No cartridges yet.\nConnect an agent to your server.'}
          </Text>
        }
        ListFooterComponent={
          <View>
            {offlineCount > 0 && (
              <TouchableOpacity style={styles.toggle} onPress={() => setShowOffline((v) => !v)}>
                <Text style={styles.toggleText}>
                  {showOffline ? 'Hide offline' : `Show ${offlineCount} offline`}
                </Text>
              </TouchableOpacity>
            )}

            {/* Hidden — kept separate from offline, because a hidden cartridge is
                frequently still running. Restoring is always reachable from here. */}
            {hidden.length > 0 && (
              <>
                <TouchableOpacity style={styles.toggle} onPress={() => setShowHidden((v) => !v)}>
                  <Text style={styles.toggleText}>
                    {showHidden ? 'Hide put-away' : `Show ${hidden.length} put away`}
                  </Text>
                </TouchableOpacity>

                {showHidden &&
                  hidden.map((a) => (
                    <View key={a.id} style={styles.hiddenRow}>
                      <View
                        style={[
                          styles.hiddenDot,
                          { backgroundColor: statusColor[a.status as AgentStatus] ?? theme.textFaint },
                        ]}
                      />
                      <Text style={styles.hiddenName} numberOfLines={1}>
                        {a.repoName || a.name}
                      </Text>
                      {a.status !== 'offline' && (
                        <Text style={styles.hiddenLive}>still {a.status}</Text>
                      )}
                      <TouchableOpacity onPress={() => restoreAgent(a.id)}>
                        <Text style={styles.restore}>restore</Text>
                      </TouchableOpacity>
                    </View>
                  ))}

                {showHidden && (
                  <Text style={styles.hiddenHint}>
                    These come back on their own the moment the agent does anything.
                  </Text>
                )}
              </>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <SwipeToDismiss label="Hide" onAction={() => dismissAgent(item.id)}>
            <CartridgeCard agent={item} onPress={() => onOpen(item)} />
          </SwipeToDismiss>
        )}
      />
    </View>
  );
}

function CartridgeCard({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const color = statusColor[agent.status as AgentStatus] ?? theme.textDim;
  const hasQuestion = !!agent.pendingQuestion;
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardTop}>
        <Text style={styles.repo} numberOfLines={1}>
          {agent.repoName || agent.name || 'agent'}
        </Text>
        <View style={[styles.statusPill, { borderColor: color }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.statusText, { color }]}>{statusLabel[agent.status as AgentStatus] ?? agent.status}</Text>
        </View>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {agent.machine} · {agent.branch || 'no branch'} · {agent.mode}
      </Text>
      {hasQuestion ? (
        <View style={styles.questionRow}>
          <QuestionIcon size={15} color={theme.amber} strokeWidth={2} />
          <Text style={styles.question} numberOfLines={2}>
            {agent.pendingQuestion}
          </Text>
        </View>
      ) : (
        <Text style={styles.last} numberOfLines={2}>
          {agent.lastMessage || '—'}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  hiddenRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginVertical: 2, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: theme.bgElevated, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border,
  },
  hiddenDot: { width: 6, height: 6, borderRadius: 3 },
  hiddenName: { color: theme.textDim, fontSize: 13, flex: 1 },
  hiddenLive: { color: theme.teal, fontSize: 10, fontWeight: '700' },
  restore: { color: theme.accentSoft, fontSize: 12, fontWeight: '700' },
  hiddenHint: {
    color: theme.textFaint, fontSize: 11, textAlign: 'center',
    marginHorizontal: 24, marginTop: 6, marginBottom: 4,
  },
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: { color: theme.text, fontSize: 26, fontWeight: '800' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  conn: { color: theme.textDim, fontSize: 12, marginRight: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: {
    backgroundColor: theme.bgCard,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 12,
    marginVertical: 6,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  repo: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, marginRight: 8 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  meta: { color: theme.textFaint, fontSize: 12, marginTop: 6 },
  last: { color: theme.textDim, fontSize: 13, marginTop: 8, lineHeight: 18 },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8 },
  question: { color: theme.amber, fontSize: 13, lineHeight: 18, fontWeight: '600', flex: 1 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 80, lineHeight: 22 },
  toggle: { alignItems: 'center', paddingVertical: 16 },
  toggleText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
});
