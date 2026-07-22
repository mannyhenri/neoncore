import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';

/**
 * Live milestone progress for active (and recently finished) confer sessions, shown at the
 * top of the Cartridges screen. Fed by the confer_updated socket via the provider.
 */
export function ConferProgress() {
  const { baseUrl, confers, agents } = useNeonCore();

  const now = Date.now();
  const visible = confers.filter(
    (c) => c.status === 'running' ||
      (c.completedAt && now - new Date(c.completedAt).getTime() < 10 * 60 * 1000),
  );
  if (visible.length === 0) return null;

  const typeOf = (id: string) => agents.find((a) => a.id === id)?.agentType || 'agent';
  const dotColor: Record<string, string> = {
    running: theme.teal, completed: theme.blue, failed: theme.danger, cancelled: theme.textFaint,
  };

  return (
    <View style={styles.wrap}>
      {visible.map((c) => {
        const participants = c.participantIds.length;
        return (
          <View key={c.id} style={styles.card}>
            <View style={styles.head}>
              <View style={[styles.dot, { backgroundColor: dotColor[c.status] || theme.textFaint }]} />
              <Text style={styles.headTitle}>Confer</Text>
              <Text style={styles.headMeta} numberOfLines={1}>
                {c.repoName || '—'} · {c.participantIds.map(typeOf).join(' + ')}
              </Text>
              {c.status === 'running' && (
                <TouchableOpacity onPress={() => api.cancelConfer(baseUrl, c.id).catch(() => {})}>
                  <Text style={styles.cancel}>cancel</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.task} numberOfLines={2}>{c.task}</Text>

            <View style={styles.steps}>
              {(c.milestones || []).map((m) => {
                const done = m.status === 'done';
                const active = m.status === 'active';
                return (
                  <View
                    key={m.id}
                    style={[styles.step, done ? styles.stepDone : active ? styles.stepActive : styles.stepPending]}
                  >
                    <Text style={[styles.stepText, done ? styles.stepTextDone : active ? styles.stepTextActive : styles.stepTextPending]}>
                      {m.name}{active ? ` ${m.doneIds.length}/${participants}` : done ? ' ✓' : ''}
                    </Text>
                  </View>
                );
              })}
            </View>

            {c.error ? <Text style={styles.err}>{c.error}</Text> : null}
            {c.status === 'completed' ? <Text style={styles.done}>All milestones complete.</Text> : null}
            {c.status === 'failed' ? <Text style={styles.err}>Confer failed — a milestone stalled.</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 4, gap: 8 },
  card: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, padding: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  headTitle: { color: theme.text, fontSize: 13, fontWeight: '800' },
  headMeta: { color: theme.textFaint, fontSize: 11, flex: 1 },
  cancel: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
  task: { color: theme.textDim, fontSize: 12, marginTop: 4, marginBottom: 8 },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  step: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, borderWidth: 1 },
  stepDone: { backgroundColor: 'rgba(16,185,129,0.18)', borderColor: 'rgba(16,185,129,0.4)' },
  stepActive: { backgroundColor: 'rgba(245,158,11,0.18)', borderColor: 'rgba(245,158,11,0.5)' },
  stepPending: { backgroundColor: theme.bgElevated, borderColor: theme.border },
  stepText: { fontSize: 11, fontWeight: '700' },
  stepTextDone: { color: theme.teal },
  stepTextActive: { color: theme.amber },
  stepTextPending: { color: theme.textFaint },
  err: { color: theme.amber, fontSize: 11, marginTop: 8 },
  done: { color: theme.blue, fontSize: 11, marginTop: 8 },
});
