import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../theme';
import type { PermissionRequest } from '../types';
import { QuestionIcon } from './Icons';

export type QOption = { label: string; description?: string };
export type Question = {
  id?: string;
  question: string;
  header?: string;
  options?: QOption[];
  multiSelect?: boolean;
};

export type DecideFn = (
  id: string,
  decision: 'allowed' | 'denied',
  response?: string | object,
) => void;

function questionKey(q: Question, i: number): string {
  return q.id?.trim() || q.question?.trim() || String(i);
}

export function parseQuestions(toolInput: string): Question[] {
  try {
    const parsed = JSON.parse(toolInput);
    if (Array.isArray(parsed?.questions)) return parsed.questions as Question[];
  } catch {
    /* not JSON */
  }
  return [];
}

/**
 * One actionable permission: an AskUserQuestion (answer it), an ExitPlanMode
 * (approve/reject the plan), or any other tool call (allow/deny).
 *
 * Rendered both in the Approvals tab and inline in the cartridge detail — you
 * should be able to answer a question from wherever you are looking at it.
 */
export function PermissionCard({
  perm,
  agentName,
  onDecide,
}: {
  perm: PermissionRequest;
  agentName?: string;
  onDecide: DecideFn;
}) {
  const isQuestion = perm.toolName === 'AskUserQuestion';
  const isPlan = perm.toolName === 'ExitPlanMode';
  const questions = isQuestion ? parseQuestions(perm.toolInput) : [];

  return (
    <View style={[styles.card, isQuestion && styles.cardQuestion]}>
      {!!agentName && <Text style={styles.agent}>{agentName}</Text>}
      <View style={styles.toolHead}>
        {isQuestion && <QuestionIcon size={17} color={theme.amber} strokeWidth={2} />}
        <Text style={[styles.tool, isQuestion && styles.toolQuestion]}>
          {isQuestion ? 'Question' : perm.toolName}
        </Text>
      </View>
      {!!perm.description && !isQuestion && <Text style={styles.desc}>{perm.description}</Text>}

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
  onDecide: DecideFn;
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
  card: {
    backgroundColor: theme.bgCard,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  cardQuestion: { borderColor: theme.amber },
  agent: { color: theme.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  tool: { color: theme.text, fontSize: 16, fontWeight: '700' },
  toolQuestion: { color: theme.amber },
  desc: { color: theme.textDim, fontSize: 13, marginTop: 6 },
  input: { color: theme.textFaint, fontSize: 12, fontFamily: 'monospace', marginTop: 6 },
  qText: { color: theme.text, fontSize: 15, fontWeight: '600', marginBottom: 8 },
  opt: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    backgroundColor: theme.bg,
  },
  optActive: { borderColor: theme.accent, backgroundColor: 'rgba(168,85,247,0.12)' },
  optLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  optLabelActive: { color: theme.accentSoft },
  optDesc: { color: theme.textDim, fontSize: 12, marginTop: 4, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  act: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  allow: { backgroundColor: theme.accent },
  allowText: { color: theme.bg, fontWeight: '800' },
  deny: { borderWidth: 1, borderColor: theme.border },
  denyText: { color: theme.textDim, fontWeight: '700' },
});
