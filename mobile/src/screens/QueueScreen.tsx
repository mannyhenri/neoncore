import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { QueueItem, QueueLane } from '../api';

/**
 * The queue on mobile: view, enqueue, cancel.
 *
 * Pausing and resuming a lane is deliberately absent — that is desk work, and a phone is
 * where you check whether the overnight run is still moving, not where you administer it.
 *
 * Like the portal panel, this shows the LANE and the HALT REASON rather than only a status.
 * Every failure mode in the runner halts a lane with a reason, and "failed" without "which
 * lane stopped and why" is what teaches a user to stop trusting an unattended queue.
 */

const STATUS_COLOR: Record<string, string> = {
  queued: theme.textDim,
  running: theme.accent,
  done: '#34d399',
  failed: '#f87171',
  blocked: '#fbbf24',
  cancelled: theme.textDim,
};

export function QueueScreen() {
  const { baseUrl, agents } = useNeonCore();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lanes, setLanes] = useState<QueueLane[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      const view = await api.getQueue(baseUrl);
      setItems(view.items ?? []);
      setLanes(view.lanes ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read the queue');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const live = agents.filter((a) => a.status !== 'offline');


  async function cancel(id: string) {
    if (!baseUrl) return;
    try { await api.cancelQueueItem(baseUrl, id); await load(); } catch { /* refresh shows truth */ }
  }

  /** Put a failed item back. The server clears the counters and the lane halt it caused. */
  async function retry(id: string) {
    try { await api.retryQueueItem(baseUrl, id); await load(); } catch { /* refresh shows truth */ }
  }

  /** Remove one FINISHED row. Cancel stops live work; clear tidies what has already stopped. */
  async function clear(id: string) {
    try { await api.removeQueueItem(baseUrl, id); await load(); } catch { /* refresh shows truth */ }
  }

  if (loading) return <ActivityIndicator style={s.pad} color={theme.accent} />;

  return (
    <View style={s.wrap}>
      {/* The queue screen shipped with no title, so the phone showed a bare list with no
          indication of what it was. Same primitive as every other screen. */}
      <Text style={s.title}>Queue</Text>
      {error ? <Text style={s.err}>{error}</Text> : null}

      {/* No enqueue form. Work starts by prompting a cartridge or launching a confer or
          workflow; the server queues it when that cartridge is busy. This screen watches. */}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />}
        ListEmptyComponent={<Text style={s.empty}>Nothing queued.</Text>}
        renderItem={({ item }) => {
          const lane = lanes.find((l) => l.lane === item.lane);
          const halted = Boolean(lane?.paused || lane?.haltedReason);
          return (
            <View style={s.row}>
              <View style={s.rowTop}>
                <Text style={[s.status, { color: STATUS_COLOR[item.status] ?? theme.textDim }]}>
                  {item.status}
                </Text>
                <Text style={s.kind}>{item.kind}</Text>
                {halted ? <Text style={s.halted}>LANE HALTED</Text> : null}
              </View>
              {/* Tap to read the whole request. Two clipped lines is fine for scanning a list
                  and useless when you need to know what was actually asked. */}
              <TouchableOpacity onPress={() => setExpanded((p) => ({ ...p, [item.id]: !p[item.id] }))}>
                <Text style={s.body} numberOfLines={expanded[item.id] ? undefined : 2}>
                  {String(item.payload?.text ?? item.payload?.task ?? item.payload?.repoPath ?? item.id.slice(0, 8))}
                </Text>
              </TouchableOpacity>
              <Text style={s.lane}>{item.lane}</Text>
              {/* WHY it stopped — without this a halt is indistinguishable from a bug */}
              {lane?.haltedReason ? <Text style={s.reason}>{lane.haltedReason}</Text> : null}
              {item.error ? <Text style={s.reason}>{item.error}</Text> : null}
              {(item.status === 'queued' || item.status === 'running') && (
                <TouchableOpacity onPress={() => void cancel(item.id)}>
                  <Text style={s.cancel}>cancel</Text>
                </TouchableOpacity>
              )}
              {/* Exclusive, same rule as the web: cancel while live, clear once finished.
                  `blocked` gets neither — it is stopped and waiting on a human. */}
              {(item.status === 'failed' || item.status === 'cancelled') && (
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <TouchableOpacity onPress={() => void retry(item.id)}>
                    <Text style={[s.cancel, { color: theme.accent }]}>retry</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => void clear(item.id)}>
                    <Text style={s.cancel}>clear</Text>
                  </TouchableOpacity>
                </View>
              )}
              {item.status === 'done' && (
                <TouchableOpacity onPress={() => void clear(item.id)}>
                  <Text style={s.cancel}>clear</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  err: { color: '#f87171', fontSize: 12, padding: 12 },
  pad: { padding: 16 },
  form: { padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: theme.border },
  input: {
    backgroundColor: theme.bgElevated, color: theme.text,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13,
  },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    backgroundColor: theme.bgElevated, marginRight: 6,
  },
  chipOn: { backgroundColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 11 },
  chipTextOn: { color: theme.bg, fontWeight: '600' },
  btn: { backgroundColor: theme.accent, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
  btnOff: { opacity: 0.4 },
  btnText: { color: theme.bg, fontWeight: '600', fontSize: 13 },
  row: { padding: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { fontSize: 11, fontWeight: '700' },
  kind: { fontSize: 11, color: theme.textDim },
  halted: { fontSize: 10, color: '#fbbf24', fontWeight: '700' },
  title: { color: theme.text, ...theme.screenTitle, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  body: { color: theme.text, fontSize: 13, marginTop: 4 },
  lane: { color: theme.textDim, fontSize: 10, marginTop: 2, fontFamily: 'Menlo' },
  reason: { color: '#fbbf24', fontSize: 11, marginTop: 3 },
  cancel: { color: '#f87171', fontSize: 11, marginTop: 6 },
  empty: { color: theme.textDim, fontSize: 12, padding: 16 },
});
