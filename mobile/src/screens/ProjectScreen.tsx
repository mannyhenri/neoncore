import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { theme } from '../theme';
import { work, COLUMNS, columnsOf, epicDate, waitsOnEpicQa, captainArt, type ColumnKey, type ProjectSpec, type RoadmapChart, type ProjectRewards, type RoadmapEpic, type SpecFeature } from '../work';
import { Card, CardTop, Chip, Meter, ActionButton, PrimaryButton, useAdaptiveContent } from '../components/ui';
import { RankPlate } from '../components/RankPlate';
import { Sprite } from '../world/Sprite';
import { Celebrate } from '../components/Celebrate';
import type { ProjectRef } from './ProjectsScreen';
import type { FeatureRef } from './NeedsYouScreen';

type View_ = 'board' | 'route';

/**
 * A PROJECT — its captain in his rank's costume, and two views of its work: the BOARD (To do →
 * In Progress → QA → Done, as the server places each feature) and the ROUTE (its epics in order,
 * with their dates, progress and what waits on QA). From here: mark a delivered feature done, pass
 * an epic's QA, start what is next.
 */
export function ProjectScreen({ project, onBack, onOpenFeature }: { project: ProjectRef; onBack: () => void; onOpenFeature: (f: FeatureRef) => void }) {
  const [spec, setSpec] = useState<ProjectSpec | null>(null);
  const [chart, setChart] = useState<RoadmapChart | null>(null);
  const [rank, setRank] = useState<ProjectRewards['rank'] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View_>('board');
  const [column, setColumn] = useState<ColumnKey>('progress');
  const adaptive = useAdaptiveContent();
  const [busy, setBusy] = useState('');
  const [celebrating, setCelebrating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sp, ch, rw] = await Promise.allSettled([work.spec(project.base, project.id), work.roadmap(project.base, project.id), work.rewards(project.base, project.id)]);
      if (sp.status === 'fulfilled') setSpec(sp.value);
      if (ch.status === 'fulfilled') setChart(ch.value);
      if (rw.status === 'fulfilled') setRank(rw.value.rank ?? null);
      setError(sp.status === 'rejected' ? String((sp.reason as Error)?.message ?? sp.reason) : '');
    } finally {
      setLoading(false);
    }
  }, [project.base, project.id]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    try { await fn(); after?.(); } catch (e) { Alert.alert('Not done', e instanceof Error ? e.message.replace(/^\d+ [^—]*— /, '') : String(e)); } finally { setBusy(''); void load(); }
  };
  const open = (f: { id: string; name: string }) => onOpenFeature({ base: project.base, goalId: f.id, name: f.name, projectId: project.id });

  const cols = spec ? columnsOf(spec.features) : null;
  const art = captainArt(project.base, rank?.id);
  return (
    <View style={s.page}>
      <View style={s.top}>
        <Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹ Projects</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={[s.content, adaptive]} refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />}>
        <View style={s.head}>
          {art ? <Sprite art={art} anim="idle" height={84} fps={3} /> : null}
          <View style={s.headSide}>
            <View style={s.nameRow}>
              <View style={[s.dot, { backgroundColor: project.color || theme.accent }]} />
              <Text style={s.name} numberOfLines={2}>{project.name}</Text>
            </View>
            {rank ? <RankPlate rank={rank} /> : null}
            {chart?.vision ? <Text style={s.vision} numberOfLines={3}>{chart.vision}</Text> : null}
          </View>
        </View>

        <View style={s.segment}>
          {(['board', 'route'] as const).map((v) => (
            <Pressable key={v} onPress={() => setView(v)} style={[s.segBtn, view === v ? s.segOn : null]}>
              <Text style={[s.segText, view === v ? s.segTextOn : null]}>{v === 'board' ? 'Board' : 'Route'}</Text>
            </Pressable>
          ))}
        </View>

        {loading && !spec ? <ActivityIndicator color={theme.accent} style={s.spin} /> : null}
        {error ? <Text style={s.err}>{error}</Text> : null}

        {view === 'board' && cols ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.columns}>
              {COLUMNS.map((c) => <Chip key={c.key} label={`${c.title} ${cols[c.key].length}`} on={column === c.key} onPress={() => setColumn(c.key)} />)}
            </ScrollView>
            {cols[column].length === 0 ? <Text style={s.empty}>Nothing here.</Text> : null}
            {column === 'qa' ? <QaColumn features={cols.qa} all={spec!.features} busy={busy}
              onPass={(epicId) => act(`qa:${epicId}`, () => work.passQa(project.base, epicId))}
              render={(f) => <FeatureCard key={f.id} f={f} busy={busy} onOpen={() => open(f)} onDone={() => act(f.id, () => work.markDone(project.base, f.id), () => setCelebrating(f.name))} />} />
              : cols[column].map((f) => <FeatureCard key={f.id} f={f} busy={busy} onOpen={() => open(f)} onDone={() => act(f.id, () => work.markDone(project.base, f.id), () => setCelebrating(f.name))} />)}
          </>
        ) : null}

        {view === 'route' && chart ? (
          <>
            {chart.epics.length === 0 ? <Text style={s.empty}>No epics yet. Plot the route on the dashboard.</Text> : null}
            {chart.epics.map((e, i) => <EpicStop key={e.id} e={e} n={i + 1} today={chart.today} busy={busy}
              onOpen={open} onPass={() => act(`qa:${e.id}`, () => work.passQa(project.base, e.id))}
              onStartNext={() => { const f = e.features.find((x) => x.id === e.nextUp); if (f) open(f); }} />)}
            {chart.unassigned.length > 0 ? (
              <Card>
                <Text style={s.kicker}>IN NO EPIC</Text>
                <View style={s.chips}>{chart.unassigned.map((f) => <Chip key={f.id} label={f.name} onPress={() => open(f)} />)}</View>
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <Celebrate name={celebrating} onDone={() => setCelebrating(null)} />
    </View>
  );
}

const STATUS: Record<string, { label: string; color: string } | undefined> = {
  paused: { label: 'needs a decision', color: theme.ember },
  delivered: { label: 'awaiting sign-off', color: theme.ember },
  'in-progress': { label: 'under way', color: theme.accent },
};

function FeatureCard({ f, busy, onOpen, onDone }: { f: SpecFeature; busy: string; onOpen: () => void; onDone: () => void }) {
  const st = STATUS[f.status];
  return (
    <Card onPress={onOpen} accent={st?.color === theme.ember ? theme.ember : undefined}>
      <Text style={s.fname}>{f.name}</Text>
      {f.intent?.summary ? <Text style={s.summary} numberOfLines={2}>{f.intent.summary}</Text> : null}
      <View style={s.tags}>
        {st ? <Text style={[s.tag, { color: st.color, borderColor: st.color }]}>{st.label}</Text> : null}
        {waitsOnEpicQa(f) ? <Text style={[s.tag, s.tagQa]}>waiting for epic QA</Text> : null}
        {f.targetDate && f.status !== 'done' ? <Text style={s.tag}>due {f.targetDate.slice(5)}</Text> : null}
        {f.criteria?.length ? <Text style={s.tag}>{f.criteriaMet}/{f.criteria.length} criteria</Text> : null}
      </View>
      {f.status === 'delivered' ? <View style={s.actions}><PrimaryButton label={busy === f.id ? 'Working…' : 'Mark done'} disabled={!!busy} onPress={onDone} /></View> : null}
    </Card>
  );
}

function QaColumn({ features, all, busy, onPass, render }: { features: SpecFeature[]; all: SpecFeature[]; busy: string; onPass: (epicId: string) => void; render: (f: SpecFeature) => React.ReactNode }) {
  const loose = features.filter((f) => !waitsOnEpicQa(f));
  const epics = [...new Map(features.filter(waitsOnEpicQa).map((f) => [f.epicId ?? '', f.epicName ?? ''])).entries()];
  return (
    <>
      {loose.map(render)}
      {epics.map(([epicId, epicName]) => {
        const mine = features.filter((f) => waitsOnEpicQa(f) && f.epicId === epicId);
        const left = all.filter((x) => x.epicId === epicId && x.status !== 'done' && x.status !== 'existing').length;
        const ready = mine[0]?.epicQa === 'waiting';
        return (
          <View key={epicId} style={s.qaGroup}>
            <CardTop>
              <Text style={s.qaName} numberOfLines={1}>🧪 {epicName}</Text>
              <ActionButton label={busy === `qa:${epicId}` ? 'Working…' : 'Passed QA ✓'} tone="accent" disabled={!ready || !!busy} onPress={() => onPass(epicId)} />
            </CardTop>
            {!ready ? <Text style={s.left}>{left} feature{left === 1 ? '' : 's'} still to finish</Text> : null}
            {mine.map(render)}
          </View>
        );
      })}
    </>
  );
}

function EpicStop({ e, n, today, busy, onOpen, onPass, onStartNext }: { e: RoadmapEpic; n: number; today: string; busy: string; onOpen: (f: { id: string; name: string }) => void; onPass: () => void; onStartNext: () => void }) {
  const date = epicDate(e, today);
  const tone = date?.tone === 'late' ? theme.ember : date?.tone === 'commend' ? theme.warnSoft : date?.tone === 'done' ? theme.success : theme.accentSoft;
  const live = e.features.some((f) => f.state === 'under-way');
  const edge = e.deliveredAt ? theme.success : (e.blockedBy?.length ?? 0) > 0 ? theme.textFaint : e.late ? theme.ember : live ? theme.accent : undefined;
  return (
    <Card accent={edge}>
      <CardTop>
        <Text style={s.epicNo}>EPIC {n}</Text>
        {date ? <Text style={[s.tag, { color: tone, borderColor: tone }]}>{date.text}</Text> : null}
      </CardTop>
      <Text style={s.fname}>{e.name}</Text>
      {e.outcome ? <Text style={s.summary} numberOfLines={2}>{e.outcome}</Text> : null}
      <Meter fraction={e.progress.total ? e.progress.done / e.progress.total : 0} style={s.meter} color={e.deliveredAt ? theme.success : theme.accent} />
      <Text style={s.left}>{e.progress.done}/{e.progress.total} features{(e.blockedBy?.length ?? 0) > 0 ? '  ·  waits on another epic' : ''}</Text>
      {e.qa === 'waiting' && e.qaRun?.blockedReason ? <Text style={s.blocked}>{e.qaRun.blockedReason}</Text> : null}
      <View style={s.chips}>{e.features.map((f) => <Chip key={f.id} label={f.name} on={f.state === 'under-way'} onPress={() => onOpen(f)} />)}</View>
      <View style={s.actions}>
        {e.qa === 'waiting' ? <PrimaryButton label={busy === `qa:${e.id}` ? 'Working…' : 'Passed QA ✓'} disabled={!!busy || !!e.qaRun?.blockedReason} onPress={onPass} /> : null}
        {e.qa === 'passed' ? <Text style={[s.tag, s.tagOk]}>✓ QA passed</Text> : null}
        {e.nextUp ? <ActionButton label="Start next ▸" tone="accent" onPress={onStartNext} /> : null}
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  top: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  back: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  content: { paddingBottom: 32 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginHorizontal: 12, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgCard },
  headSide: { flex: 1, gap: 6, paddingBottom: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: theme.text, fontSize: 20, fontWeight: '700', flexShrink: 1 },
  vision: { color: theme.textDim, fontSize: 13, lineHeight: 18 },
  segment: { flexDirection: 'row', margin: 12, padding: 3, borderRadius: 12, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgWell },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  segOn: { backgroundColor: theme.accentTint },
  segText: { color: theme.textDim, fontSize: 14, fontWeight: '700', letterSpacing: 0.6 },
  segTextOn: { color: theme.accentSoft },
  spin: { marginTop: 20 },
  err: { color: theme.dangerSoft, fontSize: 12, marginHorizontal: 16, marginBottom: 6 },
  columns: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  empty: { color: theme.textDim, fontSize: 14, marginHorizontal: 16, marginTop: 8 },
  fname: { color: theme.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  summary: { color: theme.textDim, fontSize: 13, marginTop: 4, lineHeight: 18 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  tag: { color: theme.textDim, fontSize: 11, borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  tagQa: { color: theme.accentSoft, borderColor: theme.accentSoft },
  tagOk: { color: theme.success, borderColor: theme.successEdge },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' },
  qaGroup: { marginHorizontal: 12, marginBottom: 10, padding: 10, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.accentSoft, gap: 4 },
  qaName: { color: theme.accentSoft, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  left: { color: theme.textFaint, fontSize: 12, marginTop: 6 },
  blocked: { color: theme.warnSoft, fontSize: 12, marginTop: 6 },
  epicNo: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  kicker: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  meter: { marginTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
});
