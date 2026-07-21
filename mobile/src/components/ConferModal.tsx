import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Agent } from '../types';

/**
 * Seed a multi-agent "confer" from the phone: pick 2+ live cartridges (e.g. Claude +
 * Codex) and a task; each gets the same task plus its peers' ids and is told to use
 * the neoncore_message_agent / neoncore_read_agent MCP tools to collaborate and
 * converge on one solution. Pure UI over the existing sendCommand — mirrors the web
 * ConferModal.
 */
export function ConferModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { baseUrl, agents } = useNeonCore();
  const live = agents.filter((a) => a.status !== 'offline');
  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 4000); };
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const reset = () => { setSelected([]); setTask(''); };

  const start = async () => {
    if (selected.length < 2) { flash('Pick at least two cartridges to confer.'); return; }
    if (!task.trim()) { flash('Describe the task they should solve together.'); return; }
    setSending(true);
    try {
      const participants = selected
        .map((id) => live.find((a) => a.id === id))
        .filter((a): a is Agent => !!a);
      for (const me of participants) {
        const peers = participants.filter((p) => p.id !== me.id);
        await api.sendCommand(baseUrl, me.id, conferPrompt(task.trim(), peers));
      }
      reset();
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Failed to start confer');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Confer — two agents, one job</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.close}>×</Text></TouchableOpacity>
          </View>
          <Text style={styles.sub}>
            They get the same task + each other's ids and confer via the neoncore tools to reach one solution.
          </Text>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
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

            <Text style={styles.label}>TASK</Text>
            <TextInput
              value={task}
              onChangeText={setTask}
              placeholder="What should they solve together?"
              placeholderTextColor={theme.textFaint}
              style={styles.input}
              multiline
            />

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
      </View>
    </Modal>
  );
}

/** Compose the wire-up prompt one participant receives. */
function conferPrompt(task: string, peers: Agent[]): string {
  const peerLines = peers
    .map((p) => `- ${p.agentType} (${p.repoName || p.name}) — agentId: ${p.id}`)
    .join('\n');
  return [
    `[NeonCore Confer] You're collaborating with ${peers.length} other agent(s) on ONE task. Work together and converge on a single agreed solution — do not work in isolation.`,
    ``,
    `TASK:`,
    task,
    ``,
    `YOUR PEERS (use these ids with the neoncore MCP tools):`,
    peerLines,
    ``,
    `HOW TO CONFER:`,
    `1. neoncore_read_agent("<peerId>") — see what a peer has done so far.`,
    `2. neoncore_message_agent("<peerId>", "...") — share your plan, findings, or critiques.`,
    `3. Divide the work or review each other's approach; iterate until you agree.`,
    `4. Agree on ONE of you to post the final combined solution, and say who.`,
    ``,
    `Begin now by messaging your peer(s) with your initial plan.`,
  ].join('\n');
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
  close: { color: theme.textDim, fontSize: 26, lineHeight: 26 },
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
