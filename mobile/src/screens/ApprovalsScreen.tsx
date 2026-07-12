import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { PermissionRequest } from '../types';

type QOption = { label: string; description?: string };
type Question = { id?: string; question: string; header?: string; options?: QOption[]; multiSelect?: boolean };

function questionKey(q: Question, i: number): string {
  return q.id?.trim() || q.question?.trim() || String(i);
}

function parseQuestions(toolInput: string): Question[] {
  try {
    const parsed = JSON.parse(toolInput);
    if (Array.isArray(parsed?.questions)) return parsed.questions as Question[];
  } catch {
    /* not JSON */
  }
  return [];
}

export function ApprovalsScreen() {
  const { baseUrl, permissions, agents } = useNeonCore();

  const agentName = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a?.repoName || a?.name || id.slice(0, 8);
  };

  const decide = async (id: string, decision: 'allowed' | 'denied', response?: string | object) => {
    try {
      await api.decidePermission(baseUrl, id, decision, response);
    } catch {
      /* socket permission_decided will reconcile; ignore transient errors */
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabHeader}>
        <Text style={styles.screenTitle}>Approvals</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12 }}>
        {permissions.length === 0 && <Text style={styles.empty}>Nothing waiting. 🎉</Text>}
        {permissions.map((p) => (
          <PermissionCard key={p.id} perm={p} agentName={agentName(p.agentId)} onDecide={decide} />
        ))}
      </ScrollView>
    </View>
  );
}

function PermissionCard({
  perm,
  agentName,
  onDecide,
}: {
  perm: PermissionRequest;
  agentName: string;
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: string | object) => void;
}) {
  const isQuestion = perm.toolName === 'AskUserQuestion';
  const isPlan = perm.toolName === 'ExitPlanMode';
  const questions = isQuestion ? parseQuestions(perm.toolInput) : [];

  return (
    <View style={styles.card}>
      <Text style={styles.agent}>{agentName}</Text>
      <Text style={styles.tool}>{perm.toolName}</Text>
      {!!perm.description && <Text style={styles.desc}>{perm.description}</Text>}

      {isQuestion && questions.length > 0 ? (
        <QuestionAnswers perm={perm} questions={questions} onDecide={onDecide} />
      ) : isPlan ? (
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.act, styles.allow]} onPress={() => onDecide(perm.id, 'allowed')}>
            <Text style={styles.allowText}>Approve plan</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.act, styles.deny]} onPress={() => onDecide(perm.id, 'denied')}>
            <Text style={styles.denyText}>Reject</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {!perm.description && (
            <Text style={styles.input} numberOfLines={4}>
              {perm.toolInput}
            </Text>
          )}
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.act, styles.allow]} onPress={() => onDecide(perm.id, 'allowed')}>
              <Text style={styles.allowText}>Allow</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.act, styles.deny]} onPress={() => onDecide(perm.id, 'denied')}>
              <Text style={styles.denyText}>Deny</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

function QuestionAnswers({
  perm,
  questions,
  onDecide,
}: {
  perm: PermissionRequest;
  questions: Question[];
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: string | object) => void;
}) {
  const [sel, setSel] = useState<Record<string, string>>({});
  // Single question, single-select → answer immediately on tap.
  const single = questions.length === 1 && !questions[0].multiSelect;

  const pick = (qi: number, label: string) => {
    const key = questionKey(questions[qi], qi);
    if (single) {
      onDecide(perm.id, 'allowed', { answers: { [key]: label } });
    } else {
      setSel((prev) => ({ ...prev, [key]: label }));
    }
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      answers[questionKey(q, qi)] = sel[questionKey(q, qi)] || '';
    });
    onDecide(perm.id, 'allowed', { answers });
  };

  return (
    <View>
      {questions.map((q, qi) => {
        const key = questionKey(q, qi);
        return (
          <View key={key} style={{ marginTop: 10 }}>
            <Text style={styles.qText}>{q.question}</Text>
            {(q.options || []).map((opt, oi) => {
              const active = sel[key] === opt.label;
              return (
                <TouchableOpacity
                  key={oi}
                  style={[styles.opt, active && styles.optActive]}
                  onPress={() => pick(qi, opt.label)}
                >
                  <Text style={[styles.optLabel, active && styles.optLabelActive]}>{opt.label}</Text>
                  {!!opt.description && <Text style={styles.optDesc}>{opt.description}</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
      {!single && (
        <TouchableOpacity style={[styles.act, styles.allow, { marginTop: 12 }]} onPress={submit}>
          <Text style={styles.allowText}>Submit answers</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  tabHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  screenTitle: { color: theme.text, fontSize: 26, fontWeight: '800' },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 80 },
  card: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 14, padding: 14, marginBottom: 12,
  },
  agent: { color: theme.accentSoft, fontSize: 12, fontWeight: '700' },
  tool: { color: theme.text, fontSize: 16, fontWeight: '700', marginTop: 2 },
  desc: { color: theme.textDim, fontSize: 13, marginTop: 6, lineHeight: 18 },
  input: { color: theme.textFaint, fontSize: 12, fontFamily: 'monospace', marginTop: 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  act: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  allow: { backgroundColor: theme.teal },
  allowText: { color: '#0d0f12', fontWeight: '800' },
  deny: { borderWidth: 1, borderColor: theme.danger },
  denyText: { color: theme.danger, fontWeight: '700' },
  qText: { color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  opt: {
    borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 10, marginTop: 6,
    backgroundColor: theme.bg,
  },
  optActive: { borderColor: theme.accent, backgroundColor: 'rgba(168,85,247,0.15)' },
  optLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  optLabelActive: { color: theme.accentSoft },
  optDesc: { color: theme.textDim, fontSize: 12, marginTop: 2 },
});
