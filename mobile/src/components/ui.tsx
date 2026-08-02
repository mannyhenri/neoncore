/**
 * The shared visual language of the mobile app, in one file.
 *
 * These are not new designs. They are the idioms the cartridge list already used — a bordered
 * card, a status pill with a dot, an uppercase chip — extracted so a screen can USE them instead
 * of retyping the numbers. That distinction is the whole point: the queue and memory screens
 * looked wrong not because anyone chose differently, but because there was nothing to conform to,
 * so each one re-derived padding, radius and colour from scratch and drifted.
 *
 * mobile-design-system.test.ts asserts every screen imports from here rather than hand-rolling,
 * which is what keeps the tenth screen from inventing an eleventh red.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, type ViewStyle, type StyleProp } from 'react-native';
import { theme } from '../theme';
import { useResponsive } from '../responsive';

/**
 * Centres content and stops it stretching on a wide window.
 *
 * Wrap anything that would otherwise run the full width of an iPad. On a phone this is a no-op,
 * so screens do not need two code paths — which matters, because a second path is a second thing
 * to forget to update.
 */
export function Adaptive({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { contentMaxWidth } = useResponsive();
  return <View style={[s.adaptive, { maxWidth: contentMaxWidth }, style]}>{children}</View>;
}

/** The same cap, as a style — for FlatList contentContainerStyle, which cannot take a component. */
export function useAdaptiveContent(): ViewStyle {
  const { contentMaxWidth } = useResponsive();
  return { width: '100%', maxWidth: contentMaxWidth, alignSelf: 'center' };
}

/**
 * The standard surface for one item in a list.
 *
 * A card, not a divider row. The queue used `borderBottomWidth` and read as a wall of text next
 * to the cartridge list's cards; the border and the margin are what make a row an object you can
 * point at. `accent` tints the left edge for rows that need attention without shouting.
 */
export function Card({
  children, onPress, accent, style, grid,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  accent?: string;
  style?: StyleProp<ViewStyle>;
  /** Set on cards rendered as FlatList items so they share a row evenly when columns > 1. */
  grid?: boolean;
}) {
  const { columns: gridColumns } = useResponsive();
  const body = (
    <View style={[s.card, accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : null, style]}>
      {children}
    </View>
  );
  // In a multi-column list a cell claims a FIXED share of the row, not flex:1.
  //
  // flex:1 looks right until the item count is odd: the last row holds one card, which then
  // expands to the full width and reads as a different, more important card. A fixed share
  // leaves the odd one the same size as every other. Read from the hook rather than a prop so
  // callers cannot pass a column count that disagrees with the list's own numColumns.
  const outer: StyleProp<ViewStyle> = grid
    ? [s.gridCell, { width: `${100 / Math.max(1, gridColumns)}%` as const }]
    : null;
  if (!onPress) return grid ? <View style={outer}>{body}</View> : body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [outer, pressed ? s.pressed : null]}>
      {body}
    </Pressable>
  );
}

/** Top row of a card: title on the left, chips and pills trailing. */
export function CardTop({ children }: { children: React.ReactNode }) {
  return <View style={s.cardTop}>{children}</View>;
}

/**
 * State, rendered the way every other screen renders state: a bordered pill with a dot.
 *
 * The queue printed a bare coloured word. Colour alone is not a status — it carries no shape for
 * someone scanning, and it is invisible to anyone who cannot separate those hues.
 */
export function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[s.pill, { borderColor: color }]}>
      <View style={[s.pillDot, { backgroundColor: color }]} />
      <Text style={[s.pillText, { color }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

/** A small uppercase tag — a kind, a type, a filter. `on` marks the selected one. */
export function Chip({
  label, on, onPress,
}: { label: string; on?: boolean; onPress?: () => void }) {
  const body = (
    <View style={[s.chip, on ? s.chipOn : null]}>
      <Text style={[s.chipText, on ? s.chipTextOn : null]}>{label.toUpperCase()}</Text>
    </View>
  );
  if (!onPress) return body;
  return <Pressable onPress={onPress}>{body}</Pressable>;
}

/**
 * A tappable action.
 *
 * The queue's actions were bare text — `cancel`, `retry`, `clear` — with no border and no target
 * beyond the glyphs themselves. On a phone that is both hard to read as a control and hard to
 * hit; `minHeight` here is the tap target, not decoration.
 */
export function ActionButton({
  label, onPress, tone = 'neutral', disabled, fill,
}: {
  label: string;
  onPress: () => void;
  tone?: 'neutral' | 'accent' | 'danger';
  disabled?: boolean;
  fill?: boolean;
}) {
  const color = tone === 'danger' ? theme.danger : tone === 'accent' ? theme.accentSoft : theme.textDim;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        { borderColor: color },
        fill ? { flex: 1 } : null,
        disabled ? s.btnOff : null,
        pressed ? s.pressed : null,
      ]}
    >
      <Text style={[s.btnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** A filled primary action — the one thing a screen most wants you to do. */
export function PrimaryButton({
  label, onPress, disabled,
}: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.primary, disabled ? s.btnOff : null, pressed ? s.pressed : null]}
    >
      <Text style={s.primaryText}>{label}</Text>
    </Pressable>
  );
}

/** The one way a screen titles itself, with optional trailing content. */
export function ScreenTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={s.titleRow}>
      <Text style={s.title}>{title}</Text>
      {right}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.bgCard,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 12,
    marginVertical: 6,
  },
  pressed: { opacity: 0.7 },
  // minWidth:0 lets a long unbroken string shrink instead of forcing its column wider.
  gridCell: { minWidth: 0 },
  adaptive: { width: '100%', alignSelf: 'center' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  chip: {
    backgroundColor: theme.bgElevated,
    borderWidth: 1, borderColor: theme.border,
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  chipTextOn: { color: theme.onAccent },

  btn: {
    borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, minHeight: 34,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.bgElevated,
  },
  btnOff: { opacity: 0.4 },
  btnText: { fontSize: 12, fontWeight: '700' },

  primary: {
    backgroundColor: theme.accent, borderRadius: 10,
    paddingHorizontal: 14, minHeight: 38,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: theme.onAccent, fontSize: 13, fontWeight: '700' },

  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  title: { color: theme.text, ...theme.screenTitle },
});
