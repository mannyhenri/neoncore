import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { CartridgesIcon, WorkflowsIcon, ApprovalsIcon } from './Icons';

export type TabName = 'list' | 'workflows' | 'queue' | 'approvals';

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

const TABS: { name: TabName; Icon: IconCmp; label: string }[] = [
  { name: 'list', Icon: CartridgesIcon, label: 'Cartridges' },
  { name: 'workflows', Icon: WorkflowsIcon, label: 'Workflows' },
  // Reuses WorkflowsIcon deliberately rather than inventing a glyph — the queue drives
  // workflows, prompts and confers, and a wrong-looking new icon reads as a different product.
  { name: 'queue', Icon: WorkflowsIcon, label: 'Queue' },
  // No global Memory tab: memory belongs to a CARTRIDGE and is opened from its detail screen,
  // exactly as the web opens ProjectMemoryPanel from a cartridge card. A global tab made the
  // phone ask which repo, when the cartridge you tapped already answered that.
  { name: 'approvals', Icon: ApprovalsIcon, label: 'Approvals' },
];

/**
 * The app's top-level destinations. These were previously unlabeled emoji
 * tucked into the list header, which made Workflows effectively undiscoverable.
 */
export function TabBar({
  active,
  onSelect,
}: {
  active: TabName;
  onSelect: (t: TabName) => void;
}) {
  const { permissions } = useNeonCore();

  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const on = t.name === active;
        const badge = t.name === 'approvals' ? permissions.length : 0;
        const { Icon } = t;
        return (
          <TouchableOpacity key={t.name} style={styles.tab} onPress={() => onSelect(t.name)}>
            <View>
              <Icon size={22} color={on ? theme.accent : theme.textFaint} strokeWidth={on ? 2 : 1.5} />
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, on && styles.labelActive]}>{t.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.bgElevated,
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 2,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, minWidth: 0 },
  label: { fontSize: 10, color: theme.textFaint, fontWeight: '600' },
  labelActive: { color: theme.accent },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    backgroundColor: theme.pink,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: theme.onAccent, fontSize: 11, fontWeight: '700' },
});
