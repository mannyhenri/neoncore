import React, { useState } from 'react';
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
  // Two-step cancel with feedback — the old bare "cancel" swallowed errors and gave no sign
  // anything happened, so a stuck confer looked un-cancellable.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelErr, setCancelErr] = useState<{ id: string; msg: string } | null>(null);

  const doCancel = async (id: string) => {
    setCancelId(id);
    setConfirmId(null);
    setCancelErr(null);
    try {
      await api.cancelConfer(baseUrl, id);
      // Leave it "Cancelling…" — the confer_updated socket flips this card to cancelled.
    } catch (e) {
      setCancelErr({ id, msg: e instanceof Error ? e.message : 'Cancel failed' });
      setCancelId(null);
    }
  };

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
                cancelId === c.id ? (
                  <Text style={styles.cancelling}>Cancelling…</Text>
                ) : confirmId === c.id ? (
                  <View style={styles.confirmRow}>
                    <TouchableOpacity onPress={() => doCancel(c.id)} style={styles.confirmBtn}>
                      <Text style={styles.confirmText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setConfirmId(null)}>
                      <Text style={styles.keep}>keep</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => setConfirmId(c.id)}>
                    <Text style={styles.cancel}>Cancel</Text>
                  </TouchableOpacity>
                )
              )}
            </View>
            {cancelErr?.id === c.id ? <Text style={styles.err}>{cancelErr.msg}</Text> : null}
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
  cancelling: { color: theme.textFaint, fontSize: 11, fontWeight: '700' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confirmBtn: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(239,68,68,0.18)',
  },
  confirmText: { color: theme.danger, fontSize: 11, fontWeight: '800' },
  keep: { color: theme.textDim, fontSize: 11, fontWeight: '700' },
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
