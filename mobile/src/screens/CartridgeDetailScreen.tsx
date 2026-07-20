import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, Clipboard,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { MessageBlocks, messageToText } from '../components/MessageBlocks';
import { PermissionCard } from '../components/PermissionCard';
import { QuestionIcon } from '../components/Icons';
import type { Agent, AgentMode, TranscriptEvent } from '../types';

const MODES: AgentMode[] = ['manual', 'plan', 'trust'];

export function CartridgeDetailScreen({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const { baseUrl, agents, permissions, onTranscript } = useNeonCore();
  // Prefer the live agent object so status/mode stay current.
  const live = agents.find((a) => a.id === agent.id) ?? agent;
  // Anything this agent is currently blocked on — answerable inline, below.
  const myPermissions = permissions.filter((p) => p.agentId === agent.id);

  const decide = useCallback(
    async (id: string, decision: 'allowed' | 'denied', response?: string | object) => {
      try {
        await api.decidePermission(baseUrl, id, decision, response);
      } catch {
        /* socket permission_decided will reconcile */
      }
    },
    [baseUrl],
  );

  const [messages, setMessages] = useState<TranscriptEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<FlatList<TranscriptEvent>>(null);
  // Auto-scroll only when a NEW message arrives — not when the user expands one
  // (expanding changes content size too, and yanking them away would defeat the
  // point of opening it).
  const scrolledCount = useRef(0);
  const atTop = useRef(true);
  const rootRef = useRef<View>(null);
  const [kbOffset, setKbOffset] = useState(0);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Newest-first: the latest message is the one you came to read, so it sits at the
  // top and costs no scrolling. The API returns history oldest-first, so reverse it,
  // and live events PREPEND rather than append.
  useEffect(() => {
    let active = true;
    api
      .getMessages(baseUrl, agent.id, { limit: 100 })
      .then((h) => { if (active) setMessages([...h].reverse()); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });

    const unsub = onTranscript(agent.id, (ev) => {
      setMessages((prev) => (prev.some((m) => m.id === ev.id) ? prev : [ev, ...prev]));
    });
    return () => { active = false; unsub(); };
  }, [baseUrl, agent.id, onTranscript]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  }, []);

  // Long-press any message to lift its text out of the app — the feed is often where
  // an agent hands you something (a key, a command, install instructions) that belongs
  // somewhere else. Uses RN core's Clipboard rather than expo-clipboard on purpose:
  // a native dep would force a new binary and cost us OTA updatability (see Markdown.tsx).
  const copyMessage = useCallback(
    (ev: TranscriptEvent) => {
      const body = messageToText(ev);
      if (!body) return; // nothing readable to copy — don't claim we copied
      Clipboard.setString(body);
      flash('Copied');
    },
    [flash],
  );

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
      // KeyboardAvoidingView measures its own frame relative to its PARENT, but compares
      // it against the keyboard's SCREEN coords. We sit inside a SafeAreaView, so the two
      // differ by the top inset — RN then under-computes the overlap by exactly that much
      // and the input stays buried under the keyboard. The probe below measures our real
      // screen offset; feeding it back is precisely what keyboardVerticalOffset is for.
      keyboardVerticalOffset={kbOffset}
    >
      <View
        ref={rootRef}
        onLayout={() =>
          rootRef.current?.measureInWindow((_x, y) => {
            if (Number.isFinite(y)) setKbOffset(y);
          })
        }
      />
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText} numberOfLines={1}>‹ Cartridges</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{live.repoName || live.name}</Text>
        <View style={{ width: 96 }} />
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

      {/* Answer right here — this is where you are when you see the agent asking.
          Falls back to the raw banner only if the agent claims a pending question
          but no permission is actually open to answer (e.g. it already timed out). */}
      {myPermissions.length > 0 ? (
        <View style={styles.permBox}>
          {myPermissions.map((p) => (
            <PermissionCard key={p.id} perm={p} onDecide={decide} />
          ))}
        </View>
      ) : live.pendingQuestion ? (
        <View style={styles.questionBanner}>
          <View style={styles.questionRow}>
            <QuestionIcon size={15} color={theme.amber} strokeWidth={2} />
            <Text style={styles.questionText}>{live.pendingQuestion}</Text>
          </View>
          <Text style={styles.questionHint}>
            No longer answerable — the agent stopped waiting.
          </Text>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => toggleExpanded(item.id)}
              onLongPress={() => copyMessage(item)}
            >
              <MessageBlocks ev={item} expanded={expanded.has(item.id)} />
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingVertical: 8 }}
          onScroll={(e) => { atTop.current = e.nativeEvent.contentOffset.y < 120; }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (messages.length === scrolledCount.current) return; // an expand/collapse, not a new message
            scrolledCount.current = messages.length;
            // A new message lands at the top. Snap to it only if they're already up
            // there — if they've scrolled back into history, leave them where they are.
            if (atTop.current) listRef.current?.scrollToOffset({ offset: 0, animated: true });
          }}
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
  back: { width: 96 },
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
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  questionText: { color: theme.amber, fontSize: 14, fontWeight: '600', flex: 1 },
  questionHint: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  permBox: { paddingHorizontal: 12, paddingTop: 4 },
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
