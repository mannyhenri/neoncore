import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { CartridgesIcon, WorkflowsIcon, ApprovalsIcon, GoalsIcon, TasksIcon } from './Icons';

export type TabName = 'list' | 'goals' | 'workflows' | 'queue' | 'tasks' | 'approvals';

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

/**
 * Six destinations, ordered why → who → how → what's waiting.
 *
 * Six is the most this bar can hold and still be a bar. Each tab is flex:1, so on a 320pt
 * phone that is ~53pt of width for a label like "Cartridges" — which is why the label
 * below shrinks to fit rather than wrapping or clipping. A seventh would need a "More"
 * pile, and this app has already learned once (see the comment below) that a destination
 * you cannot see is a destination nobody uses.
 */
const TABS: { name: TabName; Icon: IconCmp; label: string }[] = [
  { name: 'list', Icon: CartridgesIcon, label: 'Cartridges' },
  // Goals sit next to cartridges because they answer the question one step up: not which
  // machine is busy, but whether the thing it is busy with is going anywhere.
  { name: 'goals', Icon: GoalsIcon, label: 'Goals' },
  { name: 'workflows', Icon: WorkflowsIcon, label: 'Workflows' },
  // Reuses WorkflowsIcon deliberately rather than inventing a glyph — the queue drives
  // workflows, prompts and confers, and a wrong-looking new icon reads as a different product.
  { name: 'queue', Icon: WorkflowsIcon, label: 'Queue' },
  // Tasks are their own backend (/api/tasks), not queue items, so they get their own tab
  // rather than being folded into Queue — one list holding two different objects with two
  // different action sets is how both stop being trustworthy.
  { name: 'tasks', Icon: TasksIcon, label: 'Tasks' },
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
            {/* Shrink-to-fit rather than wrap or clip: at six tabs the longest label is
                within a few points of the cell on the narrowest supported phone. */}
            <Text
              style={[styles.label, on && styles.labelActive]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              {t.label}
            </Text>
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
