import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet, Modal } from 'react-native';
import { theme } from '../theme';

/** Fireworks on the phone: a feature was marked done (the dashboard's components/Fireworks.tsx). */
const SPARKS = 16;
const COLOURS = [theme.accent, theme.success, theme.warnSoft, theme.ember, theme.accentSoft];

export function Celebrate({ name, onDone }: { name: string | null; onDone: () => void }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!name) return undefined;
    t.setValue(0);
    Animated.timing(t, { toValue: 1, duration: 1800, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const done = setTimeout(onDone, 3200);
    return () => clearTimeout(done);
  }, [name, t, onDone]);
  if (!name) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDone}>
      <View style={s.night} pointerEvents="none">
        <View style={s.burst}>
          {Array.from({ length: SPARKS }, (_, i) => {
            const a = (i / SPARKS) * Math.PI * 2;
            const d = 110 + (i % 3) * 30;
            return (
              <Animated.View key={i} style={[s.spark, { backgroundColor: COLOURS[i % COLOURS.length], opacity: t.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] }),
                transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(a) * d] }) }, { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(a) * d + 30] }) }] }]} />
            );
          })}
        </View>
        <View style={s.banner}>
          <Text style={s.kicker}>✦ FEATURE COMPLETE ✦</Text>
          <Text style={s.name} numberOfLines={2}>{name}</Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  night: { flex: 1, backgroundColor: theme.scrim, alignItems: 'center', justifyContent: 'center' },
  burst: { position: 'absolute', top: '38%', left: '50%' },
  spark: { position: 'absolute', width: 10, height: 10, borderRadius: 5, marginLeft: -5, marginTop: -5 },
  banner: { marginTop: 220, paddingHorizontal: 22, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: theme.warnSoft, backgroundColor: theme.bgElevated, alignItems: 'center', maxWidth: '86%' },
  kicker: { color: theme.warnSoft, fontSize: 12, fontWeight: '800', letterSpacing: 2.4 },
  name: { color: theme.text, fontSize: 20, fontWeight: '700', marginTop: 4, textAlign: 'center' },
});
