import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, CardTop, StatusPill, Chip, ScreenTitle, Adaptive, useAdaptiveContent } from '../components/ui';
import { useResponsive, gridProps, gridKey } from '../responsive';
import { progressLabel, progressFraction, attentionLabel, scheduleLabel, reachWarning, goalOrder } from '../goalDisplay';
import type { Goal } from '../types';

/**
 * Goals on the phone: which ones are moving, and which want something from you.
 *
 * The web's Goals workspace also DRAFTS and DECOMPOSES a goal — an authoring assistant
 * proposing fields you accept one at a time. That stays on the desk. A goal's intent
 * reaches every working cartridge at dispatch, so accepting a proposal is a consequential
 * act of writing, and this app's rule is that a phone is where you check on work and
 * unblock it (see QueueScreen). What a phone is genuinely better at is the thing the web
 * buries: noticing that a goal is stalled while you are away from the desk.
 *
 * So the list sorts by what is asking for a person, not by recency.
 */

const STATUS_COLOR: Record<string, string> = {
  active: theme.accent,
  paused: theme.warn,
  achieved: theme.success,
};

export function GoalsScreen({ onOpen }: { onOpen: (goal: Goal) => void }) {
  const { baseUrl } = useNeonCore();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { columns } = useResponsive();
  const adaptive = useAdaptiveContent();

  const load = useCallback(async () => {
    try {
      if (!baseUrl) { setGoals([]); return; }
      setGoals((await api.listGoals(baseUrl)).slice().sort(goalOrder));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read goals');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  // Goals emit no socket event — unlike workflows and tasks they are polled, so the
  // interval IS the liveness here rather than a backstop behind a live channel.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <ActivityIndicator style={s.pad} color={theme.accent} />;

  const needing = goals.filter((g) => g.health).length;

  return (
    <View style={s.wrap}>
      <Adaptive>
        <ScreenTitle
          title="Goals"
          right={needing > 0 ? <Text style={s.count}>{needing} need you</Text> : undefined}
        />
        {error ? <Text style={s.err}>{error}</Text> : null}
      </Adaptive>

      <FlatList
        data={goals}
        keyExtractor={(g) => g.id}
        key={gridKey(columns)}
        {...gridProps(columns)}
        contentContainerStyle={[{ paddingBottom: 24 }, adaptive]}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />
        }
        ListEmptyComponent={
          <Text style={s.empty}>
            No goals yet.{'\n'}Goals are written on the dashboard — they show up here to watch.
          </Text>
        }
        renderItem={({ item }) => <GoalCard goal={item} grid={columns > 1} onPress={() => onOpen(item)} />}
      />
    </View>
  );
}

export function GoalCard({ goal, grid, onPress }: { goal: Goal; grid?: boolean; onPress: () => void }) {
  const attention = attentionLabel(goal);
  const schedule = scheduleLabel(goal);
  const reach = reachWarning(goal);
  const fraction = progressFraction(goal);
  const color = attention ? theme.warn : STATUS_COLOR[goal.status] ?? theme.textDim;

  return (
    <Card accent={color} grid={grid} onPress={onPress}>
      <CardTop>
        <StatusPill label={goal.status} color={STATUS_COLOR[goal.status] ?? theme.textDim} />
        {goal.projectCount ? <Chip label={`${goal.projectCount} proj`} /> : null}
        <View style={{ flex: 1 }} />
        {attention ? <Text style={s.attention}>NEEDS YOU</Text> : null}
      </CardTop>

      <Text style={s.name} numberOfLines={2}>{goal.name}</Text>

      {/* The bar is drawn only when there is something to measure. An empty bar and a
          zero-progress bar are different claims, and only one of them is ever true here. */}
      <Text style={s.progressText}>{progressLabel(goal)}</Text>
      {fraction !== null ? (
        <View style={s.track}>
          <View style={[s.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: color }]} />
        </View>
      ) : null}

      {attention ? <Text style={s.reason}>{attention}</Text> : null}
      {schedule ? (
        <Text style={[s.meta, schedule.state === 'overdue' ? s.metaBad : null]}>{schedule.text}</Text>
      ) : null}
      {reach ? <Text style={s.reason}>{reach}</Text> : null}

      <View style={s.footer}>
        {goal.runCount ? <Text style={s.metaFaint}>{goal.runCount} runs</Text> : null}
        {typeof goal.costUsd === 'number' && goal.costUsd > 0 ? (
          <Text style={s.metaFaint}>${goal.costUsd.toFixed(2)}</Text>
        ) : null}
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  pad: { padding: 16 },
  err: { color: theme.danger, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  count: { color: theme.warn, fontSize: 12, fontWeight: '600' },
  name: { color: theme.text, fontSize: 15, fontWeight: '600', marginTop: 10, lineHeight: 20 },
  progressText: { color: theme.textDim, fontSize: 11, marginTop: 8 },
  track: {
    height: 4, backgroundColor: theme.border, borderRadius: 2, marginTop: 6, overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: 2 },
  attention: { fontSize: 10, color: theme.warn, fontWeight: '700', letterSpacing: 0.5 },
  reason: { color: theme.warn, fontSize: 11, lineHeight: 15, marginTop: 6 },
  meta: { color: theme.textDim, fontSize: 11, marginTop: 6 },
  metaBad: { color: theme.danger },
  metaFaint: { color: theme.textFaint, fontSize: 10 },
  footer: { flexDirection: 'row', gap: 12, marginTop: 10 },
  empty: { color: theme.textFaint, fontSize: 13, textAlign: 'center', marginTop: 60, lineHeight: 20 },
});
