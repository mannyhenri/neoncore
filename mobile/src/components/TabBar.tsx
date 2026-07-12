import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';

export type TabName = 'list' | 'workflows' | 'approvals';

const TABS: { name: TabName; icon: string; label: string }[] = [
  { name: 'list', icon: '▣', label: 'Cartridges' },
  { name: 'workflows', icon: '⚡', label: 'Workflows' },
  { name: 'approvals', icon: '🔔', label: 'Approvals' },
];

/**
 * The app's three top-level destinations. These were previously unlabeled emoji
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
        return (
          <TouchableOpacity key={t.name} style={styles.tab} onPress={() => onSelect(t.name)}>
            <View>
              <Text style={[styles.icon, on && styles.iconActive]}>{t.icon}</Text>
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
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  icon: { fontSize: 18, color: theme.textFaint },
  iconActive: { color: theme.accent },
  label: { fontSize: 11, color: theme.textFaint, fontWeight: '600' },
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
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
