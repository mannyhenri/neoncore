import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, Clipboard,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { needsStandardReview } from '../standardBanner';
import { useNeonCore } from '../NeonCoreProvider';
import { ProjectMemoryScreen } from './ProjectMemoryScreen';
import { MessageBlocks, messageToText } from '../components/MessageBlocks';
import { PermissionCard } from '../components/PermissionCard';
import { QuestionIcon } from '../components/Icons';
import type { Agent, AgentMode, TranscriptEvent } from '../types';
import { useAdaptiveContent } from '../components/ui';

const MODES: AgentMode[] = ['manual', 'plan', 'trust'];

export function CartridgeDetailScreen({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const adaptive = useAdaptiveContent();
  const { agents, permissions, onTranscript, urlForAgent, urlForPermission } = useNeonCore();
  // Prefer the live agent object so status/mode stay current.
  const live = agents.find((a) => a.id === agent.id) ?? agent;
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Anything this agent is currently blocked on — answerable inline, below.
  const myPermissions = permissions.filter((p) => p.agentId === agent.id);

  // Sibling engines: other live cartridges in the SAME repo on the SAME machine (e.g. this
  // repo also has a Codex + Gridlight running). The web card multi-selects across them; on
  // mobile each is its own card, so we offer the same fan-out from here — send to this
  // engine plus any selected siblings at once.
  const siblings = useMemo(
    () => agents.filter(
      (a) => a.id !== live.id && a.status !== 'offline'
        && a.repoPath === live.repoPath && a.machine === live.machine,
    ),
    [agents, live.id, live.repoPath, live.machine],
  );
  // Send targets — this engine plus any selected siblings, all on by default.
  const [targets, setTargets] = useState<Set<string>>(() => new Set([live.id]));
  useEffect(() => {
    // Default every sibling on when the group changes; keep at least this engine.
    setTargets(new Set([live.id, ...siblings.map((s) => s.id)]));
  }, [live.id, siblings.map((s) => s.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleTarget = (id: string) => setTargets((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { if (next.size > 1) next.delete(id); } else next.add(id);
    return next;
  });
  const allTools = [live, ...siblings];

  // Session recovery offer (crash/interruption). 'dismissed' hides it; a local flag hides it
  // instantly on tap before the socket round-trips.
  const [recovDismissed, setRecovDismissed] = useState(false);
  const [reviewCleared, setReviewCleared] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const offerRecovery = !recovDismissed
    && live.recoveryStatus !== 'dismissed'
    && (live.recoveryStatus === 'interrupted'
      || live.recoveryStatus === 'recovery_failed'
      || (live.status === 'offline' && !!live.sessionId));

  const decide = useCallback(
    async (id: string, decision: 'allowed' | 'denied', response?: string | object) => {
      try {
        await api.decidePermission(urlForPermission(id), id, decision, response);
      } catch {
        /* socket permission_decided will reconcile */
      }
    },
    [urlForPermission],
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
      .getMessages(urlForAgent(agent.id), agent.id, { limit: 100 })
      .then((h) => { if (active) setMessages([...h].reverse()); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });

    const unsub = onTranscript(agent.id, (ev) => {
      setMessages((prev) => (prev.some((m) => m.id === ev.id) ? prev : [ev, ...prev]));
    });
    return () => { active = false; unsub(); };
  }, [urlForAgent, agent.id, onTranscript]);

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
      // Fan out to every selected engine (this one + any selected siblings).
      const ids = allTools.filter((a) => targets.has(a.id)).map((a) => a.id);
      const list = ids.length > 0 ? ids : [agent.id];
      // Selected siblings can live on different servers, so each id resolves its own.
      await Promise.all(list.map((id) => api.sendCommand(urlForAgent(id), id, t)));
      setText('');
      flash(list.length > 1 ? `Sent to ${list.length} engines` : 'Command sent');
    } catch (e) {
      flash(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const resumeSession = async () => {
    setRecovering(true);
    try {
      await api.recoverAgentSession(urlForAgent(live.id), live.id);
      flash('Recovery dispatched');
    } catch (e) {
      flash(live.status === 'offline'
        ? 'Relaunch this cartridge first, then resume.'
        : `Resume failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecovering(false);
    }
  };
  const dismissRecovery = async () => {
    setRecovDismissed(true);
    try { await api.dismissAgentRecovery(urlForAgent(live.id), live.id); } catch { setRecovDismissed(false); }
  };
  // The gate let this cartridge stop without a completion report. Clearing is a human
  // acknowledgement, so it needs an explicit tap — never a timer.
  const clearStandardReview = async () => {
    setReviewCleared(true);
    try { await api.clearStandardReview(urlForAgent(live.id), live.id); } catch { setReviewCleared(false); }
  };

  const changeMode = async (mode: AgentMode) => {
    try {
      await api.setMode(urlForAgent(agent.id), agent.id, mode);
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
        {/* Memory belongs to THIS cartridge, exactly as on the web (CartridgeCard opens
            ProjectMemoryPanel with project={agent.repoName}). Opening it from here means the
            phone never asks which repo — it already knows. */}
        <TouchableOpacity onPress={() => setMemoryOpen((v) => !v)} style={{ width: 96, alignItems: 'flex-end' }}>
          <Text style={[styles.backText, memoryOpen && { color: theme.accent }]}>
            {memoryOpen ? 'Close' : 'Memory'}
          </Text>
        </TouchableOpacity>
      </View>

      {memoryOpen && (
        <View style={{ flex: 1 }}>
          <ProjectMemoryScreen project={live.repoName} />
        </View>
      )}

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

      {needsStandardReview(live) && !reviewCleared ? (
        <View style={styles.stdBanner}>
          <View style={styles.recovTextWrap}>
            <Text style={styles.stdTitle}>Stopped without a completion report</Text>
            <Text style={styles.stdObjective} numberOfLines={1}>
              {live.activeObjective || 'The task may be only partially done — check before trusting it.'}
            </Text>
          </View>
          <TouchableOpacity style={styles.stdBtn} onPress={clearStandardReview}>
            <Text style={styles.stdBtnText}>Reviewed</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {offerRecovery ? (
        <View style={styles.recovBanner}>
          <View style={styles.recovTextWrap}>
            <Text style={styles.recovTitle}>
              {live.recoveryStatus === 'interrupted' || live.recoveryStatus === 'recovery_failed'
                ? 'Session interrupted' : 'Last session available'}
            </Text>
            {live.activeObjective ? (
              <Text style={styles.recovObjective} numberOfLines={1}>{live.activeObjective}</Text>
            ) : null}
          </View>
          <TouchableOpacity style={styles.recovBtn} onPress={resumeSession} disabled={recovering}>
            {recovering ? <ActivityIndicator color={theme.danger} size="small" /> : (
              <Text style={styles.recovBtnText}>
                {live.recoveryStatus === 'recovery_failed' ? 'Retry' : 'Resume'}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.recovDismiss} onPress={dismissRecovery} disabled={recovering}>
            <Text style={styles.recovDismissText}>×</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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
            {live.status === 'waiting'
              ? 'Reply below to answer — the agent is waiting on you.'
              : 'No longer answerable — the agent stopped waiting.'}
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
          contentContainerStyle={[{ paddingVertical: 8 }, adaptive]}
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

      {siblings.length > 0 ? (
        <View style={styles.targetRow}>
          <Text style={styles.targetLabel}>Send to</Text>
          {allTools.map((a) => {
            const on = targets.has(a.id);
            return (
              <TouchableOpacity
                key={a.id}
                style={[styles.targetChip, on ? styles.targetChipOn : styles.targetChipOff]}
                onPress={() => toggleTarget(a.id)}
              >
                <Text style={[styles.targetChipText, on && styles.targetChipTextOn]}>{a.agentType}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <View style={styles.inputBar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={siblings.length > 0 ? 'Send a prompt to the selected engines…' : 'Send a prompt to this agent…'}
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
  title: { color: theme.text, ...theme.screenTitle },
  modeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  modeBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgCard,
  },
  modeBtnActive: { borderColor: theme.accent, backgroundColor: theme.accent },
  modeText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  modeTextActive: { color: theme.bg },
  questionBanner: {
    marginHorizontal: 12, marginBottom: 4, padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: theme.amber,
  },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  questionText: { color: theme.amber, fontSize: 14, fontWeight: '600', flex: 1 },
  questionHint: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  permBox: { paddingHorizontal: 12, paddingTop: 4 },
  recovBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 4,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)',
  },
  recovTextWrap: { flex: 1 },
  stdBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 4,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)',
  },
  stdTitle: { color: theme.warnSoft, fontSize: 13, fontWeight: '700' },
  stdObjective: { color: 'rgba(253,230,138,0.6)', fontSize: 11, marginTop: 1 },
  stdBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: 'rgba(245,158,11,0.2)',
  },
  stdBtnText: { color: theme.warnSoft, fontSize: 12, fontWeight: '700' },
  recovTitle: { color: theme.dangerSoft, fontSize: 13, fontWeight: '700' },
  recovObjective: { color: 'rgba(254,202,202,0.6)', fontSize: 11, marginTop: 1 },
  recovBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.2)',
  },
  recovBtnText: { color: theme.dangerSoft, fontSize: 12, fontWeight: '700' },
  recovDismiss: { paddingHorizontal: 6, paddingVertical: 4 },
  recovDismissText: { color: 'rgba(254,202,202,0.6)', fontSize: 18, fontWeight: '700', lineHeight: 18 },
  targetRow: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 12, paddingBottom: 6,
  },
  targetLabel: { color: theme.textFaint, fontSize: 11, fontWeight: '700' },
  targetChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  targetChipOn: { borderColor: theme.accent, backgroundColor: theme.bgCard },
  targetChipOff: { borderColor: theme.border, backgroundColor: theme.bgElevated, opacity: 0.5 },
  targetChipText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  targetChipTextOn: { color: theme.accentSoft },
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
  sendText: { color: theme.bg, fontWeight: '800' },
});
