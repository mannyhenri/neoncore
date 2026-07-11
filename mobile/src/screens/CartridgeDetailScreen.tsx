import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { MessageBlocks } from '../components/MessageBlocks';
import type { Agent, AgentMode, TranscriptEvent } from '../types';

const MODES: AgentMode[] = ['manual', 'plan', 'trust'];

export function CartridgeDetailScreen({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const { baseUrl, agents, onTranscript } = useNeonCore();
  // Prefer the live agent object so status/mode stay current.
  const live = agents.find((a) => a.id === agent.id) ?? agent;

  const [messages, setMessages] = useState<TranscriptEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const listRef = useRef<FlatList<TranscriptEvent>>(null);

  // Load history, then merge live events (dedup by id).
  useEffect(() => {
    let active = true;
    api
      .getMessages(baseUrl, agent.id, { limit: 100 })
      .then((h) => { if (active) setMessages(h); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });

    const unsub = onTranscript(agent.id, (ev) => {
      setMessages((prev) => (prev.some((m) => m.id === ev.id) ? prev : [...prev, ev]));
    });
    return () => { active = false; unsub(); };
  }, [baseUrl, agent.id, onTranscript]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await api.sendCommand(baseUrl, agent.id, t);
      setText('');
      flash('Command sent');
    } catch (e) {
      flash(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const changeMode = async (mode: AgentMode) => {
    try {
      await api.setMode(baseUrl, agent.id, mode);
      flash(`Mode → ${mode}`);
    } catch (e) {
      flash(`Mode change failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹ Cartridges</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{live.repoName || live.name}</Text>
        <View style={{ width: 80 }} />
      </View>

      <View style={styles.modeRow}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.modeBtn, live.mode === m && styles.modeBtnActive]}
            onPress={() => changeMode(m)}
          >
            <Text style={[styles.modeText, live.mode === m && styles.modeTextActive]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {live.pendingQuestion ? (
        <View style={styles.questionBanner}>
          <Text style={styles.questionText}>❓ {live.pendingQuestion}</Text>
          <Text style={styles.questionHint}>Answer from the 🔔 approvals inbox.</Text>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MessageBlocks ev={item} />}
          contentContainerStyle={{ paddingVertical: 8 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
        />
      )}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.inputBar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Send a prompt to this agent…"
          placeholderTextColor={theme.textFaint}
          style={styles.input}
          multiline
        />
        <TouchableOpacity style={styles.sendBtn} onPress={send} disabled={sending || !text.trim()}>
          {sending ? <ActivityIndicator color="#000" size="small" /> : <Text style={styles.sendText}>Send</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  back: { width: 80 },
  backText: { color: theme.accentSoft, fontSize: 15 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center' },
  modeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  modeBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgCard,
  },
  modeBtnActive: { borderColor: theme.accent, backgroundColor: theme.accent },
  modeText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  modeTextActive: { color: '#0d0f12' },
  questionBanner: {
    marginHorizontal: 12, marginBottom: 4, padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: theme.amber,
  },
  questionText: { color: theme.amber, fontSize: 14, fontWeight: '600' },
  questionHint: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 60 },
  notice: { color: theme.teal, fontSize: 13, textAlign: 'center', paddingVertical: 6 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10,
    borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bgElevated,
  },
  input: {
    flex: 1, maxHeight: 120, backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, fontSize: 15,
  },
  sendBtn: { backgroundColor: theme.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12, justifyContent: 'center' },
  sendText: { color: '#0d0f12', fontWeight: '800' },
});
