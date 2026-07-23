import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { theme } from '../theme';

/**
 * App brand bar — mirrors the web dashboard header: the Gridlight logo, the "NeonCore"
 * wordmark (Neon in blue, Core in pink), and an ORCHESTRATOR pill.
 *
 * Uses a heavy system font rather than a bundled pixel typeface: loading a custom font at
 * startup pulled in the expo-font loader on the launch path, which was implicated in a
 * launch crash on a fresh build. Keeping this dependency-free makes the header safe to ship.
 */
export function BrandHeader() {
  return (
    <View style={styles.bar}>
      <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
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
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  pillText: { color: theme.textFaint, fontSize: 8, fontWeight: '700', letterSpacing: 0.7 },
});
