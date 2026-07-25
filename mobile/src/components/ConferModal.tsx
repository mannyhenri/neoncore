import React, { useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Agent, ConferMode } from '../types';

/**
 * Start a milestone-driven "confer" from the phone: pick 2+ live cartridges (e.g. Claude +
 * Codex) and a task. The server-side conductor runs them through a fixed cycle
 * (Align → Build → Cross-review → Converge → Finalize), dispatching each milestone to both
 * agents and auto-advancing only when both signal done. Launched from the Workflows screen,
 * where the session then shows up under ACTIVE alongside workflow runs. Mirrors the web
 * ConferModal.
 */
export function ConferModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { baseUrl, agents } = useNeonCore();
  const live = agents.filter((a) => a.status !== 'offline');
  // Projects with 2+ live engines — one tap confers them together.
  const byRepo = new Map<string, Agent[]>();
  for (const a of live) {
    const k = a.repoName || a.name;
    byRepo.set(k, [...(byRepo.get(k) || []), a]);
  }
  const readyProjects = [...byRepo.entries()].filter(([, list]) => list.length >= 2);
  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  // divide = split into per-agent slices, then merge. collaborate = the whole panel works
  // ONE problem into ONE shared solution. Worktree isolation (divide only) gives each agent
  // its own git worktree+branch, and Converge becomes a real merge.
  const [mode, setMode] = useState<ConferMode>('divide');
  const [worktree, setWorktree] = useState(false);

  // The sheet rides above the keyboard (see KeyboardAvoidingView below), but that only
  // guarantees the sheet is visible — not the field inside its ScrollView. On focus we scroll
  // the TASK block to the top of the shrunken viewport so you can see what you're typing.
  const scrollRef = useRef<ScrollView>(null);
  const taskY = useRef(0);
  const revealTask = () => {
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, taskY.current - 8), animated: true }), 60);
  };

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 4000); };
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const reset = () => { setSelected([]); setTask(''); setMode('divide'); setWorktree(false); };

  // Dismiss the keyboard before the sheet animates out — otherwise it lingers over the screen
  // underneath on iOS.
  const close = () => { Keyboard.dismiss(); onClose(); };

  const start = async () => {
    if (selected.length < 2) { flash('Pick at least two cartridges to confer.'); return; }
    if (!task.trim()) { flash('Describe the task they should solve together.'); return; }
    setSending(true);
    try {
      await api.startConfer(baseUrl, selected, task.trim(), {
        mode,
        isolation: mode === 'divide' && worktree ? 'worktree' : 'shared',
      });
      reset();
      close();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Failed to start confer');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      {/* The sheet is bottom-anchored, so an open keyboard sits right on top of it — hiding the
          TASK field and, on a short sheet, the header with the × too. Padding the backdrop lifts
          the whole sheet above the keyboard and shrinks its maxHeight to what's left, so the
          close button is always reachable and the body scrolls instead of being covered.
          Android resizes the modal window natively, so it needs no behavior. */}
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Confer — two agents, one job</Text>
            <TouchableOpacity
              onPress={close}
              style={styles.closeBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={styles.close}>×</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>
            One task, run through a fixed 5-milestone cycle — {mode === 'collaborate'
              ? 'Frame → Draft → Critique → Revise → Finalize'
              : 'Align → Build → Cross-review → Converge → Finalize'}.
            Each milestone advances only when every participant signals done. It appears under ACTIVE below, and moves to RECENT when it finishes.
          </Text>

          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {readyProjects.length > 0 && (
              <>
                <Text style={styles.label}>QUICK PICK — A PROJECT WITH TWO ENGINES</Text>
                <View style={styles.chips}>
                  {readyProjects.map(([repo, list]) => (
                    <TouchableOpacity
                      key={repo}
                      style={styles.quickChip}
                      onPress={() => setSelected(list.map((a) => a.id))}
                    >
                      <Text style={styles.quickChipText} numberOfLines={1}>
                        {repo} — {list.map((a) => a.agentType).join(' + ')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
            <Text style={styles.label}>
              CARTRIDGES (pick 2+) · <Text style={{ color: selected.length >= 2 ? theme.accentSoft : theme.amber }}>{selected.length} selected</Text>
            </Text>
            {live.length < 2 ? (
              <Text style={styles.warn}>Need at least two live cartridges — start another agent first.</Text>
            ) : (
              <View style={styles.chips}>
                {live.map((a) => {
                  const on = selected.includes(a.id);
                  return (
                    <TouchableOpacity
                      key={a.id}
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() => toggle(a.id)}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
                        {a.agentType} · {a.repoName || a.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <View onLayout={(e) => { taskY.current = e.nativeEvent.layout.y; }}>
              <Text style={styles.label}>TASK</Text>
              <TextInput
                value={task}
                onChangeText={setTask}
                placeholder="What should they solve together?"
                placeholderTextColor={theme.textFaint}
                style={styles.input}
                multiline
                onFocus={revealTask}
              />
            </View>

            <Text style={styles.label}>HOW THEY WORK</Text>
            <View style={styles.chips}>
              {([
                { key: 'divide', title: 'Divide', sub: 'Split into slices, then merge' },
                { key: 'collaborate', title: 'Collaborate', sub: 'One shared solution' },
              ] as const).map((m) => {
                const on = mode === m.key;
                return (
                  <TouchableOpacity
                    key={m.key}
                    style={[styles.modeChip, on && styles.chipOn]}
                    onPress={() => setMode(m.key)}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{m.title}</Text>
                    <Text style={styles.modeSub} numberOfLines={1}>{m.sub}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {mode === 'divide' ? (
              <TouchableOpacity style={styles.wtRow} onPress={() => setWorktree((v) => !v)} activeOpacity={0.7}>
                <View style={[styles.checkbox, worktree && styles.checkboxOn]}>
                  {worktree ? <Text style={styles.checkMark}>✓</Text> : null}
                </View>
                <Text style={styles.wtText}>
                  Isolate each agent in its own git worktree + branch. Converge becomes a real merge
                  (conflicts surface there). Best for same-machine repos.
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.needHint}>Collaborate works one shared checkout — no per-agent worktrees.</Text>
            )}

            {(selected.length < 2 || !task.trim()) ? (
              <Text style={styles.needHint}>
                {selected.length < 2 ? 'Select at least 2 cartridges' : 'Enter a task'} to enable Start.
              </Text>
            ) : null}
            <TouchableOpacity
              style={[styles.runBtn, sending && styles.runBtnOff]}
              onPress={start}
              disabled={sending}
            >
              {sending ? (
                <ActivityIndicator color="#0d0f12" />
              ) : (
                <Text style={styles.runBtnText}>START CONFER ({selected.length})</Text>
              )}
            </TouchableOpacity>
          </ScrollView>

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28, maxHeight: '88%',
    borderTopWidth: 1, borderColor: theme.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 16, fontWeight: '800' },
  // The × is a single glyph, so its text box alone is a ~15pt target. Pad it out (plus hitSlop)
  // to something thumb-sized; the negative margin keeps it visually flush with the sheet edge.
  closeBtn: { paddingHorizontal: 12, paddingVertical: 8, marginRight: -12, marginTop: -4 },
  close: { color: theme.textDim, fontSize: 26, lineHeight: 28 },
  sub: { color: theme.textFaint, fontSize: 12, marginTop: 4, marginBottom: 8 },
  body: { paddingBottom: 12 },
  label: {
    color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    marginTop: 14, marginBottom: 8,
  },
  warn: { color: theme.amber, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  chipOn: { borderColor: theme.accent, backgroundColor: theme.bgCard },
  chipText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: theme.accentSoft },
  quickChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.accent,
  },
  quickChipText: { color: theme.accentSoft, fontSize: 13, fontWeight: '600' },
  modeChip: {
    flexGrow: 1, flexBasis: '46%', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  modeSub: { color: theme.textFaint, fontSize: 11, marginTop: 2 },
  wtRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10 },
  checkbox: {
    width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: theme.border,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkboxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  checkMark: { color: '#0d0f12', fontSize: 12, fontWeight: '900', lineHeight: 14 },
  wtText: { flex: 1, color: theme.textDim, fontSize: 11, lineHeight: 15 },
  input: {
    color: theme.text, fontSize: 14, backgroundColor: theme.bgCard, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border, padding: 12, minHeight: 90, textAlignVertical: 'top',
  },
  runBtn: {
    marginTop: 18, backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 14,
    alignItems: 'center',
  },
  runBtnOff: { opacity: 0.4 },
  needHint: { color: theme.textFaint, fontSize: 12, marginTop: 14, textAlign: 'center' },
  runBtnText: { color: '#0d0f12', fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  notice: { color: theme.teal, fontSize: 13, textAlign: 'center', paddingTop: 8 },
});
