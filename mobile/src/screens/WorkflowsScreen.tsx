import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl,
  ScrollView, Keyboard, TouchableWithoutFeedback,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Workflow } from '../types';
import { PlayIcon } from '../components/Icons';

/** Colors for a run's lifecycle. Templates themselves are always 'pending'. */
const runColor: Record<string, string> = {
  running: theme.teal,
  paused: theme.amber,
  completed: theme.textDim,
  failed: theme.danger,
  cancelled: theme.textFaint,
  pending: theme.textDim,
};

export function WorkflowsScreen({ onOpenRun }: { onOpenRun?: (run: Workflow) => void }) {
  const { baseUrl, agents, onWorkflowUpdate } = useNeonCore();

  // Only cartridges that can actually execute. Offering a dead one would just hand the user
  // a run that fails at step 1. Hidden ones are fine — running a workflow on a dismissed
  // cartridge un-hides it anyway.
  const liveAgents = agents.filter((a) => a.status !== 'offline');

  const [templates, setTemplates] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  // Finished runs are collapsed by default — they're reference, not the thing you act on,
  // and the full list crowds out ACTIVE and TEMPLATES. Tap the header to expand.
  const [recentOpen, setRecentOpen] = useState(false);

  // The template the user has tapped — we ask for context before launching,
  // because a workflow with no brief is rarely what you want.
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [context, setContext] = useState('');
  const [starting, setStarting] = useState(false);
  // Which cartridge the workflow runs on. Template steps ship as `__deferred__` ("ask at
  // launch"), so without this every mobile-launched run hung silently at step 1.
  const [agentId, setAgentId] = useState('');

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      api.listWorkflowTemplates(baseUrl).catch(() => [] as Workflow[]),
      api.listWorkflowRuns(baseUrl).catch(() => [] as Workflow[]),
    ]);
    setTemplates(t);
    // Keep every run — active AND finished — so any of them can be opened and inspected on
    // the phone, same as the server dashboard. The render splits them into sections.
    setRuns(r);
  }, [baseUrl]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  // Live status changes: a run finishing moves it from ACTIVE to RECENT without a manual
  // refresh. workflow_updated carries no stepSummary, so spread over the existing row to
  // keep the "3/5 · repo" subline we already have.
  useEffect(() => {
    const off = onWorkflowUpdate((wf) => {
      if (!wf.templateId) return; // templates aren't runs
      setRuns((prev) => {
        const i = prev.findIndex((x) => x.id === wf.id);
        if (i === -1) return [wf, ...prev];
        const next = prev.slice();
        next[i] = { ...next[i], ...wf };
        return next;
      });
    });
    return off;
  }, [onWorkflowUpdate]);

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 3000);
  };

  const doRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const start = async () => {
    if (!selected) return;
    if (!agentId) {
      flash('Pick a cartridge to run this on.');
      return;
    }
    setStarting(true);
    try {
      await api.startWorkflow(baseUrl, selected.id, agentId, context.trim() || undefined);
      flash(`Started "${selected.name}"`);
      setSelected(null);
      setContext('');
      setAgentId('');
      await load();
    } catch (e) {
      flash(`Start failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.root}>
        <Header />
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      </View>
    );
  }

  // Launch sheet — chosen a template, now give it a brief.
  if (selected) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => setSelected(null)}>
            <Text style={styles.backText} numberOfLines={1}>‹ Workflows</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>Run</Text>
          <TouchableOpacity style={styles.done} onPress={() => Keyboard.dismiss()}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        {/* The brief is multiline, so there's no return key to dismiss with. Tapping anywhere
            outside the field closes the keyboard; scrolling does too. Without this you could
            get stuck with the keyboard up and RUN unreachable behind it.
            automaticallyAdjustKeyboardInsets (iOS) is what keeps the focused BRIEF field itself
            above the keyboard: it adds the keyboard height as a bottom inset AND scrolls the
            first responder into view — padding alone (the old KeyboardAvoidingView) only freed
            the RUN button, never the input. It's a no-op on Android, which resizes natively. */}
        <ScrollView
          contentContainerStyle={styles.sheet}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()} accessible={false}>
            <View>
          <Text style={styles.sheetName}>{selected.name}</Text>
          {selected.description ? (
            <Text style={styles.sheetDesc}>{selected.description}</Text>
          ) : null}

          <Text style={styles.label}>RUN ON</Text>
          {liveAgents.length === 0 ? (
            <Text style={styles.noAgents}>
              No live cartridges. Start an agent first — a workflow needs one to run on.
            </Text>
          ) : (
            <View style={styles.agentWrap}>
              {liveAgents.map((a) => {
                const on = a.id === agentId;
                return (
                  <TouchableOpacity
                    key={a.id}
                    style={[styles.agentChip, on && styles.agentChipOn]}
                    onPress={() => setAgentId(a.id)}
                  >
                    <Text style={[styles.agentChipText, on && styles.agentChipTextOn]} numberOfLines={1}>
                      {a.repoName || a.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          <Text style={styles.hint}>Every step of the workflow runs on this cartridge.</Text>

          <Text style={styles.label}>BRIEF (optional)</Text>
          <TextInput
            value={context}
            onChangeText={setContext}
            placeholder="What should this workflow work on?"
            placeholderTextColor={theme.textFaint}
            style={styles.contextInput}
            multiline
          />
          <Text style={styles.hint}>Passed to the workflow as its initial context.</Text>

          <TouchableOpacity
            style={[styles.runBtn, (!agentId || starting) && styles.runBtnOff]}
            onPress={start}
            disabled={starting || !agentId}
          >
            {starting ? (
              <ActivityIndicator color="#0d0f12" />
            ) : (
              <View style={styles.runBtnInner}>
                <PlayIcon size={16} color="#0d0f12" strokeWidth={2.5} />
                <Text style={styles.runBtnText}>RUN WORKFLOW</Text>
              </View>
            )}
          </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </View>
    );
  }

  // Split runs so both live and finished ones are reachable. Sorting is already newest-first
  // from the server (created_at DESC); the filter preserves it.
  const activeRuns = runs.filter((w) => w.status === 'running' || w.status === 'paused');
  const recentRuns = runs.filter((w) => w.status !== 'running' && w.status !== 'paused');
  const RECENT_CAP = 15;

  return (
    <View style={styles.root}>
      <Header />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <FlatList
        data={templates}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={theme.accent} />
        }
        ListHeaderComponent={
          <View style={styles.section}>
            {activeRuns.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>ACTIVE ({activeRuns.length})</Text>
                {activeRuns.map((r) => (
                  <RunRow key={r.id} run={r} onPress={() => onOpenRun?.(r)} />
                ))}
              </>
            )}
            {recentRuns.length > 0 && (
              <>
                <TouchableOpacity
                  style={styles.collapseHeader}
                  activeOpacity={0.6}
                  onPress={() => setRecentOpen((v) => !v)}
                >
                  <Text style={styles.sectionTitle}>RECENT ({recentRuns.length})</Text>
                  <Text style={styles.collapseChevron}>{recentOpen ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {recentOpen && (
                  <>
                    {recentRuns.slice(0, RECENT_CAP).map((r) => (
                      <RunRow key={r.id} run={r} onPress={() => onOpenRun?.(r)} />
                    ))}
                    {recentRuns.length > RECENT_CAP && (
                      <Text style={styles.moreNote}>
                        +{recentRuns.length - RECENT_CAP} older run{recentRuns.length - RECENT_CAP === 1 ? '' : 's'} not shown
                      </Text>
                    )}
                  </>
                )}
              </>
            )}
            <Text style={styles.sectionTitle}>TEMPLATES ({templates.length})</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>No workflow templates yet.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={() => setSelected(item)}>
            <View style={styles.cardTop}>
              <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
              <PlayIcon size={16} color={theme.accent} strokeWidth={2} />
            </View>
            {item.description ? (
              <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text>
            ) : null}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

/** One run row — status dot, "3/5 steps · repo" subline, status, chevron. Tap → step detail.
 *  Shared by the ACTIVE and RECENT sections so every run is inspectable, live or finished. */
function RunRow({ run, onPress }: { run: Workflow; onPress: () => void }) {
  const s = run.stepSummary;
  const sub = s
    ? `${s.completed}/${s.total} steps${s.projects.length ? ` · ${s.projects.join(', ')}` : ''}`
    : '';
  const color = runColor[run.status] ?? theme.textDim;
  return (
    <TouchableOpacity style={styles.runRow} activeOpacity={0.7} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.runRowText}>
        <Text style={styles.runName} numberOfLines={1}>
          {run.name} {run.runNumber ? `#${run.runNumber}` : ''}
        </Text>
        {sub ? <Text style={styles.runSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Text style={[styles.runStatus, { color }]}>{run.status.toUpperCase()}</Text>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function Header() {
  return (
    <View style={styles.tabHeader}>
      <Text style={styles.screenTitle}>Workflows</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  agentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  agentChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  agentChipOn: { borderColor: theme.accent, backgroundColor: theme.bgCard },
  agentChipText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  agentChipTextOn: { color: theme.accentSoft },
  noAgents: { color: theme.amber, fontSize: 13, marginBottom: 4 },
  runBtnOff: { opacity: 0.4 },
  root: { flex: 1, backgroundColor: theme.bg },
  // Top-level tab screen: big title, matching the Cartridges list.
  tabHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  screenTitle: { color: theme.text, fontSize: 26, fontWeight: '800' },
  // Pushed "Run" sheet: centered title with a back affordance.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  back: { width: 96 },
  backText: { color: theme.accentSoft, fontSize: 15 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center' },

  section: {},
  sectionTitle: {
    color: theme.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    marginHorizontal: 16, marginTop: 14, marginBottom: 6,
  },

  runRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginVertical: 4, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: theme.bgCard, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  runRowText: { flex: 1 },
  runName: { color: theme.text, fontSize: 14 },
  runSub: { color: theme.textDim, fontSize: 11, marginTop: 2 },
  runStatus: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  chevron: { color: theme.textFaint, fontSize: 18, marginLeft: 2 },
  moreNote: { color: theme.textFaint, fontSize: 11, marginHorizontal: 16, marginTop: 4 },
  collapseHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  collapseChevron: { color: theme.textFaint, fontSize: 12, marginRight: 16 },

  card: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, padding: 14, marginHorizontal: 12, marginVertical: 5,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, marginRight: 8 },
  runIcon: { color: theme.accent, fontSize: 14, fontWeight: '700' },
  cardDesc: { color: theme.textDim, fontSize: 13, marginTop: 6, lineHeight: 18 },

  sheet: { padding: 16, paddingBottom: 40 },
  done: { width: 96, alignItems: 'flex-end' },
  doneText: { color: theme.accentSoft, fontSize: 15, fontWeight: '700' },
  sheetName: { color: theme.text, fontSize: 22, fontWeight: '800' },
  sheetDesc: { color: theme.textDim, fontSize: 14, marginTop: 8, lineHeight: 20 },
  label: {
    color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    marginTop: 28, marginBottom: 8,
  },
  contextInput: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: theme.text, fontSize: 15, minHeight: 100, textAlignVertical: 'top',
  },
  hint: { color: theme.textFaint, fontSize: 12, marginTop: 8 },
  runBtn: {
    backgroundColor: theme.accent, borderRadius: 12,
    paddingVertical: 16, alignItems: 'center', marginTop: 24,
  },
  runBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runBtnText: { color: '#0d0f12', fontWeight: '800', letterSpacing: 1 },

  notice: { color: theme.teal, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 60 },
});
