import React, { useState } from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { theme, glow } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { FleetSheet } from './FleetSheet';

/** The app's mark: the captain in his neon ring — the same picture as the app icon and launch screen. */
const MARK = require('../../assets/brand/captain-mark.png');

/**
 * App brand bar — Night Glass, like the dashboard: the captain's mark, the name in one colour,
 * and the fleet pill, which glows neon when every server is up. No gradient.
 *
 * A heavy system font rather than a bundled typeface: loading a custom font at startup pulled in
 * a font loader on the launch path, which was implicated in a launch crash on a fresh build.
 */
export function BrandHeader() {
  const { serverStatuses } = useNeonCore();
  const [fleetOpen, setFleetOpen] = useState(false);

  const up = serverStatuses.filter((s) => s.reachable).length;
  const total = serverStatuses.length;
  const anyAuthFailed = serverStatuses.some((s) => s.authFailed);
  // Ember for a rejected token, neon when everything is up, faint otherwise. A token
  // problem must not look like the ordinary "a laptop is asleep" state.
  const pillColor = anyAuthFailed ? theme.ember : up === total && total > 0 ? theme.accent : theme.textFaint;

  return (
    <View style={styles.bar}>
      <Image source={MARK} style={styles.mark} accessibilityIgnoresInvertColors />
      <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>NeonCore</Text>
      {/* Fleet status doubles as the way in to managing servers — with more than one
          machine the interesting failure is partial (three up, one asleep), which a single
          global indicator cannot express. */}
      <TouchableOpacity style={[styles.pill, { borderColor: pillColor }]} onPress={() => setFleetOpen(true)}>
        <View style={[styles.pillDot, { backgroundColor: pillColor }, pillColor === theme.accent ? glow() : null]} />
        <Text style={[styles.pillText, { color: pillColor }]}>
          {total <= 1 ? 'ORCHESTRATOR' : `${up}/${total} SERVERS`}
        </Text>
      </TouchableOpacity>
      <FleetSheet visible={fleetOpen} onClose={() => setFleetOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: theme.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  mark: { width: 28, height: 28 },
  name: { color: theme.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.5, flexShrink: 1 },
  pill: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  pillDot: { width: 5, height: 5, borderRadius: 2.5 },
  pillText: { color: theme.textFaint, fontSize: 8, fontWeight: '700', letterSpacing: 0.7 },
});
