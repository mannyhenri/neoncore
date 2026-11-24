import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, Alert, RefreshControl, TextInput } from 'react-native';
import type { GoalPilotMeta, PilotCandidateRepo, PilotQuestion } from '@neoncore/client';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';
import { work, NEEDS, stepsEarned, pickPlanner, defaultStaffing, type GoalPilot, type NeedsYouItem, type ProjectSpec, type SpecFeature } from '../work';
import { Card, CardTop, Chip, ActionButton, PrimaryButton, StatusPill, useAdaptiveContent } from '../components/ui';
import { Badges } from '../components/Badges';
import { Celebrate } from '../components/Celebrate';
import type { FeatureRef } from './NeedsYouScreen';

type Answer = { value: string | string[]; delegated?: boolean };

const PHASE: Record<string, string> = {
  scoping: 'The planner is scoping it', clarifying: 'Questions for you', planning: 'The planner is planning',
  proposed: 'A plan to accept', staffing: 'Ready to start', running: 'Being built', paused: 'Stopped',
  completed: 'Built', cancelled: 'Cancelled',
};

/**
 * A FEATURE — where it stands and the next thing to do about it, all from the phone: start it
 * (scoping by a planner), answer the planner's questions (or leave one to the agents), accept or
 * revise the plan, start the pipeline, resume it, approve its tests, merge, and mark it done.
 */
export function FeatureScreen({ feature, onBack, onOpenRun }: { feature: FeatureRef; onBack: () => void; onOpenRun: (base: string, workflowId: string) => void }) {
  const { base, goalId } = feature;
  const [pilot, setPilot] = useState<GoalPilot | null>(null);
  const [spec, setSpec] = useState<ProjectSpec | null>(null);
  const [needs, setNeeds] = useState<NeedsYouItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const adaptive = useAdaptiveContent();
  const [busy, setBusy] = useState('');
  const [celebrating, setCelebrating] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pilots, sp, ny] = await Promise.allSettled([
        work.pilotsForFeature(base, goalId),
        feature.projectId ? work.spec(base, feature.projectId) : Promise.resolve(null),
        work.needsYou(base),
      ]);
      if (pilots.status === 'fulfilled') {
        const live = pilots.value.filter((p) => p.phase !== 'cancelled');
        setPilot([...(live.length ? live : pilots.value)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
      }
      if (sp.status === 'fulfilled') setSpec(sp.value);
      if (ny.status === 'fulfilled') setNeeds(ny.value.filter((n) => n.goalId === goalId));
      setError(pilots.status === 'rejected' ? String((pilots.reason as Error)?.message ?? pilots.reason) : '');
    } finally { setLoading(false); }
  }, [base, goalId, feature.projectId]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    try { await fn(); after?.(); } catch (e) { Alert.alert('Not done', e instanceof Error ? e.message.replace(/^\d+ [^—]*— /, '') : String(e)); } finally { setBusy(''); void load(); }
  };

  const f = spec?.features.find((x) => x.id === goalId) ?? null;
  const name = f?.name ?? pilot?.goalName ?? feature.name;
  const done = f?.status === 'done';
  const phase = pilot?.phase ?? '';
  const canStart = !done && (!pilot || phase === 'cancelled');

  return (
    <View style={s.page}>
      <View style={s.top}><Pressable onPress={onBack} hitSlop={12}><Text style={s.back}>‹ Back</Text></Pressable></View>
      <ScrollView contentContainerStyle={[s.content, adaptive]} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={theme.accent} />}>
        <View style={s.head}>
          <Text style={s.kicker}>FEATURE</Text>
          <Text style={s.name}>{name}</Text>
          {f?.intent?.summary ? <Text style={s.summary}>{f.intent.summary}</Text> : null}
          <View style={s.headRow}>
            <Badges base={base} earned={stepsEarned(phase, done)} size={22} />
            {phase ? <StatusPill label={done ? 'done' : PHASE[phase] ?? phase} color={done ? theme.success : pilot?.attention || phase === 'paused' ? theme.ember : theme.accent} /> : null}
          </View>
          {f?.targetDate && !done ? <Text style={s.faint}>Due {f.targetDate}</Text> : null}
        </View>

        {loading && !pilot && !spec ? <ActivityIndicator color={theme.accent} style={s.spin} /> : null}
        {error ? <Text style={s.err}>{error}</Text> : null}

        {needs.map((n) => <NeedCard key={n.key} n={n} busy={busy} base={base} act={act} onOpenRun={onOpenRun} onDone={() => setCelebrating(name)} />)}

        {f?.status === 'delivered' && !needs.some((n) => n.kind === 'mark-done') ? (
          <Card accent={theme.ember}>
            <Text style={s.section}>Delivered — sign it off</Text>
            <View style={s.actions}><PrimaryButton label={busy === 'done' ? 'Working…' : 'Mark done'} disabled={!!busy} onPress={() => act('done', () => work.markDone(base, goalId), () => setCelebrating(name))} /></View>
          </Card>
        ) : null}

        {canStart && !loading ? <StartCard base={base} feature={f} name={name} spec={spec} busy={busy} act={act} /> : null}
        {pilot && phase === 'clarifying' ? <Questions pilot={pilot} busy={busy} onSend={(a) => act('answers', () => work.answer(base, pilot.id, a))} /> : null}
        {pilot && phase === 'proposed' ? <PlanCard pilot={pilot} busy={busy}
          onAccept={() => act('accept', () => work.acceptPlan(base, pilot.id))} onRevise={() => act('revise', () => work.revisePlan(base, pilot.id))} /> : null}
        {pilot && phase === 'staffing' ? <StaffCard base={base} pilot={pilot} busy={busy} onStart={(repos) => act('start', () => work.startPipeline(base, pilot.id, repos))} /> : null}
        {pilot && (phase === 'scoping' || phase === 'planning') ? (
          <Card><Text style={s.section}>{PHASE[phase]}</Text><Text style={s.faint}>{pilot.plannerName ? `${pilot.plannerName} is on it.` : 'Waiting for the planner.'} This page updates by itself.</Text></Card>
        ) : null}
        {pilot && pilot.stages.length > 0 ? <Stages pilot={pilot} base={base} busy={busy} act={act} onOpenRun={onOpenRun} /> : null}
        {f ? <Criteria f={f} /> : null}
      </ScrollView>
      <Celebrate name={celebrating} onDone={() => setCelebrating(null)} />
    </View>
  );
}

type Act = (key: string, fn: () => Promise<unknown>, after?: () => void) => Promise<void>;

function NeedCard({ n, busy, base, act, onOpenRun, onDone }: { n: NeedsYouItem; busy: string; base: string; act: Act; onOpenRun: (b: string, w: string) => void; onDone: () => void }) {
  const meta = NEEDS[n.kind] ?? { label: n.kind, action: null };
  const go: (() => void) | null = (() => {
    switch (n.kind) {
      case 'plan': return () => void act(n.key, () => work.acceptPlan(base, n.pilotId));
      case 'tests': return () => void act(n.key, () => work.approveTests(base, n.pilotId));
      case 'stopped': return () => void act(n.key, () => work.resume(base, n.pilotId));
      case 'merge-blocked': return () => void act(n.key, () => work.merge(base, n.pilotId));
      case 'mark-done': return () => void act(n.key, () => work.markDone(base, n.goalId), onDone);
      case 'run': return () => onOpenRun(base, n.workflowId);
      default: return null;
    }
  })();
  // Questions, a plan and staffing have their own cards below — this one only says so.
  if (n.kind === 'questions' || n.kind === 'start') return null;
  return (
    <Card accent={theme.ember}>
      <CardTop><Chip label={meta.label} on /></CardTop>
      <Text style={s.what}>{n.what}</Text>
      {go && meta.action ? <View style={s.actions}><PrimaryButton label={busy === n.key ? 'Working…' : meta.action} disabled={!!busy} onPress={go} /></View> : null}
    </Card>
  );
}

/** Start the feature: the intake, prefilled from what the feature already says, and its planner. */
function StartCard({ base, feature, name, spec, busy, act }: { base: string; feature: SpecFeature | null; name: string; spec: ProjectSpec | null; busy: string; act: Act }) {
  const { agents } = useNeonCore();
  const [meta, setMeta] = useState<GoalPilotMeta | null>(null);
  const [intake, setIntake] = useState<Record<string, string>>({});
  useEffect(() => { work.meta(base).then(setMeta).catch(() => setMeta(null)); }, [base]);
  useEffect(() => {
    if (!meta) return;
    const pre: Record<string, string> = {};
    for (const q of meta.intakeQuestions) {
      pre[q.key] = q.key === 'goal' ? name
        : q.key === 'context' ? feature?.intent?.summary ?? ''
        : q.key === 'done' ? feature?.intent?.doneWhen ?? ''
        : q.key === 'deadline' ? feature?.targetDate ?? ''
        : q.kind === 'choice' ? q.options?.[0]?.value ?? '' : '';
    }
    setIntake(pre);
  }, [meta, name, feature]);
  const mine = agents.filter((a) => (a as { origin?: string }).origin === base);
  const planner = pickPlanner(mine, spec?.project.repos ?? []);
  if (!feature) return null;
  const missing = meta?.intakeQuestions.filter((q) => q.required && !String(intake[q.key] ?? '').trim()) ?? [];
  return (
    <Card>
      <Text style={s.section}>Start this feature</Text>
      <Text style={s.faint}>A planner scopes it, asks what it needs to, and proposes the plan.</Text>
      {!meta ? <ActivityIndicator color={theme.accent} style={s.spin} /> : meta.intakeQuestions.map((q) => (
        <View key={q.key} style={s.field}>
          <Text style={s.label}>{q.label}{q.required ? ' *' : ''}</Text>
          {q.kind === 'choice' && q.options ? (
            <View style={s.chips}>{q.options.map((o) => <Chip key={o.value} label={o.label} on={intake[q.key] === o.value} onPress={() => setIntake({ ...intake, [q.key]: o.value })} />)}</View>
          ) : (
            <TextInput style={[s.input, q.kind === 'textarea' ? s.area : null]} value={intake[q.key] ?? ''} multiline={q.kind === 'textarea'}
              placeholder={q.placeholder ?? (q.kind === 'date' ? 'YYYY-MM-DD' : '')} placeholderTextColor={theme.textFaint}
              keyboardType={q.kind === 'number' ? 'numeric' : 'default'} onChangeText={(v) => setIntake({ ...intake, [q.key]: v })} />
          )}
        </View>
      ))}
      <Text style={s.faint}>{planner ? `Planner: ${planner.name} (${planner.agentType}, ${planner.repoName || planner.repoPath})` : 'No cartridge is online to plan it — start one on the computer.'}</Text>
      <View style={s.actions}>
        <PrimaryButton label={busy === 'scope' ? 'Starting…' : 'Start scoping'} disabled={!!busy || !planner || missing.length > 0}
          onPress={() => planner && void act('scope', () => work.startFeature(base, { goalId: feature.id, intake, plannerAgentId: planner.id }))} />
      </View>
    </Card>
  );
}

/** The planner's open round: each question answered, or left to the agents (its suggested answer). */
function Questions({ pilot, busy, onSend }: { pilot: GoalPilot; busy: string; onSend: (a: Record<string, Answer>) => void }) {
  const round = [...pilot.rounds].reverse().find((r) => !r.answeredAt);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  if (!round) return null;
  const set = (id: string, a: Answer) => setAnswers({ ...answers, [id]: a });
  const missing = round.questions.filter((q) => q.required && !filled(answers[q.id]));
  return (
    <Card accent={theme.ember}>
      <Text style={s.section}>The planner asks</Text>
      {round.message ? <Text style={s.what}>{round.message}</Text> : null}
      {round.questions.map((q) => <QuestionField key={q.id} q={q} a={answers[q.id]} onChange={(a) => set(q.id, a)} />)}
      <View style={s.actions}>
        <PrimaryButton label={busy === 'answers' ? 'Sending…' : 'Send answers'} disabled={!!busy || missing.length > 0} onPress={() => onSend(answers)} />
        <ActionButton label="Let the agents decide all" onPress={() => setAnswers(Object.fromEntries(round.questions.map((q) => [q.id, { value: q.suggested, delegated: true }])))} />
      </View>
    </Card>
  );
}
const filled = (a?: Answer) => !!a && (Array.isArray(a.value) ? a.value.length > 0 : String(a.value).trim() !== '');

function QuestionField({ q, a, onChange }: { q: PilotQuestion; a?: Answer; onChange: (a: Answer) => void }) {
  const value = a?.value ?? (q.kind === 'multi' ? [] : '');
  const opts = q.kind === 'boolean' ? ['yes', 'no'] : q.options;
  return (
    <View style={s.field}>
      <Text style={s.label}>{q.text}{q.required ? ' *' : ''}</Text>
      {q.why ? <Text style={s.why}>{q.why}</Text> : null}
      {q.kind === 'text' ? (
        <TextInput style={[s.input, s.area]} multiline value={a?.delegated ? '' : String(value)} placeholder={q.suggested ? `Suggested: ${q.suggested}` : ''}
          placeholderTextColor={theme.textFaint} onChangeText={(v) => onChange({ value: v })} />
      ) : (
        <View style={s.chips}>
          {opts.map((o) => {
            const on = !a?.delegated && (Array.isArray(value) ? value.includes(o) : value === o);
            return <Chip key={o} label={o} on={on} onPress={() => {
              if (q.kind === 'multi') { const cur = Array.isArray(value) && !a?.delegated ? value : []; onChange({ value: on ? cur.filter((x) => x !== o) : [...cur, o] }); }
              else onChange({ value: o });
            }} />;
          })}
        </View>
      )}
      <Pressable onPress={() => onChange({ value: q.kind === 'multi' ? q.suggested.split(/\s*,\s*/).filter(Boolean) : q.suggested, delegated: true })} hitSlop={6}>
        <Text style={[s.delegate, a?.delegated ? s.delegateOn : null]}>{a?.delegated ? `✓ Left to the agents${q.suggested ? `: ${q.suggested}` : ''}` : 'Let the agents decide'}</Text>
      </Pressable>
    </View>
  );
}

function PlanCard({ pilot, busy, onAccept, onRevise }: { pilot: GoalPilot; busy: string; onAccept: () => void; onRevise: () => void }) {
  const brief = pilot.brief;
  const stages = pilot.proposal?.stages ?? [];
  return (
    <Card accent={theme.ember}>
      <Text style={s.section}>The plan</Text>
      {pilot.proposal?.message ? <Text style={s.what}>{pilot.proposal.message}</Text> : null}
      {brief?.summary ? <Text style={s.what}>{brief.summary}</Text> : null}
      {(pilot.criteria ?? []).length > 0 ? <Text style={s.label}>Done when</Text> : null}
      {(pilot.criteria ?? []).map((c) => <Text key={c.id} style={s.bullet}>{c.id}. {c.text}</Text>)}
      {stages.length > 0 ? <Text style={s.label}>Stages</Text> : null}
      {stages.map((st, i) => <Text key={st.key} style={s.bullet}>{i + 1}. {st.title}</Text>)}
      <View style={s.actions}>
        <PrimaryButton label={busy === 'accept' ? 'Working…' : 'Accept the plan'} disabled={!!busy} onPress={onAccept} />
        <ActionButton label="Ask for changes" disabled={!!busy} onPress={onRevise} />
      </View>
    </Card>
  );
}

function StaffCard({ base, pilot, busy, onStart }: { base: string; pilot: GoalPilot; busy: string; onStart: (repos: { repoPath: string; agentType: string }[]) => void }) {
  const [cands, setCands] = useState<PilotCandidateRepo[] | null>(null);
  useEffect(() => { work.candidates(base, pilot.goalId).then(setCands).catch(() => setCands([])); }, [base, pilot.goalId]);
  const repos = useMemo(() => defaultStaffing(cands ?? [], pilot.featureRepos ?? []), [cands, pilot.featureRepos]);
  return (
    <Card accent={theme.ember}>
      <Text style={s.section}>Start the pipeline</Text>
      {!cands ? <ActivityIndicator color={theme.accent} style={s.spin} /> : repos.length === 0 ? <Text style={s.faint}>No repo of this project has a cartridge — staff it on the dashboard.</Text> : null}
      {repos.map((r) => <Text key={r.repoPath} style={s.bullet}>{r.repoPath.split(/[\\/]/).pop()} · {r.agentType}</Text>)}
      <View style={s.actions}><PrimaryButton label={busy === 'start' ? 'Starting…' : 'Start'} disabled={!!busy || repos.length === 0} onPress={() => onStart(repos)} /></View>
    </Card>
  );
}

const STAGE_COLOR: Record<string, string> = { running: theme.accent, verifying: theme.accent, review: theme.ember, waiting: theme.ember, completed: theme.success, failed: theme.danger };

function Stages({ pilot, base, busy, act, onOpenRun }: { pilot: GoalPilot; base: string; busy: string; act: Act; onOpenRun: (b: string, w: string) => void }) {
  return (
    <Card>
      <CardTop>
        <Text style={s.section}>Pipeline</Text>
        {pilot.phase === 'paused' ? <ActionButton label={busy === 'resume' ? 'Working…' : 'Resume ▸'} tone="accent" disabled={!!busy} onPress={() => void act('resume', () => work.resume(base, pilot.id))} /> : null}
      </CardTop>
      {pilot.attention ? <Text style={s.attention}>{pilot.attention}</Text> : null}
      {pilot.stages.map((st) => {
        const color = STAGE_COLOR[st.status] ?? theme.textFaint;
        return (
          <Pressable key={st.id} disabled={!st.runId} onPress={() => onOpenRun(base, st.runId)} style={s.stage}>
            <View style={[s.stageDot, { backgroundColor: color }]} />
            <View style={s.stageText}>
              <Text style={s.stageTitle}>{st.position}. {st.title}</Text>
              <Text style={s.faint} numberOfLines={2}>
                {st.status}{st.progress ? ` · ${st.progress.completed}/${st.progress.total} steps` : ''}{st.attention ? ` · ${st.attention.reason}` : st.waitReason ? ` · ${st.waitReason}` : ''}
              </Text>
            </View>
            {st.runId ? <Text style={s.chev}>›</Text> : null}
          </Pressable>
        );
      })}
    </Card>
  );
}

function Criteria({ f }: { f: SpecFeature }) {
  if (!f.criteria?.length) return null;
  return (
    <Card>
      <CardTop><Text style={s.section}>Acceptance</Text><Text style={s.faint}>{f.criteriaMet}/{f.criteria.length} met</Text></CardTop>
      {f.criteria.map((c) => <Text key={c.id} style={[s.bullet, c.result === 'met' ? s.met : c.result === 'not-met' ? s.notMet : null]}>{c.result === 'met' ? '✓' : c.result === 'not-met' ? '✗' : '○'} {c.id}. {c.text}</Text>)}
    </Card>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bg },
  top: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  back: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  content: { paddingBottom: 40 },
  head: { marginHorizontal: 12, marginBottom: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.bgCard, gap: 6 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  kicker: { color: theme.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  name: { color: theme.text, fontSize: 21, fontWeight: '700' },
  summary: { color: theme.textDim, fontSize: 14, lineHeight: 19 },
  faint: { color: theme.textFaint, fontSize: 12, marginTop: 4 },
  spin: { marginTop: 16 },
  err: { color: theme.dangerSoft, fontSize: 12, marginHorizontal: 16, marginBottom: 6 },
  section: { color: theme.text, fontSize: 15, fontWeight: '700' },
  what: { color: theme.textDim, fontSize: 14, marginTop: 8, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' },
  field: { marginTop: 12, gap: 6 },
  label: { color: theme.text, fontSize: 13, fontWeight: '700', marginTop: 8 },
  why: { color: theme.textFaint, fontSize: 12 },
  input: { color: theme.text, backgroundColor: theme.bgWell, borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  area: { minHeight: 70, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  delegate: { color: theme.accentSoft, fontSize: 12, marginTop: 2 },
  delegateOn: { color: theme.success },
  bullet: { color: theme.textDim, fontSize: 13, marginTop: 4, lineHeight: 18 },
  met: { color: theme.success },
  notMet: { color: theme.ember },
  attention: { color: theme.warnSoft, fontSize: 13, marginTop: 8 },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.border, marginTop: 8 },
  stageDot: { width: 8, height: 8, borderRadius: 4 },
  stageText: { flex: 1 },
  stageTitle: { color: theme.text, fontSize: 14, fontWeight: '600' },
  chev: { color: theme.textFaint, fontSize: 20 },
});
