import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { BADGES, badgeUrl } from '../work';

/**
 * A feature's seven badges — one per step of its pipeline, lit once passed (the dashboard's
 * banners, world/milestones.ts). The pictures come from the server, so a custom theme shows here too.
 */
export function Badges({ base, earned, size = 18 }: { base: string; earned: number; size?: number }) {
  return (
    <View style={s.row} accessibilityLabel={`${earned} of ${BADGES.length} steps passed`}>
      {BADGES.map((b, i) => (
        <Image key={b.step} source={{ uri: badgeUrl(base, b.sprite) }} accessibilityLabel={i < earned ? b.label : undefined}
          style={[{ width: size, height: size }, i < earned ? null : s.unearned]} resizeMode="contain" />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  unearned: { opacity: 0.2 },
});
