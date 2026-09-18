import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { ConferSession } from '../types';

/**
 * One confer session — milestone chips, live participant tallies, and a two-step cancel.
 * Rendered inside the Workflows screen's ACTIVE / RECENT sections next to workflow runs,
 * because a confer *is* a run: same "started something, watch it finish" shape. Kept live by
 * the confer_updated socket via the provider, so the chips advance without a refresh.
 *
 * Cancel state lives per-card (not in the list) so each session tracks its own
 * confirm → cancelling → error progression independently.
 */
export function ConferCard({ session: c }: { session: ConferSession }) {
  const { baseUrl, agents } = useNeonCore();
  // Two-step cancel with feedback — a bare "cancel" swallowed errors and gave no sign
  // anything happened, so a stuck confer looked un-cancellable.
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState('');
  const [resuming, setResuming] = useState(false);
  useEffect(() => { if (c.status !== 'failed') setResuming(false); }, [c.status]);

  const doCancel = async () => {
    setCancelling(true);
    setConfirming(false);
    setCancelErr('');
    try {
      await api.cancelConfer(baseUrl, c.id);
      // Leave it "Cancelling…" — the confer_updated socket flips this card to cancelled.
    } catch (e) {
      setCancelErr(e instanceof Error ? e.message : 'Cancel failed');
      setCancelling(false);
    }
  };
  const doResume = async () => {
    setResuming(true);
    setCancelErr('');
    try { await api.resumeConfer(baseUrl, c.id); }
    catch (e) {
      setCancelErr(e instanceof Error ? e.message : 'Resume failed');
      setResuming(false);
    }
  };

  const typeOf = (id: string) => agents.find((a) => a.id === id)?.agentType || 'agent';
  const participants = c.participantIds.length;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: conferColor[c.status] || theme.textFaint }]} />
        {/* The badge is what distinguishes this from a workflow RunRow at a glance. */}
        <Text style={styles.badge}>CONFER</Text>
        <Text style={styles.headMeta} numberOfLines={1}>
          {c.repoName || '—'} · {c.participantIds.map(typeOf).join(' + ')}
        </Text>
        {c.status === 'running' ? (
          cancelling ? (
            <Text style={styles.cancelling}>Cancelling…</Text>
          ) : confirming ? (
            <View style={styles.confirmRow}>
              <TouchableOpacity onPress={doCancel} style={styles.confirmBtn}>
                <Text style={styles.confirmText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setConfirming(false)} hitSlop={8}>
                <Text style={styles.keep}>keep</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setConfirming(true)} hitSlop={8}>
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
          )
        ) : c.status === 'failed' ? (
          <TouchableOpacity onPress={doResume} disabled={resuming} hitSlop={8}>
            <Text style={styles.cancel}>{resuming ? 'Resuming…' : 'Resume'}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={[styles.status, { color: conferColor[c.status] || theme.textDim }]}>
            {c.status.toUpperCase()}
          </Text>
        )}
      </View>
      {cancelErr ? <Text style={styles.err}>{cancelErr}</Text> : null}
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
}

const conferColor: Record<string, string> = {
  running: theme.teal, completed: theme.blue, failed: theme.danger, cancelled: theme.textFaint,
};

const styles = StyleSheet.create({
  // Geometry matches WorkflowsScreen's runRow (margins, radius) so the two read as one list.
  card: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, padding: 12, marginHorizontal: 12, marginVertical: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: {
    color: theme.accentSoft, fontSize: 10, fontWeight: '800', letterSpacing: 0.5,
    backgroundColor: theme.bgElevated, borderRadius: 5,
    paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden',
  },
  headMeta: { color: theme.textFaint, fontSize: 11, flex: 1 },
  status: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
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
