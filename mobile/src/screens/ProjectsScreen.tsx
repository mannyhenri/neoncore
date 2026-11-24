import React from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { theme } from '../theme';
import { useFleetData } from '../useFleetData';
import { work, type Project, type ProjectRewards } from '../work';
import { Card, CardTop, Meter, ScreenTitle, useAdaptiveContent } from '../components/ui';
import { useResponsive, gridProps, gridKey } from '../responsive';
import { RankPlate } from '../components/RankPlate';

export interface ProjectRef { base: string; id: string; name: string; color: string }

/**
 * PROJECTS — every project on every server: its captain's rank, how far its features are, and
 * what is under way or waiting on you. Open one for its Board and its Route.
 */
export function ProjectsScreen({ onOpen }: { onOpen: (p: ProjectRef) => void }) {
  const { results, loading, refresh, many } = useFleetData(async (base) => {
    const projects = await work.projects(base);
    const rewards = await Promise.allSettled(projects.map((p) => work.rewards(base, p.id)));
    return projects.map((p, i) => ({ p, rank: rewards[i].status === 'fulfilled' ? (rewards[i] as PromiseFulfilledResult<ProjectRewards>).value.rank ?? null : null }));
  }, [], 30_000);

  const rows = results.flatMap((r) => (r.data ?? []).map((x) => ({ ...x, base: r.base, server: r.name })))
    .sort((a, b) => (b.p.featuresNeedYou ?? 0) - (a.p.featuresNeedYou ?? 0) || (b.p.featuresActive ?? 0) - (a.p.featuresActive ?? 0) || a.p.name.localeCompare(b.p.name));

  const { columns } = useResponsive();
  const adaptive = useAdaptiveContent();
  return (
    <FlatList
      style={s.page}
      // A wide window shows two columns; the key remounts the list when that changes (rotation).
      key={gridKey(columns)}
      {...gridProps(columns)}
      contentContainerStyle={[s.content, adaptive]}
      data={rows}
      keyExtractor={(r) => `${r.base}:${r.p.id}`}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} tintColor={theme.accent} />}
      ListHeaderComponent={(
        <>
          <ScreenTitle title="Projects" />
          {loading && rows.length === 0 ? <ActivityIndicator color={theme.accent} style={s.spin} /> : null}
          {results.filter((r) => r.error).map((r) => <Text key={r.base} style={s.err}>{r.name}: {r.error}</Text>)}
          {!loading && rows.length === 0 && results.every((r) => !r.error) ? <Text style={s.empty}>No projects yet. Create one on the dashboard.</Text> : null}
        </>
      )}
      renderItem={({ item: { p, rank, base, server } }) => (
        <ProjectCard p={p} rank={rank} server={many ? server : ''} grid={columns > 1} onPress={() => onOpen({ base, id: p.id, name: p.name, color: p.color })} />
      )}
    />
  );
}

function ProjectCard({ p, rank, server, grid, onPress }: { p: Project; rank: ProjectRewards['rank'] | null; server: string; grid?: boolean; onPress: () => void }) {
  const total = p.featureCount ?? 0;
  const done = p.featuresDone ?? 0;
  const need = p.featuresNeedYou ?? 0;
  const active = p.featuresActive ?? 0;
  return (
    <Card onPress={onPress} grid={grid} accent={need > 0 ? theme.ember : undefined}>
      <CardTop>
        <View style={s.nameRow}>
          <View style={[s.dot, { backgroundColor: p.color || theme.accent }]} />
          <Text style={s.name} numberOfLines={1}>{p.name}</Text>
        </View>
        {rank ? <RankPlate rank={rank} /> : null}
      </CardTop>
      {total > 0 ? <Meter fraction={done / total} style={s.meter} /> : null}
      <Text style={s.facts}>
        {done}/{total} features done
        {active > 0 ? <Text style={s.live}>{`  ·  ${active} under way`}</Text> : null}
        {need > 0 ? <Text style={s.need}>{`  ·  ${need} need${need === 1 ? 's' : ''} you`}</Text> : null}
      </Text>
      {server ? <Text style={s.server}>{server}</Text> : null}
    </Card>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  content: { paddingBottom: 24 },
  spin: { marginTop: 24 },
  err: { color: theme.dangerSoft, fontSize: 12, marginHorizontal: 16, marginBottom: 6 },
  empty: { color: theme.textDim, fontSize: 14, marginHorizontal: 16, marginTop: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: theme.text, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  meter: { marginTop: 10 },
  facts: { color: theme.textDim, fontSize: 13, marginTop: 8 },
  live: { color: theme.accentSoft },
  need: { color: theme.ember, fontWeight: '700' },
  server: { color: theme.textFaint, fontSize: 11, marginTop: 4 },
});
