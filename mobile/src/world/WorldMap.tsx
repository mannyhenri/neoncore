import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, ScrollView, Pressable, Animated, Easing, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { theme, glow } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Agent } from '../types';
import { TERRAIN, CREW_ART, KIT_ART } from './art.generated';
import { Sprite } from './Sprite';
import { ANIMATIONS } from '../../../dashboard/src/world/anim';
import {
  buildMap, emptyMemory, walkMs, PLATE, FIGURE_SHARE,
  type MapFigure, type MapMemory, type MapProject, type MapStructure,
} from './mapLogic';

/**
 * THE AGENTS MAP — the dashboard's pixel-art base, on the phone.
 *
 * The drawn terrain with its buildings, every live agent as an animated character standing at
 * its project's pod in the ONE look its state has, and a name plate over each. Tap an agent to
 * open it. The map fills the screen's height and scrolls sideways; pinch to zoom.
 *
 * What is drawn and where comes from mapLogic.ts (the dashboard's own rules). This file is only
 * the drawing: layers bottom to top are terrain, flat things (the landing pad), then scenery
 * and characters sorted by where they stand, then the banners.
 *
 * Everything drawn OVER the scene is Night Glass (name plates, banners): dark panel, thin
 * border, neon when live, ember when it needs you.
 */
const ASPECT = PLATE.width / PLATE.height;
const PROJECTS_EVERY_MS = 20_000;

export function WorldMap({ onOpen }: { onOpen: (agent: Agent) => void }) {
  const { agents, permissions, baseUrl } = useNeonCore();
  const [projects, setProjects] = useState<MapProject[] | null>(null);
  const [height, setHeight] = useState(0);
  const memory = useRef<MapMemory>(emptyMemory());
  const scroller = useRef<ScrollView>(null);
  const centred = useRef(false);

  // Projects decide the pods. Polled: the server emits no event for them.
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (!baseUrl) { setProjects([]); return; }
      api.listProjects(baseUrl).then((p) => { if (alive) setProjects(p); }).catch(() => { if (alive) setProjects((prev) => prev ?? []); });
    };
    load();
    const t = setInterval(load, PROJECTS_EVERY_MS);
    return () => { alive = false; clearInterval(t); };
  }, [baseUrl]);

  // Nothing is placed until the projects have loaded once — otherwise every agent would be
  // drawn on open land and then walk to its pod, which is movement that means nothing.
  const scene = useMemo(() => {
    if (projects === null) return null;
    const built = buildMap({ agents, permissions, projects, now: Date.now() }, memory.current);
    memory.current = built.memory;
    return built;
  }, [agents, permissions, projects]);

  const onLayout = useCallback((e: LayoutChangeEvent) => setHeight(e.nativeEvent.layout.height), []);
  const width = height * ASPECT;
  // Open on the middle of the base, not its west edge.
  const onContentSize = useCallback((w: number) => {
    if (centred.current || !height) return;
    centred.current = true;
    scroller.current?.scrollTo({ x: Math.max(0, (w - height * 0.56) / 2), animated: false });
  }, [height]);

  const figureH = Math.max(40, height * FIGURE_SHARE);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const flat = scene?.structures.filter((s) => s.flat) ?? [];
  const standing = useMemo(() => {
    if (!scene) return [];
    const things: ({ kind: 'structure'; y: number; st: MapStructure } | { kind: 'figure'; y: number; f: MapFigure })[] = [
      ...scene.structures.filter((s) => !s.flat).map((st) => ({ kind: 'structure' as const, y: st.y, st })),
      ...scene.figures.map((f) => ({ kind: 'figure' as const, y: f.y, f })),
    ];
    return things.sort((a, b) => a.y - b.y);
  }, [scene]);

  return (
    <View style={s.wrap} onLayout={onLayout}>
      {height > 0 && (
        <ScrollView
          ref={scroller}
          horizontal
          bounces={false}
          maximumZoomScale={3}
          minimumZoomScale={1}
          bouncesZoom
          directionalLockEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={onContentSize}
          contentContainerStyle={{ width, height }}
        >
          <View style={{ width, height }}>
            <Image source={TERRAIN.source} style={{ width, height }} resizeMode="stretch" fadeDuration={0} />
            {flat.map((st) => <Structure key={st.id} st={st} width={width} height={height} />)}
            {standing.map((t) => (t.kind === 'structure'
              ? <Structure key={t.st.id} st={t.st} width={width} height={height} />
              : <Figure key={t.f.key} f={t.f} width={width} height={height} figureH={figureH} onPress={() => { const a = byId.get(t.f.agentId); if (a) onOpen(a); }} />))}
            {scene?.banners.map((b) => (
              <View key={b.id} pointerEvents="none" style={[s.bannerAt, { left: b.x * width, top: b.y * height }]}>
                <View style={[s.banner, b.active ? { borderColor: theme.accent } : null]}>
                  <View style={[s.dot, { backgroundColor: b.active ? theme.accent : theme.textFaint }, b.active ? glow(theme.accent, 3) : null]} />
                  <Text style={s.bannerName} numberOfLines={1}>{b.name}</Text>
                  <Text style={s.bannerDetail} numberOfLines={1}>{b.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {scene && scene.figures.length === 0 && (
        <View pointerEvents="none" style={s.empty}>
          <Text style={s.emptyText}>Nobody on the base.{'\n'}Launch a cartridge and it walks in here.</Text>
        </View>
      )}
    </View>
  );
}

/** A piece of scenery: its base sits at (x, y); its width is a share of the map's. */
function Structure({ st, width, height }: { st: MapStructure; width: number; height: number }) {
  const art = KIT_ART[st.sprite];
  if (!art) return null;
  const w = st.w * width;
  const h = w * (art.h / art.w);
  return <Image source={art.source} fadeDuration={0} resizeMode="stretch" style={{ position: 'absolute', left: st.x * width - w / 2, top: st.y * height - h, width: w, height: h }} />;
}

/**
 * One agent. It stands where its state puts it; when that changes it WALKS there (the only
 * movement on the map, so movement always means something happened).
 */
function Figure({ f, width, height, figureH, onPress }: { f: MapFigure; width: number; height: number; figureH: number; onPress: () => void }) {
  const art = CREW_ART[f.character];
  const pos = useRef(new Animated.ValueXY({ x: f.x, y: f.y })).current;
  const at = useRef({ x: f.x, y: f.y });
  const [walking, setWalking] = useState<1 | -1 | null>(null);

  useEffect(() => {
    const from = at.current;
    const ms = walkMs(from, f);
    if (ms === 0) { pos.setValue({ x: f.x, y: f.y }); at.current = { x: f.x, y: f.y }; return undefined; }
    setWalking(f.x < from.x ? -1 : 1);
    const run = Animated.timing(pos, { toValue: { x: f.x, y: f.y }, duration: ms, easing: Easing.linear, useNativeDriver: false });
    run.start(({ finished }) => { if (finished) { at.current = { x: f.x, y: f.y }; setWalking(null); } });
    return () => run.stop();
  }, [f.x, f.y, pos]);

  if (!art) return null;
  const anim = walking ? 'walk' : f.anim;
  const cellW = figureH * (art.frameW / art.frameH);
  // The figure starts some way down its cell (more when kneeling): the plate sits just above its head.
  const headroom = (art.tops[anim] ?? 0) * figureH;
  const edge = f.tone === 'ember' ? theme.ember : f.tone === 'live' ? theme.accent : theme.border;
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: pos.x.interpolate({ inputRange: [0, 1], outputRange: [-cellW / 2, width - cellW / 2] }),
        top: pos.y.interpolate({ inputRange: [0, 1], outputRange: [-figureH, height - figureH] }),
        width: cellW, height: figureH,
      }}
    >
      <Pressable
        onPress={onPress}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${f.name}, ${f.tone === 'ember' ? `needs you${f.attention ? `: ${f.attention}` : ''}` : f.tone === 'live' ? 'working' : 'idle'}. Opens the cartridge.`}
      >
        <Sprite art={art} anim={anim} height={figureH} fps={ANIMATIONS[anim].fps} facing={walking ?? f.facing} />
        <View pointerEvents="none" style={[s.plateAt, { top: headroom - 18 }]}>
          <View style={[s.plate, { borderColor: edge }, f.tone === 'quiet' ? null : glow(edge, 4)]}>
            <View style={[s.dot, { backgroundColor: theme.engine[f.engine] ?? theme.textFaint }]} />
            <Text style={[s.plateText, f.tone === 'ember' ? { color: theme.ember } : null]} numberOfLines={1}>{f.name}</Text>
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, overflow: 'hidden' },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  // Centred on the figure, whatever the name's length: a wide, centring row over a narrow cell.
  plateAt: { position: 'absolute', left: -60, right: -60, alignItems: 'center' },
  plate: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 150,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1,
    backgroundColor: theme.bgElevated,
  },
  plateText: { color: theme.text, fontSize: 10, fontWeight: '600' },
  bannerAt: { position: 'absolute', width: 240, marginLeft: -120, alignItems: 'center' },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 240,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: theme.border,
    backgroundColor: theme.bgElevated,
  },
  bannerName: { color: theme.text, fontSize: 10, fontWeight: '700', flexShrink: 1 },
  bannerDetail: { color: theme.textDim, fontSize: 9.5, flexShrink: 1 },
  empty: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
  emptyText: {
    color: theme.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, overflow: 'hidden',
  },
});
