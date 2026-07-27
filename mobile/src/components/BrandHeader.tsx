import React, { useState } from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { FleetSheet } from './FleetSheet';

/**
 * App brand bar — mirrors the web dashboard header: the Gridlight logo, the "NeonCore"
 * wordmark (Neon in blue, Core in pink), and an ORCHESTRATOR pill.
 *
 * Uses a heavy system font rather than a bundled pixel typeface: loading a custom font at
 * startup pulled in the expo-font loader on the launch path, which was implicated in a
 * launch crash on a fresh build. Keeping this dependency-free makes the header safe to ship.
 */
export function BrandHeader() {
  const { serverStatuses } = useNeonCore();
  const [fleetOpen, setFleetOpen] = useState(false);

  const up = serverStatuses.filter((s) => s.reachable).length;
  const total = serverStatuses.length;
  const anyAuthFailed = serverStatuses.some((s) => s.authFailed);
  // Amber for a rejected token, violet when everything is up, faint otherwise. A token
  // problem must not look like the ordinary "a laptop is asleep" state.
  const pillColor = anyAuthFailed ? theme.amber : up === total && total > 0 ? theme.accent : theme.textFaint;

  return (
    <View style={styles.bar}>
      <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
        <Text style={{ color: theme.blue }}>Neon</Text>
        <Text style={{ color: theme.pink }}>Core</Text>
      </Text>
      {/* Fleet status doubles as the way in to managing servers — with more than one
          machine the interesting failure is partial (three up, one asleep), which a single
          global indicator cannot express. */}
      <TouchableOpacity style={[styles.pill, { borderColor: pillColor }]} onPress={() => setFleetOpen(true)}>
        <View style={[styles.pillDot, { backgroundColor: pillColor }]} />
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
  logo: { width: 24, height: 24 },
  name: { fontSize: 17, fontWeight: '800', letterSpacing: 0.5, flexShrink: 1 },
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
