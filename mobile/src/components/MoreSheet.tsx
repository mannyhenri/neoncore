import React from 'react';
import { View, Text, Modal, Pressable, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import type { TabName } from './TabBar';

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

/**
 * The destinations that did not fit in the bar.
 *
 * A SHEET, NOT AN OVERFLOW MENU. TabBar.tsx already records what this app learned once: "a
 * destination you cannot see is a destination nobody uses" — Workflows was unlabelled emoji in
 * a list header and was effectively undiscoverable. Moving three destinations behind a tap
 * risks repeating exactly that, so each row here is a full-width label WITH a hint saying what
 * it is for. A dense icon grid would have saved space nobody needed and re-created the problem.
 *
 * Tapping the backdrop closes without navigating: opening More is not a decision, and it must
 * not cost you your place.
 */
export function MoreSheet({
  open, active, items, onSelect, onClose,
}: {
  open: boolean;
  active: TabName;
  items: { name: TabName; Icon: IconCmp; label: string; hint: string }[];
  onSelect: (t: TabName) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* The backdrop is the primary dismiss. `onRequestClose` covers Android back. */}
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        {items.map((it) => {
          const on = it.name === active;
          const { Icon } = it;
          return (
            <TouchableOpacity
              key={it.name}
              style={[styles.row, on && styles.rowOn]}
              onPress={() => onSelect(it.name)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Icon size={22} color={on ? theme.accent : theme.textDim} strokeWidth={on ? 2 : 1.5} />
              <View style={styles.rowText}>
                <Text style={[styles.label, on && { color: theme.accent }]}>{it.label}</Text>
                <Text style={styles.hint}>{it.hint}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 18 }} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  grabber: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border,
    alignSelf: 'center', marginBottom: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 8, borderRadius: 10 },
  rowOn: { backgroundColor: theme.accentSoft },
  rowText: { flex: 1 },
  label: { color: theme.text, fontSize: 15, fontWeight: '600' },
  hint: { color: theme.textFaint, fontSize: 11, marginTop: 2 },
});
