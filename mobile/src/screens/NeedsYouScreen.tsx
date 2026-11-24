import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, Alert } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { api } from '../api';
import { useFleetData } from '../useFleetData';
import { work, NEEDS, type NeedsYouItem, type Project } from '../work';
import { Card, CardTop, Chip, ActionButton, PrimaryButton, useAdaptiveContent } from '../components/ui';
import { PermissionCard, type DecideFn } from '../components/PermissionCard';
import { Sprite } from '../world/Sprite';
import { DECK_ART } from '../world/art.generated';
import { Celebrate } from '../components/Celebrate';

export interface FeatureRef { base: string; goalId: string; name: string; projectId?: string }

/**
 * NEEDS YOU — the home screen: everything waiting on the person, on every server, from state
 * (server lib/needs-you.ts) plus the agents' permission requests. Each card says what it is, for
 * which feature of which project, how long it has waited — and offers the one thing to do about
 * it right here when the phone can (accept a plan, approve tests, resume, mark done…); otherwise
 * it opens the feature.
 */
export function NeedsYouScreen({ onOpenFeature, onOpenRun }: { onOpenFeature: (f: FeatureRef) => void; onOpenRun: (base: string, workflowId: string) => void }) {
  const { permissions, agents, refresh: refreshFleet, urlForPermission } = useNeonCore();
  const { results, loading, refresh } = useFleetData(async (base) => {
    const [items, projects] = await Promise.all([work.needsYou(base), work.projects(base).catch(() => [] as Project[])]);
    return { items, projects };
  }, [], 12_000);
  const adaptive = useAdaptiveContent();
  const [busy, setBusy] = useState('');
  const [celebrating, setCelebrating] = useState<string | null>(null);

  const items = results.flatMap((r) => (r.data?.items ?? []).map((it) => ({ ...it, base: r.base, project: r.data?.projects.find((p) => p.id === it.projectId) })))
    .sort((a, b) => a.since.localeCompare(b.since));
  const failed = results.filter((r) => r.error);
  const count = items.length + permissions.length;

  const act = useCallback(async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    try { await fn(); after?.(); } catch (e) { Alert.alert('Not done', e instanceof Error ? e.message.replace(/^\d+ [^—]*— /, '') : String(e)); } finally { setBusy(''); void refresh(); }
  }, [refresh]);

  const decide: DecideFn = async (id, decision, response) => {
    await api.decidePermission(urlForPermission(id), id, decision, response);
    await refreshFleet();
  };

  const primary = (it: NeedsYouItem & { base: string }) => {
    const open = () => onOpenFeature({ base: it.base, goalId: it.goalId, name: it.title, projectId: it.projectId });
    switch (it.kind) {
      case 'plan': return () => act(it.key, () => work.acceptPlan(it.base, it.pilotId));
      case 'tests': return () => act(it.key, () => work.approveTests(it.base, it.pilotId));
      case 'stopped': return () => act(it.key, () => work.resume(it.base, it.pilotId));
      case 'merge-blocked': return () => act(it.key, () => work.merge(it.base, it.pilotId));
      case 'mark-done': return () => act(it.key, () => work.markDone(it.base, it.goalId), () => setCelebrating(it.title));
      case 'run': return () => onOpenRun(it.base, it.workflowId);
      case 'questions': case 'start': return open;
      default: return null;
    }
  };

  const captain = DECK_ART.captain;
  return (
    <>
      <ScrollView style={s.page} contentContainerStyle={[s.content, adaptive]}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void refresh(); void refreshFleet(); }} tintColor={theme.accent} />}>
        <View style={[s.bridge, count > 0 ? s.bridgeCall : null]}>
          {captain ? <Sprite art={captain} anim={count > 0 ? 'call' : 'idle'} height={92} fps={count > 0 ? 6 : 3} /> : null}
          <View style={s.bridgeSide}>
            <Text style={s.kicker}>THE BRIDGE</Text>
            <Text style={s.headline}>{loading ? 'Checking…' : count === 0 ? 'Nothing waits on you.' : `${count} thing${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`}</Text>
            <Text style={s.sub}>{count === 0 && !loading ? 'The crew is working. New asks show up here.' : 'Oldest first — clear them to keep the work moving.'}</Text>
          </View>
        </View>

        {failed.map((r) => <Text key={r.base} style={s.err}>{r.name}: {r.error}</Text>)}

        {permissions.map((p) => (
          <PermissionCard key={p.id} perm={p} agentName={agents.find((a) => a.id === p.agentId)?.name} onDecide={decide} />
        ))}

        {items.map((it) => {
          const go = primary(it);
          const meta = NEEDS[it.kind] ?? { label: it.kind, action: null };
          return (
            <Card key={`${it.base}:${it.key}`} accent={theme.ember} onPress={() => onOpenFeature({ base: it.base, goalId: it.goalId, name: it.title, projectId: it.projectId })}>
              <CardTop>
                <Chip label={meta.label} on />
                <Text style={s.since}>{waited(it.since)}</Text>
              </CardTop>
              <Text style={s.title} numberOfLines={2}>{it.title}</Text>
              {it.project ? (
                <View style={s.projectRow}>
                  <View style={[s.dot, { backgroundColor: it.project.color || theme.accent }]} />
                  <Text style={s.projectName} numberOfLines={1}>{it.project.name}</Text>
                </View>
              ) : null}
              <Text style={s.what}>{it.what}</Text>
              <View style={s.actions}>
                {go && meta.action ? <PrimaryButton label={busy === it.key ? 'Working…' : meta.action} disabled={!!busy} onPress={go} /> : null}
                <ActionButton label="Open" onPress={() => onOpenFeature({ base: it.base, goalId: it.goalId, name: it.title, projectId: it.projectId })} />
              </View>
            </Card>
          );
        })}
      </ScrollView>
      <Celebrate name={celebrating} onDone={() => setCelebrating(null)} />
    </>
  );
}

/** How long something has waited, in a word or two. */
export function waited(since: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (!Number.isFinite(m)) return '';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  content: { paddingBottom: 24 },
  bridge: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, margin: 12, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgCard },
  bridgeCall: { borderColor: theme.emberEdge },
  bridgeSide: { flex: 1, paddingBottom: 6 },
  kicker: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  headline: { color: theme.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
  sub: { color: theme.textDim, fontSize: 13, marginTop: 4 },
  err: { color: theme.dangerSoft, fontSize: 12, marginHorizontal: 16, marginBottom: 6 },
  since: { color: theme.textFaint, fontSize: 12 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  projectRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  projectName: { color: theme.textDim, fontSize: 13 },
  what: { color: theme.textDim, fontSize: 14, marginTop: 8, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
});
