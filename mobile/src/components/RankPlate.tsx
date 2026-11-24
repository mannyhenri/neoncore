import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../theme';
import type { ProjectRewards } from '../work';

/** The project's captain's rank: five stars, one lit per rank reached, and the title (dashboard bridge/rank.tsx). */
export function RankPlate({ rank }: { rank: NonNullable<ProjectRewards['rank']> }) {
  return (
    <View style={s.plate} accessibilityLabel={`${rank.title}: ${rank.commendations} commendation${rank.commendations === 1 ? '' : 's'}`}>
      <Text style={s.stars}>{[0, 1, 2, 3, 4].map((i) => (i <= rank.index ? '★' : '☆')).join('')}</Text>
      <Text style={s.title}>{rank.title.toUpperCase()}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  plate: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: theme.warnSoft, backgroundColor: theme.emberTint, alignSelf: 'flex-start' },
  stars: { color: theme.warnSoft, fontSize: 11, letterSpacing: 1 },
  title: { color: theme.warnSoft, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
});
