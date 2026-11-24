import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { useFleetData } from '../useFleetData';
import { work } from '../work';
import { ApprovalsIcon, GoalsIcon, CartridgesIcon, PlayIcon, GearIcon } from './Icons';

/**
 * The phone's five destinations. Its job is to keep the work moving on projects already under
 * way, so the bar is built around that: what NEEDS YOU (the home), the PROJECTS (rank, Board,
 * Route, start next), the AGENTS (message any of them), what is IN PROGRESS (features being
 * built), and SETTINGS. Labels shrink to fit the narrowest phone; nothing hides behind "More".
 */
export type TabName = 'needs' | 'projects' | 'agents' | 'progress' | 'settings';

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

export const TABS: { name: TabName; Icon: IconCmp; label: string }[] = [
  { name: 'needs', Icon: ApprovalsIcon, label: 'Needs you' },
  { name: 'projects', Icon: GoalsIcon, label: 'Projects' },
  { name: 'agents', Icon: CartridgesIcon, label: 'Agents' },
  { name: 'progress', Icon: PlayIcon, label: 'In progress' },
  { name: 'settings', Icon: GearIcon, label: 'Settings' },
];

/** The Needs-you badge counts everything waiting on you: the agents' permission requests plus every server's asks. */
export function TabBar({ active, onSelect }: { active: TabName; onSelect: (t: TabName) => void }) {
  const { permissions } = useNeonCore();
  const { results } = useFleetData((base) => work.needsYou(base), [], 30_000);
  const needsCount = results.reduce((n, r) => n + (r.data?.length ?? 0), 0);
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const on = t.name === active;
        const badge = t.name === 'needs' ? permissions.length + needsCount : 0;
        const { Icon } = t;
        return (
          <TouchableOpacity key={t.name} style={styles.tab} onPress={() => onSelect(t.name)} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <View>
              <Icon size={22} color={on ? theme.accent : theme.textFaint} strokeWidth={on ? 2 : 1.5} />
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, on && styles.labelActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bgElevated, paddingTop: 8, paddingBottom: 6, paddingHorizontal: 2 },
  tab: { flex: 1, alignItems: 'center', gap: 2, minWidth: 0 },
  label: { fontSize: 10, color: theme.textFaint, fontWeight: '600' },
  labelActive: { color: theme.accent },
  badge: { position: 'absolute', top: -4, right: -10, backgroundColor: theme.ember, borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: theme.onAccent, fontSize: 11, fontWeight: '700' },
});
