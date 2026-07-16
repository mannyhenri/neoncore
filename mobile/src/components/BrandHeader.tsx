import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { theme } from '../theme';

/**
 * App brand bar — mirrors the web dashboard header: the Gridlight logo, the "NeonCore"
 * wordmark (Neon in blue, Core in pink) in the Press Start 2P pixel font, and an
 * ORCHESTRATOR pill. `pixel` toggles the pixel font once it has finished loading.
 */
export function BrandHeader({ pixel }: { pixel: boolean }) {
  const brandFont = pixel ? { fontFamily: 'PressStart2P_400Regular' } : { fontWeight: '800' as const };
  return (
    <View style={styles.bar}>
      <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={[styles.name, brandFont]}>
        <Text style={{ color: theme.blue }}>Neon</Text>
        <Text style={{ color: theme.pink }}>Core</Text>
      </Text>
      <View style={styles.pill}>
        <Text style={styles.pillText}>ORCHESTRATOR</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  logo: { width: 26, height: 26 },
  // Press Start 2P has a large em box, so it reads bigger than its point size — 11 sits right.
  name: { fontSize: 11, letterSpacing: 0.5 },
  pill: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillText: { color: theme.textFaint, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
});
