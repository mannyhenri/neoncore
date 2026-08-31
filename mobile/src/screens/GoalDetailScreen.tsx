import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { StatusPill, Chip, ActionButton, Adaptive } from '../components/ui';
import { progressLabel, progressFraction, attentionLabel, scheduleLabel, reachWarning, isLiveTask } from '../goalDisplay';
import type { Goal, Task } from '../types';

/**
 * One goal: what it is for, where it stands, and what is blocking it.
 *
 * The brief fields are the point of the screen. They are what reaches a working cartridge
 * at dispatch, so being able to READ them from a phone — to check what an agent was
 * actually told before you judge what it did — is the thing worth having here. Editing
 * them is not: they are long prose, and the goal is the one object where a careless edit
 * propagates to every agent it reaches.
 *
 * Its tasks come from the same /api/tasks the Tasks tab reads, filtered by goalId, rather
 * than a second endpoint or a second idea of what a task is.
 */

const STATUS_COLOR: Record<string, string> = {
  active: theme.accent,
  paused: theme.warn,
  achieved: theme.success,
};

export function GoalDetailScreen({ goal: initial, onBack }: { goal: Goal; onBack: () => void }) {
  const { baseUrl } = useNeonCore();
  const [goal, setGoal] = useState<Goal>(initial);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!baseUrl) return;
    // Settled, not all: a goal that loads with no task list still beats an empty screen,
    // and the two answer different questions.
    const [g, t] = await Promise.allSettled([
      api.getGoal(baseUrl, initial.id),
      api.listTasks(baseUrl, { goalId: initial.id }),
    ]);
    if (g.status === 'fulfilled') setGoal(g.value);
    if (t.status === 'fulfilled') setTasks(t.value);
  }, [baseUrl, initial.id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function setStatus(status: 'active' | 'paused' | 'achieved') {
    if (!baseUrl) return;
    setBusy(true);
    try {
      setGoal(await api.setGoalStatus(baseUrl, goal.id, status));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not update the goal');
    } finally {
      setBusy(false);
    }
  }

  const attention = attentionLabel(goal);
  const schedule = scheduleLabel(goal);
  const reach = reachWarning(goal);
  const fraction = progressFraction(goal);
  const live = tasks.filter(isLiveTask);

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />}
    >
      <Adaptive>
        <TouchableOpacity onPress={onBack} style={s.back} activeOpacity={0.7}>
          <Text style={s.backText}>‹ Goals</Text>
        </TouchableOpacity>

        <View style={s.head}>
          <StatusPill label={goal.status} color={STATUS_COLOR[goal.status] ?? theme.textDim} />
          {typeof goal.reach === 'number' ? <Chip label={`reach ${goal.reach}`} /> : null}
        </View>
        <Text style={s.name}>{goal.name}</Text>

        <Text style={s.progressText}>{progressLabel(goal)}</Text>
        {fraction !== null ? (
          <View style={s.track}>
            <View style={[s.fill, { width: `${Math.round(fraction * 100)}%` }]} />
          </View>
        ) : null}

        {attention ? (
          <View style={s.alert}>
            <Text style={s.alertTitle}>{attention.toUpperCase()}</Text>
            {goal.health ? (
              <Text style={s.alertBody}>
                {goal.health.runName}
                {goal.health.stepName ? ` · ${goal.health.stepName}` : ''}
                {goal.health.detail ? `\n${goal.health.detail}` : ''}
              </Text>
            ) : null}
          </View>
        ) : null}

        {reach ? <Text style={s.warn}>{reach}</Text> : null}
        {schedule ? (
          <Text style={[s.meta, schedule.state === 'overdue' ? s.metaBad : null]}>{schedule.text}</Text>
        ) : null}
        {error ? <Text style={s.err}>{error}</Text> : null}

        {/* Pause and resume only. Writing a goal happens on the dashboard; stopping one
            that is misfiring is the decision you want to make from wherever you are. */}
        <View style={s.actions}>
          {goal.status === 'active' ? (
            <ActionButton label="Pause" onPress={() => void setStatus('paused')} disabled={busy} />
          ) : (
            <ActionButton label="Resume" tone="accent" onPress={() => void setStatus('active')} disabled={busy} />
          )}
          {goal.status !== 'achieved' ? (
            <ActionButton label="Mark achieved" onPress={() => void setStatus('achieved')} disabled={busy} />
          ) : null}
        </View>

        <Field label="WHY" value={goal.description} />
        <Field label="SUCCESS METRIC" value={goal.successMetric} />
        <Field label="ACCEPTANCE CRITERIA" value={goal.acceptanceCriteria} />
        <Field label="OUT OF SCOPE" value={goal.noGos} />
        <Field label="RABBIT HOLES" value={goal.rabbitHoles} />
        <Field label="INVARIANTS" value={goal.invariants} />

        {goal.keyResults?.length ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>KEY RESULTS ({goal.keyResults.length})</Text>
            {goal.keyResults.map((kr, i) => (
              <View key={`${kr.metric}-${i}`} style={s.kr}>
                <Text style={s.krMetric}>{kr.metric}</Text>
                {kr.baseline || kr.target ? (
                  <Text style={s.krRange}>
                    {kr.baseline ? `from ${kr.baseline}` : ''}
                    {kr.baseline && kr.target ? ' · ' : ''}
                    {kr.target ? `to ${kr.target}` : ''}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        <View style={s.section}>
          <Text style={s.sectionTitle}>
            TASKS ({live.length} live{tasks.length !== live.length ? ` · ${tasks.length} total` : ''})
          </Text>
          {tasks.length === 0 ? (
            <Text style={s.emptyLine}>Nothing queued under this goal.</Text>
          ) : (
            tasks.slice(0, 12).map((t) => (
              <View key={t.id} style={s.taskRow}>
                <View style={[s.dot, { backgroundColor: isLiveTask(t) ? theme.accent : theme.textFaint }]} />
                <Text style={s.taskTitle} numberOfLines={1}>{t.title}</Text>
                <Text style={s.taskStatus}>{t.status}</Text>
              </View>
            ))
          )}
        </View>
      </Adaptive>
    </ScrollView>
  );
}

/** A brief field. Absent stays absent — a blank line under a heading reads as "none". */
function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{label}</Text>
      <Text style={s.body}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingBottom: 40 },
  back: { paddingVertical: 6, marginBottom: 6 },
  backText: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  head: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  name: { color: theme.text, fontSize: 20, fontWeight: '700', marginTop: 10, lineHeight: 26 },
  progressText: { color: theme.textDim, fontSize: 12, marginTop: 12 },
  track: { height: 5, backgroundColor: theme.border, borderRadius: 3, marginTop: 6, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3, backgroundColor: theme.accent },
  alert: {
    borderWidth: 1, borderColor: theme.warn, borderRadius: 12,
    padding: 12, marginTop: 14, backgroundColor: theme.warnSoft,
  },
  alertTitle: { color: theme.warn, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  alertBody: { color: theme.text, fontSize: 12, lineHeight: 17, marginTop: 6 },
  warn: { color: theme.warn, fontSize: 12, marginTop: 10, lineHeight: 16 },
  meta: { color: theme.textDim, fontSize: 12, marginTop: 8 },
  metaBad: { color: theme.danger },
  err: { color: theme.danger, fontSize: 12, marginTop: 10 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  section: { marginTop: 22 },
  sectionTitle: { color: theme.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: theme.text, fontSize: 13, lineHeight: 19, marginTop: 8 },
  kr: { marginTop: 10 },
  krMetric: { color: theme.text, fontSize: 13, lineHeight: 18 },
  krRange: { color: theme.textFaint, fontSize: 11, marginTop: 2 },
  emptyLine: { color: theme.textFaint, fontSize: 12, marginTop: 8 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  taskTitle: { color: theme.text, fontSize: 13, flex: 1 },
  taskStatus: { color: theme.textFaint, fontSize: 10, fontWeight: '600' },
});
