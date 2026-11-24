import React from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { useFleetData } from '../useFleetData';
import { work, stepsEarned, type ActiveFeature, type Project } from '../work';
import { Card, CardTop, ScreenTitle, StatusPill, useAdaptiveContent } from '../components/ui';
import { Badges } from '../components/Badges';
import type { FeatureRef } from './NeedsYouScreen';

/**
 * IN PROGRESS — every feature being built, across every sector (project) and server: the
 * dashboard's banners with their badges, its stage, and whether it waits on you. The agents
 * themselves — to message one — are on the Agents tab (AgentsScreen).
 */
export function InProgressScreen({ onOpenFeature }: { onOpenFeature: (f: FeatureRef) => void }) {
  const { refresh: refreshFleet } = useNeonCore();
  const adaptive = useAdaptiveContent();
  const { results, loading, refresh, many } = useFleetData(async (base) => {
    const [features, projects] = await Promise.all([work.activeFeatures(base), work.projects(base).catch(() => [] as Project[])]);
    return { features, projects };
  }, [], 15_000);

  const rows = results.flatMap((r) => (r.data?.features ?? []).map((f) => ({ f, base: r.base, server: r.name, project: r.data?.projects.find((p) => p.id === f.projectId) })))
    .sort((a, b) => Number(!!b.f.needsYou) - Number(!!a.f.needsYou) || (a.project?.name ?? '').localeCompare(b.project?.name ?? '') || a.f.name.localeCompare(b.f.name));

  return (
    <ScrollView style={s.page} contentContainerStyle={[s.content, adaptive]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void refresh(); void refreshFleet(); }} tintColor={theme.accent} />}>
      <ScreenTitle title="In progress" right={<Text style={s.count}>{rows.length}</Text>} />
      {loading && rows.length === 0 ? <ActivityIndicator color={theme.accent} style={s.spin} /> : null}
      {results.filter((r) => r.error).map((r) => <Text key={r.base} style={s.err}>{r.name}: {r.error}</Text>)}
      {!loading && rows.length === 0 ? <Text style={s.empty}>No feature is being built right now. Start the next one from a project's Route.</Text> : null}
      {rows.map(({ f, base, server, project }) => (
        <Banner key={`${base}:${f.pilotId}`} f={f} base={base} project={project} server={many ? server : ''}
          onPress={() => onOpenFeature({ base, goalId: f.goalId, name: f.name, projectId: f.projectId })} />
      ))}

    </ScrollView>
  );
}

/** One feature's banner: its project's colour, name, stage and badges — as on the dashboard's HUD. */
function Banner({ f, base, project, server, onPress }: { f: ActiveFeature; base: string; project?: Project; server: string; onPress: () => void }) {
  const color = project?.color || theme.accent;
  return (
    <Card onPress={onPress} accent={f.needsYou ? theme.ember : color}>
      <Text style={s.sector} numberOfLines={1}>{(project?.name ?? 'No project').toUpperCase()}{server ? `  ·  ${server}` : ''}</Text>
      <Text style={s.name} numberOfLines={2}>{f.name}</Text>
      <View style={s.row}>
        <Badges base={base} earned={stepsEarned(f.phase)} size={20} />
        {f.stage ? <Text style={s.stage} numberOfLines={1}>Stage {f.stage.position}/{f.stage.total}</Text> : null}
      </View>
      {f.stage?.title ? <Text style={s.faint} numberOfLines={1}>{f.stage.title}</Text> : null}
      {f.needsYou ? <Text style={s.needs}>Needs you · {f.needsYou}</Text> : null}
      {f.branch ? <Text style={s.branch} numberOfLines={1}>⎇ {f.branch}</Text> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  content: { paddingBottom: 24 },
  count: { color: theme.accentSoft, fontSize: 15, fontWeight: '700' },
  spin: { marginTop: 24 },
  err: { color: theme.dangerSoft, fontSize: 12, marginHorizontal: 16, marginBottom: 6 },
  empty: { color: theme.textDim, fontSize: 14, marginHorizontal: 16, marginVertical: 8 },
  sector: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  name: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 },
  stage: { color: theme.accentSoft, fontSize: 12, fontWeight: '700' },
  faint: { color: theme.textFaint, fontSize: 12, marginTop: 4 },
  needs: { color: theme.ember, fontSize: 13, fontWeight: '700', marginTop: 8 },
  branch: { color: theme.textFaint, fontSize: 11, marginTop: 6 },
});
