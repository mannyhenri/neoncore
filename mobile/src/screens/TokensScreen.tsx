import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity, TextInput,
} from 'react-native';
import { theme } from '../theme';
import { api, type BurnRate, type UsageSeries, type UsageBucket, type UsageAnchor, type UsageWindow, type UsageCheckpoint } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, ScreenTitle, Adaptive, Chip, ActionButton } from '../components/ui';
import { Modal, Pressable } from 'react-native';

/**
 * What the fleet is spending, and whether a change in approach moved it.
 *
 * REQUESTED: "per hour, per day, per week token burn ... over time that I can select the last
 * week, last month, last 6 months ... so I can see if I change anything in my approach how my
 * spend goes up or down and when I reached the max of my subscription."
 *
 * That last clause is the one that shapes this screen. The question is not "what did I spend"
 * — it is "what did I spend AROUND THE TIME something happened", so the chart is the primary
 * object and the totals are context for it. A single number cannot answer it.
 *
 * RANGES AND GRANULARITY ARE COUPLED. Hourly across six months is 4,000+ bars on a 390pt
 * phone: unreadable, and a needless payload. Each range therefore opens at the granularity
 * that fits it, and the bucket can still be overridden afterwards — the pairing is a default,
 * not a restriction, and mirrors dashboard/src/components/TokensPage.tsx exactly so the two
 * surfaces cannot drift into disagreeing about what "last month" means.
 *
 * ── ONE BREAKDOWN, NOT TWO ────────────────────────────────────────────────────────────
 * There was a per-CARTRIDGE card under the per-project one. On a fleet where each repo runs a
 * single cartridge — which is every fleet observed — they are the same list twice, in the same
 * order, differing only in that cartridge names carry a `<machine>/` prefix.
 *
 * The per-cartridge numbers are NOT gone: tapping a project opens its cartridges, which is
 * where that detail belongs — behind the row it explains, rather than beside it. `byCartridge`
 * is still read from the response for exactly that, so the drill-down keeps working and the
 * dimension stays rendered.
 */
const RANGES = [
  { key: 'week', label: 'Week', days: 7, bucket: 'hour' as UsageBucket },
  { key: 'month', label: 'Month', days: 30, bucket: 'day' as UsageBucket },
  { key: 'sixmonths', label: '6 months', days: 182, bucket: 'week' as UsageBucket },
];

const BUCKETS: { key: UsageBucket; label: string }[] = [
  { key: 'hour', label: 'Hour' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
];

/** Compact enough that a six-figure token count does not wrap a bar label. */
function short(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * What a tapped row opens. Only project rows are tappable — the per-cartridge card that used to
 * sit beside them was the same list twice — so a drill is always a project and its `cartridges`
 * are the split behind it.
 */
interface Drill {
  title: string;
  tokens: number;
  samples: number;
  cartridges: { agentId: string; name: string; tokens: number; samples: number }[];
  subCount?: number;
  windowTokens: number;
}

const money = (n: number) => `$${(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const hoursLabel = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`);
/** Same words as the desk pill: "Claude 62% · wall in 31h" or "· resets in 2.1d". */
function anchorLabel(a: UsageAnchor): string {
  const provider = a.provider === 'claude' ? 'Claude' : a.provider === 'codex' ? 'Codex' : a.provider;
  const pct = `${Math.round(Math.max(0, a.pctUsed) * 100)}%`;
  const when = a.pctUsed < 1 && a.hitsWallBeforeReset && a.hoursToWall !== null
    ? `wall in ${hoursLabel(a.hoursToWall)}`
    : `resets in ${hoursLabel(a.hoursToReset)}`;
  return `${provider} ${pct} · ${when}`;
}

function tickLabel(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (bucket === 'hour') return `${d.getHours()}:00`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function TokensScreen() {
  const { baseUrl } = useNeonCore();
  const [rangeKey, setRangeKey] = useState('month');
  const [bucket, setBucket] = useState<UsageBucket>('day');
  const [metric, setMetric] = useState<'tokens' | 'costUsd'>('tokens');
  const [burn, setBurn] = useState<BurnRate | null>(null);
  const [data, setData] = useState<UsageSeries | null>(null);
  /**
   * The row the user opened. A breakdown that shows a number and cannot be opened answers
   * "how much" and refuses "what is inside it" — which is the question you have once you see
   * a number you did not expect.
   */
  const [drill, setDrill] = useState<Drill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A reading of the provider's own meter, typed in — server/src/lib/usage-checkpoint.ts.
  const [cpProvider, setCpProvider] = useState<'claude' | 'codex'>('claude');
  const [cpWindow, setCpWindow] = useState<UsageWindow>('weekly');
  const [cpPct, setCpPct] = useState('');
  const [cpResetIn, setCpResetIn] = useState('');
  const [cpMessage, setCpMessage] = useState('');
  const [cpBusy, setCpBusy] = useState(false);
  const [readings, setReadings] = useState<UsageCheckpoint[]>([]);
  // Two taps to remove: the first arms the row, the second deletes. A reading anchors the gauge.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];

  const selectRange = (key: string) => {
    setRangeKey(key);
    const r = RANGES.find((x) => x.key === key);
    if (r) setBucket(r.bucket);
  };

  const load = useCallback(async () => {
    if (!baseUrl) { setBurn(null); setData(null); setLoading(false); return; }
    try {
      setError('');
      // Both together. The burn readout and the series answer the same question at two
      // resolutions, and rendering one without the other is a half-answered page.
      const [b, s, cps] = await Promise.all([
        api.burnRate(baseUrl, range.days),
        api.usageSeries(baseUrl, range.days, bucket),
        // An older server has no readings route; that must not cost the rest of the page.
        api.getUsageCheckpoints(baseUrl).catch(() => null),
      ]);
      setBurn(b);
      setData(s);
      setReadings(cps?.checkpoints ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, range.days, bucket]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const removeReading = async (id: string) => {
    if (!baseUrl) return;
    if (confirmId !== id) { setConfirmId(id); return; }
    setConfirmId(null);
    try {
      await api.removeUsageCheckpoint(baseUrl, id);
      setCpMessage('Reading removed.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCpMessage(/404|no such reading/i.test(msg) ? 'Reading removed.' : msg);
    }
    await load();
  };

  const logCheckpoint = async () => {
    if (!baseUrl) return;
    const pct = Number(cpPct);
    const resetIn = Number(cpResetIn);
    if (cpPct.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      setCpMessage('Enter the percentage as the provider shows it, 0 to 100.');
      return;
    }
    if (!Number.isFinite(resetIn) || resetIn <= 0) {
      setCpMessage(cpWindow === 'weekly' ? 'Enter how many hours until it resets.' : 'Enter how many minutes until it resets.');
      return;
    }
    const ms = cpWindow === 'weekly' ? resetIn * 3_600_000 : resetIn * 60_000;
    setCpBusy(true);
    setCpMessage('');
    try {
      const out = await api.logUsageCheckpoint(baseUrl, {
        provider: cpProvider, window: cpWindow, pctUsed: pct, resetsAt: new Date(Date.now() + ms).toISOString(),
      });
      setCpMessage(out.anchor ? out.anchor.recommendation : `Recorded ${pct}%.`);
      setCpPct('');
      await load();
    } catch (e) {
      setCpMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setCpBusy(false);
    }
  };

  const series = data?.series ?? [];
  const values = series.map((p) => (metric === 'tokens' ? p.tokens : p.costUsd));
  const peak = Math.max(1, ...values);

  return (
    <ScrollView
      style={styles.wrap}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.accent} />}
    >
      <Adaptive>
      <ScreenTitle title="Tokens" />

      {error !== '' && <Text style={styles.error}>{error}</Text>}

      {/* The headline pair: rate now, and what it implies per day. */}
      <Card>
        <View style={styles.rateRow}>
          <View style={styles.rateCell}>
            <Text style={styles.rateValue}>{short(burn?.tokensPerHour ?? 0)}</Text>
            <Text style={styles.rateLabel}>tokens / hour</Text>
          </View>
          <View style={styles.rateCell}>
            <Text style={styles.rateValue}>{short(burn?.tokensPerDay ?? 0)}</Text>
            <Text style={styles.rateLabel}>tokens / day</Text>
          </View>
          <View style={styles.rateCell}>
            <Text style={[styles.rateValue, { color: theme.teal }]}>{money(burn?.costPerDay ?? 0)}</Text>
            <Text style={styles.rateLabel}>cost / day</Text>
          </View>
        </View>
        <Text style={styles.sub}>
          {burn ? `${burn.activeCartridges} active over the last ${burn.days}d` : '—'}
        </Text>
      </Card>

      <Card>
        <Text style={styles.section}>USAGE READING — WHAT THE PROVIDER SHOWS</Text>
        <View style={styles.cpRow}>
          {(['claude', 'codex'] as const).map((p) => (
            <Chip key={p} label={p} on={cpProvider === p} onPress={() => setCpProvider(p)} />
          ))}
          {(['weekly', 'session'] as const).map((w) => (
            <Chip key={w} label={w === 'weekly' ? 'weekly' : '5 hour'} on={cpWindow === w} onPress={() => setCpWindow(w)} />
          ))}
        </View>
        <View style={styles.cpRow}>
          <TextInput
            style={styles.cpInput} keyboardType="numeric" placeholder="% used" placeholderTextColor={theme.textFaint}
            value={cpPct} onChangeText={setCpPct} accessibilityLabel="percent used"
          />
          <TextInput
            style={styles.cpInput} keyboardType="numeric"
            placeholder={cpWindow === 'weekly' ? 'resets in (hours)' : 'resets in (minutes)'}
            placeholderTextColor={theme.textFaint} value={cpResetIn} onChangeText={setCpResetIn} accessibilityLabel="resets in"
          />
          <ActionButton label={cpBusy ? 'Logging…' : 'Log'} tone="accent" disabled={cpBusy} onPress={() => void logCheckpoint()} />
        </View>
        {cpMessage ? <Text style={styles.cpMessage}>{cpMessage}</Text> : null}
        {(burn?.usageAnchor ?? []).map((a) => (
          <View key={`${a.provider}-${a.window}`} style={styles.cpAnchor}>
            <Text style={[styles.cpAnchorTitle, { color: a.pace === 'hold' ? theme.danger : a.pace === 'watch' ? theme.accent : theme.teal }]}>
              {anchorLabel(a)} · {a.window === 'weekly' ? 'weekly' : '5 hour'}
            </Text>
            <Text style={styles.cpAnchorBody}>{a.recommendation}</Text>
          </View>
        ))}
        {!burn?.usageAnchor?.length ? (
          <Text style={styles.rateLabel}>No reading yet. Log what the provider's usage page shows.</Text>
        ) : null}
        {readings.slice(0, 6).map((r) => (
          <View key={r.id} style={styles.cpReading}>
            <Text style={styles.cpReadingText}>
              {r.provider === 'claude' ? 'Claude' : r.provider === 'codex' ? 'Codex' : r.provider} · {r.window === 'weekly' ? 'weekly' : '5 hour'} · {Math.round(r.pctUsed * 100)}% · read {new Date(r.observedAt).toLocaleString()}
            </Text>
            <ActionButton
              label={confirmId === r.id ? 'Confirm' : 'Remove'} tone="danger"
              onPress={() => void removeReading(r.id)}
            />
          </View>
        ))}
      </Card>

      <Segmented options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={rangeKey} onChange={selectRange} />
      <Segmented options={BUCKETS} value={bucket} onChange={(k) => setBucket(k as UsageBucket)} />
      <Segmented
        options={[{ key: 'tokens', label: 'Tokens' }, { key: 'costUsd', label: 'Cost' }]}
        value={metric}
        onChange={(k) => setMetric(k as 'tokens' | 'costUsd')}
      />

      <Card>
        {loading && !data ? (
          <ActivityIndicator color={theme.accent} style={{ paddingVertical: 28 }} />
        ) : series.length === 0 ? (
          <Text style={styles.empty}>No usage recorded in this window.</Text>
        ) : (
          <>
            <View style={styles.chart}>
              {series.map((p, i) => {
                const v = metric === 'tokens' ? p.tokens : p.costUsd;
                return (
                  <View key={p.t} style={styles.barCol}>
                    <View
                      style={[
                        styles.bar,
                        {
                          // Always at least 1pt so an empty bucket reads as a recorded zero
                          // rather than as a gap where the chart stopped.
                          height: Math.max(1, (v / peak) * 120),
                          backgroundColor: v > 0 ? theme.accent : theme.border,
                        },
                      ]}
                    />
                    {/* Roughly six labels regardless of density — a label per bar is unreadable. */}
                    {i % Math.max(1, Math.floor(series.length / 6)) === 0 && (
                      <Text style={styles.tick} numberOfLines={1}>{tickLabel(p.t, data?.bucket ?? bucket)}</Text>
                    )}
                  </View>
                );
              })}
            </View>
            <Text style={styles.peak}>
              peak {metric === 'tokens' ? short(peak) : money(peak)} per {data?.bucket ?? bucket}
            </Text>
          </>
        )}
      </Card>

      <Card>
        <Text style={styles.section}>Total this window</Text>
        <View style={styles.rateRow}>
          <View style={styles.rateCell}>
            <Text style={styles.totalValue}>{short(data?.total.tokens ?? 0)}</Text>
            <Text style={styles.rateLabel}>tokens</Text>
          </View>
          <View style={styles.rateCell}>
            <Text style={[styles.totalValue, { color: theme.teal }]}>{money(data?.total.costUsd ?? 0)}</Text>
            <Text style={styles.rateLabel}>cost</Text>
          </View>
        </View>
      </Card>

      {(data?.byProject?.length ?? 0) > 0 && (
        <Card>
          <Text style={styles.section}>By project</Text>
          {data!.byProject.map((row) => (
            <BreakdownRow
              key={row.project}
              label={row.project}
              value={short(row.tokens)}
              fraction={row.tokens / Math.max(1, data!.byProject[0].tokens)}
              onPress={() => setDrill({
                title: row.project,
                tokens: row.tokens,
                samples: row.samples,
                // Matched on the project the SERVER assigned each cartridge, not on its name.
                // `c.name.includes(row.project)` was wrong whenever one repo name contains
                // another: `gridlight` also collected `gridlight-work` and `gridlight-manager`.
                cartridges: data!.byCartridge.filter((c) => c.project === row.project),
                subCount: row.cartridges,
                windowTokens: data!.total.tokens,
              })}
            />
          ))}
        </Card>
      )}


      <BreakdownSheet drill={drill} onClose={() => setDrill(null)} metricLabel={data?.bucket ?? bucket} />

      <View style={{ height: 28 }} />
      </Adaptive>
    </ScrollView>
  );
}

function Segmented({
  options, value, onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <TouchableOpacity
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.segment, on && styles.segmentOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 12 },
  error: { color: theme.danger, fontSize: 12, marginBottom: 8 },
  rateRow: { flexDirection: 'row', justifyContent: 'space-between' },
  rateCell: { flex: 1, alignItems: 'center' },
  rateValue: { color: theme.text, fontSize: 20, fontWeight: '700' },
  totalValue: { color: theme.text, fontSize: 22, fontWeight: '700' },
  rateLabel: { color: theme.textFaint, fontSize: 10, marginTop: 2 },
  cpRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 },
  cpInput: {
    flexGrow: 1, minWidth: 110, color: theme.text, fontSize: 14, paddingHorizontal: 10, paddingVertical: 8,
    borderWidth: 1, borderColor: theme.border, borderRadius: 8,
  },
  cpMessage: { color: theme.textDim, fontSize: 12, marginBottom: 8 },
  cpAnchor: { borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 8, marginTop: 4 },
  cpAnchorTitle: { fontSize: 14, fontWeight: '700' },
  cpAnchorBody: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  cpReading: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: theme.border,
  },
  cpReadingText: { flex: 1, color: theme.textFaint, fontSize: 11 },
  sub: { color: theme.textFaint, fontSize: 10, textAlign: 'center', marginTop: 8 },
  section: { color: theme.textDim, fontSize: 11, fontWeight: '700', marginBottom: 8 },
  segmented: {
    flexDirection: 'row', backgroundColor: theme.bgCard, borderRadius: 8,
    padding: 3, marginBottom: 8, borderWidth: 1, borderColor: theme.border,
  },
  segment: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6 },
  segmentOn: { backgroundColor: theme.accentSoft },
  segmentText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  segmentTextOn: { color: theme.accent },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 148, gap: 1 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 1, minWidth: 2 },
  tick: { color: theme.textFaint, fontSize: 8, marginTop: 3 },
  peak: { color: theme.textFaint, fontSize: 10, marginTop: 8, textAlign: 'right' },
  empty: { color: theme.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 24 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 },
  rowName: { color: theme.textDim, fontSize: 11, width: 96 },
  rowBarTrack: { flex: 1, height: 6, backgroundColor: theme.border, borderRadius: 3, overflow: 'hidden' },
  rowBar: { height: 6, backgroundColor: theme.accent, borderRadius: 3 },
  rowValue: { color: theme.text, fontSize: 11, width: 48, textAlign: 'right' },
  chev: { color: theme.textFaint, fontSize: 16, width: 12, textAlign: 'right' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: theme.bgElevated, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 1, borderColor: theme.border, paddingHorizontal: 16, paddingTop: 8,
  },
  grabber: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border,
    alignSelf: 'center', marginBottom: 14,
  },
  sheetTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  sheetSub: { color: theme.textFaint, fontSize: 11, marginTop: 2, marginBottom: 16 },
});


/** One pressable row of a breakdown. The whole row is the target, not a chevron. */
function BreakdownRow({
  label, value, fraction, onPress,
}: {
  label: string; value: string; fraction: number; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value} tokens. Open for detail.`}
    >
      <Text style={styles.rowName} numberOfLines={1}>{label}</Text>
      <View style={styles.rowBarTrack}>
        <View style={[styles.rowBar, { width: `${Math.max(2, fraction * 100)}%` }]} />
      </View>
      <Text style={styles.rowValue}>{value}</Text>
      <Text style={styles.chev}>›</Text>
    </TouchableOpacity>
  );
}

/**
 * What one row of a breakdown is made of.
 *
 * Shows share-of-window rather than only the raw count: "4.2M tokens" is not actionable until
 * you know it is 61% of everything you spent, which is the form the original request was in —
 * "see if I change anything in my approach how my spend goes up or down".
 */
function BreakdownSheet({
  drill, onClose, metricLabel,
}: {
  drill: Drill | null; onClose: () => void; metricLabel: string;
}) {
  if (!drill) return null;
  const share = drill.windowTokens > 0 ? (drill.tokens / drill.windowTokens) * 100 : 0;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle} numberOfLines={2}>{drill.title}</Text>
        <Text style={styles.sheetSub}>Project · per {metricLabel}</Text>

        <View style={styles.rateRow}>
          <View style={styles.rateCell}>
            <Text style={styles.rateValue}>{short(drill.tokens)}</Text>
            <Text style={styles.rateLabel}>tokens</Text>
          </View>
          <View style={styles.rateCell}>
            <Text style={[styles.rateValue, { color: theme.teal }]}>{share.toFixed(1)}%</Text>
            <Text style={styles.rateLabel}>of window</Text>
          </View>
          <View style={styles.rateCell}>
            <Text style={styles.rateValue}>{drill.samples}</Text>
            <Text style={styles.rateLabel}>sessions</Text>
          </View>
        </View>

        {(
          <>
            <Text style={styles.section}>
              {drill.subCount ?? 0} cartridge{(drill.subCount ?? 0) === 1 ? '' : 's'} in this project
            </Text>
            {drill.cartridges.length === 0 ? (
              // Reachable only if the server counted cartridges it then did not return — the
              // match itself can no longer fail. Saying so beats a blank that reads as "none".
              <Text style={styles.empty}>No per-cartridge rows came back for this project.</Text>
            ) : drill.cartridges.map((c) => (
              <View key={c.agentId} style={styles.row}>
                <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
                <Text style={styles.rowValue}>{short(c.tokens)}</Text>
              </View>
            ))}
          </>
        )}
        <View style={{ height: 24 }} />
      </View>
    </Modal>
  );
}
