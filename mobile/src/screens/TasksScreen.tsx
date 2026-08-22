import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity, ScrollView,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, CardTop, StatusPill, Chip, ActionButton, ScreenTitle, Adaptive, useAdaptiveContent } from '../components/ui';
import { useResponsive, gridProps, gridKey } from '../responsive';
import { dispatchBlockMessage } from '../goalDisplay';
import { TASK_FILTERS, selectTaskRows, taskActions, queueRowActions, type TaskFilterKey, type TaskRow } from '../taskView';
import type { Task } from '../types';
import type { QueueItem } from '@neoncore/client';

/**
 * Tasks: discrete work items, and everything the desk lets you decide about one.
 *
 * SHOWS QUEUE ITEMS TOO. The desk's Tasks page renders tasks AND queue items under one
 * filter; this screen read only /api/tasks, so a server holding zero tasks and a full queue
 * looked like "No tasks" on the phone and a page of work at the desk. `selectTaskRows` is
 * the shared rule, and taskView.ts owns the queue→task vocabulary map.
 *
 * Claim and start are absent because they are not human actions: a cartridge claims its
 * own work through /api/tasks/queue. Creating and EDITING a task is absent for the same
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
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<TaskFilterKey>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-task, because a blocked dispatch is a question about THAT task and clearing it
  // from a shared banner would answer it for a task the user never asked about.
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const { columns } = useResponsive();
  const adaptive = useAdaptiveContent();

  const load = useCallback(async () => {
    try {
      if (!baseUrl) { setTasks([]); setQueueItems([]); return; }
      // Both lists, together. Failing the whole screen because one of them errored would
      // reintroduce the blank page this fixes, so the queue is best-effort.
      const [t, q] = await Promise.all([
        api.listTasks(baseUrl),
        api.getQueue(baseUrl).then((v) => v.items ?? []).catch(() => [] as QueueItem[]),
      ]);
      setTasks(t);
      setQueueItems(q);
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

  /** Settle a task by hand — for work that finished where the fleet could not see it. */
  async function settle(id: string, status: 'done' | 'failed') {
    if (!baseUrl) return;
    try { await api.completeTask(baseUrl, id, status); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not update'); }
  }

  /**
   * The same verbs the desk puts on a queue row. Kept here rather than sending the user to
   * the Queue screen: the desk acts on these rows in place, and a phone that only displays
   * them is the same "can't start it" the merge was meant to fix.
   */
  async function queueAct(id: string, verb: 'start' | 'retry' | 'cancel' | 'clear') {
    if (!baseUrl) return;
    const call = verb === 'start' ? api.startQueueItem
      : verb === 'retry' ? api.retryQueueItem
      : verb === 'cancel' ? api.cancelQueueItem
      : api.removeQueueItem;
    try { await call(baseUrl, id); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : `could not ${verb}`); }
  }

  /** Clear a finished task. The server refuses anything still live. */
  async function clearTask(id: string) {
    if (!baseUrl) return;
    try { await api.removeTask(baseUrl, id); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not clear'); }
  }

  if (loading) return <ActivityIndicator style={s.pad} color={theme.accent} />;

  const shown = selectTaskRows(tasks, queueItems, filter);
  const liveCount = selectTaskRows(tasks, queueItems, 'active').length;
  const totalCount = tasks.length + queueItems.length;

  return (
    <View style={s.wrap}>
      <Adaptive>
        <ScreenTitle
          title="Tasks"
          right={liveCount > 0 ? <Text style={s.count}>{liveCount} live</Text> : undefined}
        />
        {error ? <Text style={s.err}>{error}</Text> : null}
        {/* Every status gets its own way in. The chips are ALWAYS rendered: hiding them when
            nothing was finished yet is what made a done or cancelled task unfindable. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
          {TASK_FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.key === 'active' ? `Active ${liveCount}` : f.key === 'all' ? `All ${totalCount}` : f.label}
              on={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </ScrollView>
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
            {totalCount === 0
              ? 'No tasks.\nTasks are written on the dashboard and worked by cartridges.'
              : `Nothing ${filter === 'active' ? 'live' : `in ${filter.replace('_', ' ')}`}.\nTap All to see every row.`}
          </Text>
        }
        renderItem={({ item }: { item: TaskRow }) => {
          const color = STATUS_COLOR[item.status] ?? theme.textDim;
          const verbs = taskActions(item.status);
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

              {/* Verbs come from taskActions(status), so the phone and the desk cannot drift
                  on what a given status allows. A QUEUE row is not a task: the task endpoints
                  do not know its id, so it renders read-only and is managed on the Queue
                  screen, which is where its lane controls already live. */}
              <View style={s.actions}>
                {item.kind === 'queue' ? (
                  <>
                    {queueRowActions(item.queueStatus!).map((v) => (
                      <ActionButton
                        key={v}
                        label={v === 'start' ? 'Start' : v === 'retry' ? 'Retry' : v === 'cancel' ? 'Cancel' : 'Clear'}
                        tone={v === 'start' || v === 'retry' ? 'accent' : 'danger'}
                        onPress={() => void queueAct(item.id, v)}
                      />
                    ))}
                  </>
                ) : (
                  <>
                    {verbs.includes('dispatch') ? (
                      <ActionButton label="Send" tone="accent" onPress={() => void dispatch(item.id)} />
                    ) : null}
                    {gate ? (
                      <ActionButton label="Send anyway" tone="danger" onPress={() => void dispatch(item.id, true)} />
                    ) : null}
                    {verbs.includes('done') ? (
                      <ActionButton label="Mark done" tone="accent" onPress={() => void settle(item.id, 'done')} />
                    ) : null}
                    {verbs.includes('failed') ? (
                      <ActionButton label="Mark failed" tone="danger" onPress={() => void settle(item.id, 'failed')} />
                    ) : null}
                    {verbs.includes('cancel') ? (
                      <ActionButton label="Cancel" tone="danger" onPress={() => void cancel(item.id)} />
                    ) : null}
                    {verbs.includes('clear') ? (
                      <ActionButton label="Clear" tone="danger" onPress={() => void clearTask(item.id)} />
                    ) : null}
                  </>
                )}
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
