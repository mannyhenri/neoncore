import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity,
} from 'react-native';
import { theme } from '../theme';
import { api, type BurnRate, type UsageSeries, type UsageBucket } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, ScreenTitle } from '../components/ui';

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

const money = (n: number) => `$${(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
      const [b, s] = await Promise.all([
        api.burnRate(baseUrl, range.days),
        api.usageSeries(baseUrl, range.days, bucket),
      ]);
      setBurn(b);
      setData(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, range.days, bucket]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const series = data?.series ?? [];
  const values = series.map((p) => (metric === 'tokens' ? p.tokens : p.costUsd));
  const peak = Math.max(1, ...values);

  return (
    <ScrollView
      style={styles.wrap}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.accent} />}
    >
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

      {(data?.byCartridge?.length ?? 0) > 0 && (
        <Card>
          <Text style={styles.section}>By cartridge</Text>
          {data!.byCartridge.slice(0, 12).map((c) => (
            <View key={c.agentId} style={styles.row}>
              <Text style={styles.rowName} numberOfLines={1}>{c.name || c.agentId.slice(0, 8)}</Text>
              <View style={styles.rowBarTrack}>
                <View
                  style={[
                    styles.rowBar,
                    { width: `${Math.max(2, (c.tokens / Math.max(1, data!.byCartridge[0].tokens)) * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.rowValue}>{short(c.tokens)}</Text>
            </View>
          ))}
        </Card>
      )}

      <View style={{ height: 28 }} />
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
});
