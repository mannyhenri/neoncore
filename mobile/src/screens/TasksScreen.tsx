import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, CardTop, StatusPill, Chip, ActionButton, ScreenTitle, Adaptive, useAdaptiveContent } from '../components/ui';
import { useResponsive, gridProps, gridKey } from '../responsive';
import { isLiveTask, dispatchBlockMessage } from '../goalDisplay';
import type { Task } from '../types';

/**
 * Tasks: discrete work items, and the two decisions a phone should be able to make about
 * them — send this one now, or stop it.
 *
 * Claim and start are absent because they are not human actions: a cartridge claims its
 * own work through /api/tasks/queue. Creating and editing tasks is absent for the same
 * reason the queue has no enqueue form — work is described where there is a keyboard.
 */

const STATUS_COLOR: Record<string, string> = {
  queued: theme.textDim,
  claimed: theme.blue,
  in_progress: theme.accent,
  done: theme.success,
  failed: theme.danger,
  cancelled: theme.textFaint,
};

export function TasksScreen() {
  const { baseUrl, agents } = useNeonCore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-task, because a blocked dispatch is a question about THAT task and clearing it
  // from a shared banner would answer it for a task the user never asked about.
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const { columns } = useResponsive();
  const adaptive = useAdaptiveContent();

  const load = useCallback(async () => {
    try {
      if (!baseUrl) { setTasks([]); return; }
      setTasks(await api.listTasks(baseUrl));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read tasks');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  /**
   * Send a task to a cartridge.
   *
   * A 409 here is the dependency gate, not an error: the server is saying there is an
   * unfinished prerequisite and handing the call to a person. So the reason is shown on
   * the task with a Send anyway that re-sends with force — the override stays available
   * and stays deliberate.
   */
  async function dispatch(id: string, force = false) {
    if (!baseUrl) return;
    try {
      await api.dispatchTask(baseUrl, id, force ? { force: true } : undefined);
      setBlocked((p) => ({ ...p, [id]: '' }));
      await load();
    } catch (err) {
      const gate = dispatchBlockMessage(err);
      if (gate) setBlocked((p) => ({ ...p, [id]: gate }));
      else setError(err instanceof Error ? err.message : 'could not dispatch');
    }
  }

  async function cancel(id: string) {
    if (!baseUrl) return;
    try { await api.cancelTask(baseUrl, id); await load(); } catch { /* refresh shows truth */ }
  }

  if (loading) return <ActivityIndicator style={s.pad} color={theme.accent} />;

  const live = tasks.filter(isLiveTask);
  const finished = tasks.filter((t) => !isLiveTask(t));
  const shown = showDone ? [...live, ...finished] : live;

  return (
    <View style={s.wrap}>
      <Adaptive>
        <ScreenTitle
          title="Tasks"
          right={live.length > 0 ? <Text style={s.count}>{live.length} live</Text> : undefined}
        />
        {error ? <Text style={s.err}>{error}</Text> : null}
        {finished.length > 0 ? (
          <View style={s.filters}>
            <Chip label={`live ${live.length}`} on={!showDone} onPress={() => setShowDone(false)} />
            <Chip label={`all ${tasks.length}`} on={showDone} onPress={() => setShowDone(true)} />
          </View>
        ) : null}
      </Adaptive>

      <FlatList
        data={shown}
        keyExtractor={(t) => t.id}
        key={gridKey(columns)}
        {...gridProps(columns)}
        contentContainerStyle={[{ paddingBottom: 24 }, adaptive]}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />
        }
        ListEmptyComponent={
          <Text style={s.empty}>
            {tasks.length === 0
              ? 'No tasks.\nTasks are written on the dashboard and worked by cartridges.'
              : 'Nothing live.\nEverything here has finished.'}
          </Text>
        }
        renderItem={({ item }) => {
          const color = STATUS_COLOR[item.status] ?? theme.textDim;
          const agent = agents.find((a) => a.id === item.assignedAgentId);
          const gate = blocked[item.id];
          return (
            <Card accent={color} grid={columns > 1}>
              <CardTop>
                <StatusPill label={item.status.replace('_', ' ')} color={color} />
                {item.priority > 0 ? <Chip label={`p${item.priority}`} /> : null}
                <View style={{ flex: 1 }} />
              </CardTop>

              <Text style={s.title} numberOfLines={2}>{item.title}</Text>

              {item.prompt ? (
                <TouchableOpacity
                  onPress={() => setExpanded((p) => ({ ...p, [item.id]: !p[item.id] }))}
                  activeOpacity={0.7}
                >
                  <Text style={s.body} numberOfLines={expanded[item.id] ? undefined : 2}>
                    {item.prompt}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {agent ? <Text style={s.meta} numberOfLines={1}>on {agent.name}</Text> : null}
              {item.error ? <Text style={s.reason}>{item.error}</Text> : null}

              {/* The gate's own words, plus the override it explicitly offers. */}
              {gate ? (
                <View style={s.gate}>
                  <Text style={s.gateText}>{gate}</Text>
                </View>
              ) : null}

              <View style={s.actions}>
                {isLiveTask(item) ? (
                  <>
                    {item.status === 'queued' ? (
                      <ActionButton label="Send" tone="accent" onPress={() => void dispatch(item.id)} />
                    ) : null}
                    {gate ? (
                      <ActionButton label="Send anyway" tone="danger" onPress={() => void dispatch(item.id, true)} />
                    ) : null}
                    <ActionButton label="Cancel" tone="danger" onPress={() => void cancel(item.id)} />
                  </>
                ) : null}
              </View>
            </Card>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  pad: { padding: 16 },
  err: { color: theme.danger, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  count: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  title: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 10, lineHeight: 19 },
  body: { color: theme.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
  meta: { color: theme.textFaint, fontSize: 10, marginTop: 8, fontFamily: 'Menlo' },
  reason: { color: theme.danger, fontSize: 11, lineHeight: 15, marginTop: 6 },
  gate: {
    borderWidth: 1, borderColor: theme.warn, borderRadius: 10,
    padding: 10, marginTop: 10, backgroundColor: theme.warnSoft,
  },
  gateText: { color: theme.text, fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  empty: { color: theme.textFaint, fontSize: 13, textAlign: 'center', marginTop: 60, lineHeight: 20 },
});
