import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { CartridgesIcon, WorkflowsIcon, ApprovalsIcon, GoalsIcon, TasksIcon, MoreIcon, TokensIcon } from './Icons';

export type TabName = 'list' | 'goals' | 'workflows' | 'queue' | 'tasks' | 'approvals' | 'tokens';

/** The five that live in the bar. Everything else reaches the user through More. */
export type PrimaryTab = 'list' | 'workflows' | 'queue' | 'approvals' | 'more';

type IconCmp = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

/**
 * FIVE destinations, plus More.
 *
 * This bar held six, and the comment here said a seventh "would need a More pile". Tokens is
 * the seventh, so this is that change rather than a redesign for its own sake.
 *
 * WHY FIVE AND NOT SEVEN. Each tab is flex:1, so on a 320pt phone six tabs give a label like
 * "Cartridges" about 53pt — already shrinking to fit. Seven makes every label illegible to
 * save one tap on destinations that are not per-minute work. Five leaves room to read them.
 *
 * WHAT STAYS PRIMARY, and why these four. Cartridges and Workflows are where work is watched;
 * Queue is where it backs up; Approvals is the only destination with a DEADLINE attached — an
 * unanswered approval blocks an agent, so burying it behind a tap would be the one regression
 * that costs real time. Goals, Tasks and Tokens are all reference surfaces: you open them
 * deliberately, not because something is waiting.
 *
 * The lesson this file already records — "a destination you cannot see is a destination nobody
 * uses" — is why More shows LABELLED rows in a sheet rather than an overflow menu, and why the
 * More tab lights up when the screen you are on lives inside it.
 */
const TABS: { name: PrimaryTab; Icon: IconCmp; label: string }[] = [
  { name: 'list', Icon: CartridgesIcon, label: 'Cartridges' },
  { name: 'workflows', Icon: WorkflowsIcon, label: 'Workflows' },
  // Reuses WorkflowsIcon deliberately rather than inventing a glyph — the queue drives
  // workflows, prompts and confers, and a wrong-looking new icon reads as a different product.
  { name: 'queue', Icon: WorkflowsIcon, label: 'Queue' },
  // Stays in the bar: an unanswered approval blocks an agent. It is the only tab with a
  // deadline, and the only one where one extra tap has a cost measured in stalled work.
  { name: 'approvals', Icon: ApprovalsIcon, label: 'Approvals' },
  { name: 'more', Icon: MoreIcon, label: 'More' },
];

/**
 * What More holds. Reference surfaces, opened deliberately.
 *
 * No global Memory entry: memory belongs to a CARTRIDGE and is opened from its detail screen,
 * exactly as the web opens ProjectMemoryPanel from a cartridge card. A global entry made the
 * phone ask which repo, when the cartridge you tapped already answered that.
 */
export const MORE_TABS: { name: TabName; Icon: IconCmp; label: string; hint: string }[] = [
  // Goals answer the question one step up from cartridges: not which machine is busy, but
  // whether the thing it is busy with is going anywhere.
  { name: 'goals', Icon: GoalsIcon, label: 'Goals', hint: 'Outcomes and whether work is converging' },
  // Tasks are their own backend (/api/tasks), not queue items, which is why they are not
  // folded into Queue — one list holding two objects with two action sets is how both stop
  // being trustworthy.
  { name: 'tasks', Icon: TasksIcon, label: 'Tasks', hint: 'Discrete work items across the fleet' },
  { name: 'tokens', Icon: TokensIcon, label: 'Tokens', hint: 'Burn rate and spend over time' },
];

/** Which primary tab should light up for a given screen. */
export function primaryFor(tab: TabName): PrimaryTab {
  return MORE_TABS.some((m) => m.name === tab) ? 'more' : (tab as PrimaryTab);
}

/**
 * The app's top-level destinations. These were previously unlabeled emoji
 * tucked into the list header, which made Workflows effectively undiscoverable.
 */
export function TabBar({
  active,
  onSelect,
}: {
  active: TabName;
  /** Emits 'more' for the pile; the caller opens the sheet. */
  onSelect: (t: PrimaryTab) => void;
}) {
  const { permissions } = useNeonCore();

  return (
    <View style={styles.bar}>
      {/* More lights up while you are on a screen that lives inside it — otherwise the bar
          claims you are nowhere. */}
      {TABS.map((t) => {
        const on = t.name === primaryFor(active);
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
            {/* Shrink-to-fit rather than wrap or clip: at five tabs the longest label is
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
