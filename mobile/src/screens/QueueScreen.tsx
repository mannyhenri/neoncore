import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, CardTop, StatusPill, Chip, ActionButton, ScreenTitle } from '../components/ui';
import type { QueueItem, QueueLane } from '../api';

/**
 * The queue on mobile: view, cancel, retry, clear.
 *
 * Pausing and resuming a lane is deliberately absent — that is desk work, and a phone is
 * where you check whether the overnight run is still moving, not where you administer it.
 *
 * Like the portal panel, this shows the LANE and the HALT REASON rather than only a status.
 * Every failure mode in the runner halts a lane with a reason, and "failed" without "which
 * lane stopped and why" is what teaches a user to stop trusting an unattended queue.
 *
 * Rendered with the shared card primitives so a queued item looks like a cartridge looks like a
 * workflow. It previously used divider rows and bare-text actions, which made the most
 * unattended surface in the app read as the least finished one.
 */

const STATUS_COLOR: Record<string, string> = {
  queued: theme.textDim,
  running: theme.accent,
  done: theme.success,
  failed: theme.danger,
  blocked: theme.warn,
  cancelled: theme.textFaint,
};

export function QueueScreen() {
  const { baseUrl } = useNeonCore();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lanes, setLanes] = useState<QueueLane[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const active = items.filter((i) => i.status === 'queued' || i.status === 'running').length;

  return (
    <View style={s.wrap}>
      <ScreenTitle
        title="Queue"
        right={active > 0 ? <Text style={s.count}>{active} active</Text> : undefined}
      />
      {error ? <Text style={s.err}>{error}</Text> : null}

      {/* No enqueue form. Work starts by prompting a cartridge or launching a confer or
          workflow; the server queues it when that cartridge is busy. This screen watches. */}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />}
        ListEmptyComponent={<Text style={s.empty}>Nothing queued.{'\n'}Prompts sent to a busy cartridge land here.</Text>}
        renderItem={({ item }) => {
          const lane = lanes.find((l) => l.lane === item.lane);
          const halted = Boolean(lane?.paused || lane?.haltedReason);
          const color = STATUS_COLOR[item.status] ?? theme.textDim;
          const live = item.status === 'queued' || item.status === 'running';
          const finished = item.status === 'done' || item.status === 'failed' || item.status === 'cancelled';
          return (
            <Card accent={color}>
              <CardTop>
                <StatusPill label={item.status} color={color} />
                <Chip label={item.kind} />
                <View style={{ flex: 1 }} />
                {halted ? <Text style={s.halted}>LANE HALTED</Text> : null}
              </CardTop>

              {/* Tap to read the whole request. Two clipped lines is fine for scanning a list
                  and useless when you need to know what was actually asked. */}
              <TouchableOpacity
                onPress={() => setExpanded((p) => ({ ...p, [item.id]: !p[item.id] }))}
                activeOpacity={0.7}
              >
                <Text style={s.body} numberOfLines={expanded[item.id] ? undefined : 2}>
                  {String(item.payload?.text ?? item.payload?.task ?? item.payload?.repoPath ?? item.id.slice(0, 8))}
                </Text>
              </TouchableOpacity>

              <Text style={s.lane} numberOfLines={1}>{item.lane}</Text>

              {/* WHY it stopped — without this a halt is indistinguishable from a bug */}
              {lane?.haltedReason ? <Text style={s.reason}>{lane.haltedReason}</Text> : null}
              {item.error ? <Text style={s.reason}>{item.error}</Text> : null}

              {/* Exclusive, same rule as the web: cancel while live, clear once finished.
                  `blocked` gets neither — it is stopped and waiting on a human. */}
              {(live || finished) && (
                <View style={s.actions}>
                  {live && <ActionButton label="Cancel" tone="danger" onPress={() => void cancel(item.id)} />}
                  {(item.status === 'failed' || item.status === 'cancelled') && (
                    <ActionButton label="Retry" tone="accent" onPress={() => void retry(item.id)} />
                  )}
                  {finished && <ActionButton label="Clear" onPress={() => void clear(item.id)} />}
                </View>
              )}
            </Card>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  err: { color: theme.danger, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  pad: { padding: 16 },
  count: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  halted: { fontSize: 10, color: theme.warn, fontWeight: '700', letterSpacing: 0.5 },
  body: { color: theme.text, fontSize: 13, lineHeight: 18, marginTop: 10 },
  lane: { color: theme.textFaint, fontSize: 10, marginTop: 6, fontFamily: 'Menlo' },
  reason: { color: theme.warn, fontSize: 11, lineHeight: 15, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  empty: { color: theme.textFaint, fontSize: 13, textAlign: 'center', marginTop: 60, lineHeight: 20 },
});
