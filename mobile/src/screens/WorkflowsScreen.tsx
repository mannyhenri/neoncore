import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Workflow } from '../types';

/** Colors for a run's lifecycle. Templates themselves are always 'pending'. */
const runColor: Record<string, string> = {
  running: theme.teal,
  paused: theme.amber,
  completed: theme.textDim,
  failed: theme.danger,
  cancelled: theme.textFaint,
  pending: theme.textDim,
};

export function WorkflowsScreen({ onBack }: { onBack: () => void }) {
  const { baseUrl } = useNeonCore();

  const [templates, setTemplates] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  // The template the user has tapped — we ask for context before launching,
  // because a workflow with no brief is rarely what you want.
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [context, setContext] = useState('');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      api.listWorkflowTemplates(baseUrl).catch(() => [] as Workflow[]),
      api.listWorkflowRuns(baseUrl).catch(() => [] as Workflow[]),
    ]);
    setTemplates(t);
    // Only the runs that are still alive are worth surfacing on a phone.
    setRuns(r.filter((w) => w.status === 'running' || w.status === 'paused'));
  }, [baseUrl]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

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
    setStarting(true);
    try {
      await api.startWorkflow(baseUrl, selected.id, context.trim() || undefined);
      flash(`Started "${selected.name}"`);
      setSelected(null);
      setContext('');
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
        <Header onBack={onBack} />
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      </View>
    );
  }

  // Launch sheet — chosen a template, now give it a brief.
  if (selected) {
    return (
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={() => setSelected(null)}>
            <Text style={styles.backText} numberOfLines={1}>‹ Workflows</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>Run</Text>
          <View style={{ width: 96 }} />
        </View>

        <View style={styles.sheet}>
          <Text style={styles.sheetName}>{selected.name}</Text>
          {selected.description ? (
            <Text style={styles.sheetDesc}>{selected.description}</Text>
          ) : null}

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

          <TouchableOpacity style={styles.runBtn} onPress={start} disabled={starting}>
            {starting ? (
              <ActivityIndicator color="#0d0f12" />
            ) : (
              <Text style={styles.runBtnText}>▶ RUN WORKFLOW</Text>
            )}
          </TouchableOpacity>
        </View>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.root}>
      <Header onBack={onBack} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <FlatList
        data={templates}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={theme.accent} />
        }
        ListHeaderComponent={
          runs.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>ACTIVE ({runs.length})</Text>
              {runs.map((r) => (
                <View key={r.id} style={styles.runRow}>
                  <View style={[styles.dot, { backgroundColor: runColor[r.status] ?? theme.textDim }]} />
                  <Text style={styles.runName} numberOfLines={1}>
                    {r.name} {r.runNumber ? `#${r.runNumber}` : ''}
                  </Text>
                  <Text style={[styles.runStatus, { color: runColor[r.status] ?? theme.textDim }]}>
                    {r.status.toUpperCase()}
                  </Text>
                </View>
              ))}
              <Text style={styles.sectionTitle}>TEMPLATES ({templates.length})</Text>
            </View>
          ) : (
            <Text style={styles.sectionTitle}>TEMPLATES ({templates.length})</Text>
          )
        }
        ListEmptyComponent={<Text style={styles.empty}>No workflow templates yet.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={() => setSelected(item)}>
            <View style={styles.cardTop}>
              <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.runIcon}>▶</Text>
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

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.back} onPress={onBack}>
        <Text style={styles.backText} numberOfLines={1}>‹ Cartridges</Text>
      </TouchableOpacity>
      <Text style={styles.title} numberOfLines={1}>Workflows</Text>
      <View style={{ width: 96 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
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
  runName: { color: theme.text, fontSize: 14, flex: 1 },
  runStatus: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  card: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, padding: 14, marginHorizontal: 12, marginVertical: 5,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardName: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, marginRight: 8 },
  runIcon: { color: theme.accent, fontSize: 14, fontWeight: '700' },
  cardDesc: { color: theme.textDim, fontSize: 13, marginTop: 6, lineHeight: 18 },

  sheet: { padding: 16 },
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
  runBtnText: { color: '#0d0f12', fontWeight: '800', letterSpacing: 1 },

  notice: { color: theme.teal, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 60 },
});
