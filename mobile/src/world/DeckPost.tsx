import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme, glow } from '../theme';
import { DECK_ART } from './art.generated';
import { Sprite } from './Sprite';
import {
  bridgeView, engineView, cargoView, coreView, DECK_FIGURES,
  type DeckName, type DeckView,
} from './deckLogic';
import type { Goal, Task, Workflow } from '../types';
import type { BurnRate } from '../api';

/**
 * A SHIP DECK AT THE TOP OF A SCREEN — the phone's version of the dashboard's bridge, engine
 * deck, cargo bay and power core. The drawn figure on the left does ONE thing per state (the
 * same rules as the dashboard: world/deckLogic.ts); beside it, what that state is in words and
 * three readouts taken from the same records the list below shows.
 *
 * The panel is Night Glass: it glows neon while something is live and ember while something
 * needs you, and is quiet otherwise.
 */
const TITLES: Record<DeckName, string> = { bridge: 'BRIDGE', engine: 'ENGINE DECK', cargo: 'CARGO BAY', core: 'POWER CORE' };
/** Frames a second. The core pulses faster the harder it burns; the crew keep one pace. */
const FPS: Record<string, number> = { low: 2, normal: 4, high: 7, warn: 6, idle: 3, call: 6, work: 5, log: 5, worry: 3 };

function Post<A extends string>({ deck, view }: { deck: DeckName; view: DeckView<A> }) {
  const art = DECK_ART[DECK_FIGURES[deck].sheet];
  const edge = view.tone === 'ember' ? theme.ember : view.tone === 'live' ? theme.accent : theme.border;
  const toneColor = { live: theme.accent, ember: theme.ember, ok: theme.success } as const;
  return (
    <View
      style={[s.post, { borderColor: edge }, view.tone === 'quiet' ? null : glow(edge, 8)]}
      accessibilityRole="summary"
      accessibilityLabel={`${TITLES[deck]}. ${view.line}. ${view.readouts.map((r) => `${r.label.toLowerCase()} ${r.value}`).join(', ')}.`}
    >
      {art ? <View style={s.figure}><Sprite art={art} anim={view.anim} height={96} fps={FPS[view.anim] ?? 4} /></View> : null}
      <View style={s.side}>
        <Text style={s.title}>{TITLES[deck]}</Text>
        <Text style={[s.line, { color: view.tone === 'ember' ? theme.ember : view.tone === 'live' ? theme.text : theme.textDim }]} numberOfLines={1}>
          {view.line}
        </Text>
        <View style={s.readouts}>
          {view.readouts.map((r) => (
            <View key={r.label} style={s.readout}>
              <Text style={[s.value, r.tone && r.value !== '0' ? { color: toneColor[r.tone] } : null]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {r.value}
              </Text>
              <Text style={s.label} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{r.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

export function BridgePost({ goals }: { goals: readonly Goal[] }) {
  return <Post deck="bridge" view={bridgeView(goals)} />;
}
export function EnginePost({ runs }: { runs: readonly Workflow[] }) {
  return <Post deck="engine" view={engineView(runs, Date.now())} />;
}
export function CargoPost({ tasks }: { tasks: readonly Task[] }) {
  return <Post deck="cargo" view={cargoView(tasks, Date.now())} />;
}
export function CorePost({ burn }: { burn: BurnRate | null }) {
  return <Post deck="core" view={coreView(burn)} />;
}

const s = StyleSheet.create({
  post: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 12, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: theme.bgCard, borderWidth: 1, borderRadius: 14,
  },
  figure: { width: 92, alignItems: 'center', justifyContent: 'flex-end' },
  side: { flex: 1, minWidth: 0 },
  title: { color: theme.accentSoft, fontSize: 10, fontWeight: '700', letterSpacing: 1.6 },
  line: { fontSize: 15, fontWeight: '600', marginTop: 2 },
  readouts: { flexDirection: 'row', gap: 8, marginTop: 10 },
  readout: {
    flex: 1, minWidth: 0, paddingVertical: 6, paddingHorizontal: 8,
    backgroundColor: theme.bgWell, borderWidth: 1, borderColor: theme.border, borderRadius: 8,
  },
  value: { color: theme.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { color: theme.textFaint, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8, marginTop: 2 },
});
