import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Workflow, WorkflowStep, StepStatus, DecisionOption } from '../types';
import { PlayIcon, CheckCircleIcon } from '../components/Icons';

/** Per-step status colours — matches the dashboard canvas node dots. */
const stepColor: Record<StepStatus, string> = {
  pending: theme.textFaint,
  running: theme.teal,
  completed: theme.accentSoft,
  failed: theme.danger,
  skipped: theme.textDim,
};

const runColor: Record<string, string> = {
  running: theme.teal,
  paused: theme.amber,
  completed: theme.accentSoft,
  failed: theme.danger,
  cancelled: theme.textFaint,
  pending: theme.textDim,
};

/** Human labels for the executor types shown as a small badge on each step. */
const execLabel: Record<string, string> = {
  'claude-code': 'AGENT',
  'review-gate': 'REVIEW',
  'deliberation': 'PANEL',
  'quality-gate': 'GATE',
  'command': 'COMMAND',
  'connector': 'CONNECTOR',
  'decision': 'DECISION',
};

export function WorkflowRunDetailScreen({ run, onBack }: { run: Workflow; onBack: () => void }) {
  const { baseUrl, agents, onWorkflowStep, onWorkflowUpdate } = useNeonCore();

  const [workflow, setWorkflow] = useState<Workflow>(run);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busyStep, setBusyStep] = useState<string | null>(null);

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 3000);
  };

  const load = useCallback(async () => {
    const data = await api.getWorkflowV2(baseUrl, run.id).catch(() => null);
    if (data) {
      setWorkflow(data.workflow);
      // Preserve the canvas order: the server returns steps ordered by position.
      setSteps(data.steps);
    }
  }, [baseUrl, run.id]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  // Live updates — merge step patches by id (a recovery event carries only a few fields,
  // so spread over the existing row rather than replacing it). Ignore events for other runs.
  useEffect(() => {
    const offStep = onWorkflowStep((incoming) => {
      if (incoming.workflowId && incoming.workflowId !== run.id) return;
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.id === incoming.id);
        if (i === -1) return prev;
        const next = prev.slice();
        next[i] = { ...next[i], ...incoming };
        return next;
      });
    });
    const offRun = onWorkflowUpdate((wf) => {
      if (wf.id === run.id) setWorkflow(wf);
    });
    return () => { offStep(); offRun(); };
  }, [onWorkflowStep, onWorkflowUpdate, run.id]);

  // Safety net: sockets go quiet while the phone is backgrounded, so poll gently while the
  // run is still live. Stops once it reaches a terminal state.
  useEffect(() => {
    const live = workflow.status === 'running' || workflow.status === 'paused';
    if (!live) return;
    const t = setInterval(() => { load(); }, 5000);
    return () => clearInterval(t);
  }, [workflow.status, load]);

  const doRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  /** repoName/name for the cartridge a step runs on; '' when unassigned/deferred. */
  const cartridgeName = (executorId: string): string => {
    if (!executorId || executorId === '__deferred__') return '';
    const a = agents.find((x) => x.id === executorId);
    return a ? (a.repoName || a.name) : executorId.slice(0, 8);
  };

  // Wrap a step action: flip a per-step spinner, run it, surface errors, refetch.
  const act = async (stepId: string, fn: () => Promise<unknown>, ok: string) => {
    setBusyStep(stepId);
    try {
      await fn();
      flash(ok);
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyStep(null);
    }
  };

  const projects = workflow.stepSummary?.projects
    ?? [...new Set(steps.map((s) => cartridgeName(s.executorId)).filter(Boolean))];
  const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={onBack}>
          <Text style={styles.backText} numberOfLines={1}>‹ Workflows</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>Run</Text>
        <View style={styles.back} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={theme.accent} />
          }
        >
          {/* Run summary — name, status, and which cartridge(s)/project it runs on. */}
          <View style={styles.summary}>
            <View style={styles.summaryTop}>
              <Text style={styles.runName} numberOfLines={2}>
                {workflow.name}{workflow.runNumber ? ` #${workflow.runNumber}` : ''}
              </Text>
              <Text style={[styles.runStatus, { color: runColor[workflow.status] ?? theme.textDim }]}>
                {workflow.status.toUpperCase()}
              </Text>
            </View>
            {workflow.description ? (
              <Text style={styles.runDesc}>{workflow.description}</Text>
            ) : null}

            <Text style={styles.metaLabel}>RUNS ON</Text>
            {projects.length > 0 ? (
              <View style={styles.chips}>
                {projects.map((p) => (
                  <View key={p} style={styles.chip}>
                    <Text style={styles.chipText} numberOfLines={1}>{p}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.metaFaint}>No cartridge assigned yet.</Text>
            )}

            <Text style={styles.progress}>{done}/{steps.length} steps done</Text>

            {/* Run-level controls. */}
            <View style={styles.runControls}>
              {workflow.status === 'running' && (
                <TouchableOpacity
                  style={styles.ctrlBtn}
                  onPress={() => act(run.id, () => api.pauseWorkflow(baseUrl, run.id), 'Paused')}
                >
                  <Text style={styles.ctrlText}>Pause</Text>
                </TouchableOpacity>
              )}
              {workflow.status === 'paused' && (
                <TouchableOpacity
                  style={styles.ctrlBtn}
                  onPress={() => act(run.id, () => api.resumeWorkflow(baseUrl, run.id), 'Resumed')}
                >
                  <Text style={styles.ctrlText}>Resume</Text>
                </TouchableOpacity>
              )}
              {(workflow.status === 'running' || workflow.status === 'paused') && (
                <TouchableOpacity
                  style={[styles.ctrlBtn, styles.ctrlDanger]}
                  onPress={() => act(run.id, () => api.cancelWorkflow(baseUrl, run.id), 'Cancelled')}
                >
                  <Text style={[styles.ctrlText, { color: theme.danger }]}>Cancel run</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <Text style={styles.sectionTitle}>STEPS ({steps.length})</Text>
          {steps.map((step, i) => (
            <StepRow
              key={step.id}
              index={i}
              step={step}
              cartridge={cartridgeName(step.executorId)}
              expanded={expandedId === step.id}
              busy={busyStep === step.id}
              onToggle={() => setExpandedId((prev) => (prev === step.id ? null : step.id))}
              onComplete={() => act(step.id, () => api.completeWorkflowStep(baseUrl, run.id, step.id), 'Step marked complete')}
              onSkip={() => act(step.id, () => api.skipWorkflowStep(baseUrl, run.id, step.id), 'Step skipped')}
              onAdvance={() => act(step.id, () => api.advanceWorkflowStep(baseUrl, run.id, step.id), 'Advanced')}
              onRecover={() => act(step.id, () => api.recoverStep(baseUrl, step.id), 'Recovery dispatched')}
              onDecide={(optId) => act(step.id, () => api.decideWorkflowStep(baseUrl, run.id, step.id, optId), 'Decision recorded')}
              onSteer={(msg) => act(step.id, () => api.steerWorkflowStep(baseUrl, run.id, step.id, msg), 'Sent to cartridge')}
            />
          ))}
          {steps.length === 0 && (
            <Text style={styles.empty}>This run has no steps.</Text>
          )}
        </ScrollView>
      )}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </KeyboardAvoidingView>
  );
}

// ─── A single step: header row + inline expanded detail with actions ─────────────
function StepRow({
  index, step, cartridge, expanded, busy,
  onToggle, onComplete, onSkip, onAdvance, onRecover, onDecide, onSteer,
}: {
  index: number;
  step: WorkflowStep;
  cartridge: string;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onComplete: () => void;
  onSkip: () => void;
  onAdvance: () => void;
  onRecover: () => void;
  onDecide: (optionId: string) => void;
  onSteer: (message: string) => void;
}) {
  const [steer, setSteer] = useState('');
  const color = stepColor[step.status];
  const isDecision = step.executorType === 'decision';
  const options = isDecision
    ? ((step.executorConfig?.options as DecisionOption[]) || [])
    : [];
  const interrupted = step.recoveryStatus === 'interrupted' || step.recoveryStatus === 'recovery_failed';

  return (
    <View style={styles.stepCard}>
      <TouchableOpacity style={styles.stepHead} activeOpacity={0.7} onPress={onToggle}>
        <View style={[styles.stepDot, { backgroundColor: color }]} />
        <View style={styles.stepHeadText}>
          <Text style={styles.stepName} numberOfLines={1}>
            {index + 1}. {step.name}
          </Text>
          <View style={styles.stepMetaRow}>
            <Text style={[styles.stepBadge, { color }]}>{execLabel[step.executorType] || 'STEP'}</Text>
            {cartridge ? <Text style={styles.stepCartridge} numberOfLines={1}>· {cartridge}</Text> : null}
          </View>
        </View>
        <Text style={[styles.stepStatus, { color }]}>{step.status.toUpperCase()}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.stepBody}>
          {step.description ? <Text style={styles.stepDesc}>{step.description}</Text> : null}

          {step.error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{step.error}</Text>
            </View>
          ) : null}

          {step.result ? (
            <>
              <Text style={styles.blockLabel}>RESULT</Text>
              <Text style={styles.resultText}>{step.result}</Text>
            </>
          ) : null}

          {/* Decision step awaiting a human — show the question + option buttons. */}
          {isDecision && step.status === 'running' && options.length > 0 && (
            <>
              {typeof step.executorConfig?.question === 'string' && step.executorConfig.question ? (
                <Text style={styles.decisionQ}>{step.executorConfig.question as string}</Text>
              ) : null}
              {options.map((opt) => (
                <TouchableOpacity
                  key={opt.id}
                  style={styles.optionBtn}
                  disabled={busy}
                  onPress={() => onDecide(opt.id)}
                >
                  <Text style={styles.optionLabel}>{opt.label || opt.id}</Text>
                  {opt.description ? <Text style={styles.optionDesc}>{opt.description}</Text> : null}
                </TouchableOpacity>
              ))}
            </>
          )}

          {/* Action buttons — mirror the web canvas node buttons. */}
          <View style={styles.actions}>
            {interrupted && (
              <TouchableOpacity style={styles.actBtn} disabled={busy} onPress={onRecover}>
                <Text style={styles.actText}>
                  {step.recoveryStatus === 'recovery_failed' ? 'Retry recovery' : 'Resume interrupted step'}
                </Text>
              </TouchableOpacity>
            )}
            {step.recoveryStatus === 'recovering' && (
              <Text style={styles.metaFaint}>Recovering…</Text>
            )}
            {step.status === 'running' && !interrupted && !isDecision && (
              <TouchableOpacity style={styles.actBtn} disabled={busy} onPress={onComplete}>
                <View style={styles.actInner}>
                  <CheckCircleIcon size={14} color={theme.accentSoft} />
                  <Text style={styles.actText}>Mark complete</Text>
                </View>
              </TouchableOpacity>
            )}
            {step.status === 'completed' && !step.autoAdvance && (
              <TouchableOpacity style={styles.actBtn} disabled={busy} onPress={onAdvance}>
                <View style={styles.actInner}>
                  <PlayIcon size={13} color={theme.accentSoft} strokeWidth={2} />
                  <Text style={styles.actText}>Advance</Text>
                </View>
              </TouchableOpacity>
            )}
            {(step.status === 'running' || step.status === 'pending') && !interrupted && (
              <TouchableOpacity style={[styles.actBtn, styles.actGhost]} disabled={busy} onPress={onSkip}>
                <Text style={[styles.actText, { color: theme.textDim }]}>Skip</Text>
              </TouchableOpacity>
            )}
            {busy && <ActivityIndicator color={theme.accent} style={{ marginLeft: 4 }} />}
          </View>

          {/* Steer — inject a mid-task message to the cartridge running a claude-code step. */}
          {step.status === 'running' && step.executorType === 'claude-code'
            && step.executorId && step.executorId !== '__deferred__' && (
            <View style={styles.steerRow}>
              <TextInput
                value={steer}
                onChangeText={setSteer}
                placeholder="Steer this step…"
                placeholderTextColor={theme.textFaint}
                style={styles.steerInput}
                returnKeyType="send"
                onSubmitEditing={() => {
                  const m = steer.trim();
                  if (m) { onSteer(m); setSteer(''); }
                }}
              />
              <TouchableOpacity
                style={[styles.steerBtn, (!steer.trim() || busy) && styles.steerBtnOff]}
                disabled={!steer.trim() || busy}
                onPress={() => {
                  const m = steer.trim();
                  if (m) { onSteer(m); setSteer(''); }
                }}
              >
                <Text style={styles.steerBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
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

  body: { padding: 12, paddingBottom: 48 },

  summary: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, padding: 14,
  },
  summaryTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  runName: { color: theme.text, fontSize: 18, fontWeight: '800', flex: 1 },
  runStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginTop: 2 },
  runDesc: { color: theme.textDim, fontSize: 13, marginTop: 8, lineHeight: 18 },
  metaLabel: {
    color: theme.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1,
    marginTop: 16, marginBottom: 8,
  },
  metaFaint: { color: theme.textFaint, fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  chipText: { color: theme.accentSoft, fontSize: 12, fontWeight: '600' },
  progress: { color: theme.textDim, fontSize: 12, marginTop: 14 },

  runControls: { flexDirection: 'row', gap: 8, marginTop: 14 },
  ctrlBtn: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  ctrlDanger: { borderColor: theme.danger },
  ctrlText: { color: theme.text, fontSize: 13, fontWeight: '600' },

  sectionTitle: {
    color: theme.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    marginTop: 20, marginBottom: 8, marginLeft: 2,
  },

  stepCard: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, marginBottom: 8, overflow: 'hidden',
  },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  stepDot: { width: 9, height: 9, borderRadius: 5 },
  stepHeadText: { flex: 1 },
  stepName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  stepMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  stepBadge: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  stepCartridge: { color: theme.textDim, fontSize: 11, flexShrink: 1 },
  stepStatus: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

  stepBody: {
    paddingHorizontal: 12, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: theme.border,
  },
  stepDesc: { color: theme.textDim, fontSize: 13, lineHeight: 19, marginTop: 10 },
  blockLabel: {
    color: theme.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginTop: 12, marginBottom: 6,
  },
  resultText: {
    color: theme.text, fontSize: 12, lineHeight: 18,
    backgroundColor: theme.bgElevated, borderRadius: 8, padding: 10,
  },
  errorBox: {
    backgroundColor: 'rgba(255,107,107,0.08)', borderWidth: 1, borderColor: theme.danger,
    borderRadius: 8, padding: 10, marginTop: 12,
  },
  errorText: { color: theme.danger, fontSize: 12, lineHeight: 18 },

  decisionQ: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 14, marginBottom: 10 },
  optionBtn: {
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.accent,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  optionLabel: { color: theme.accentSoft, fontSize: 14, fontWeight: '700' },
  optionDesc: { color: theme.textDim, fontSize: 12, marginTop: 4, lineHeight: 17 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 },
  actBtn: {
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.accent,
  },
  actGhost: { borderColor: theme.border },
  actInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actText: { color: theme.accentSoft, fontSize: 13, fontWeight: '600' },

  steerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  steerInput: {
    flex: 1, backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: theme.text, fontSize: 14,
  },
  steerBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.accent,
  },
  steerBtnOff: { opacity: 0.4 },
  steerBtnText: { color: '#0d0f12', fontWeight: '700', fontSize: 13 },

  notice: { color: theme.teal, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40 },
});
