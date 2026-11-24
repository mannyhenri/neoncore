/**
 * THE QA SECTION (docs/plans/qa-section.md). Tests a web app with no hand-written scripts:
 *   Tests     plain-language tests; cached replays make no AI calls, a failed step self-repairs
 *   Runs      every run, its steps and evidence, and its HTML report
 *   Findings  what the Explorer found, deduplicated, each with a reproduction test
 *   Repairs   every repair, before → after, for a person to accept or reject
 *   Journeys  the Recorder: real usage grouped into journeys, coverage, tests generated from them
 *
 * NeonCore stores and replays; the target's CARTRIDGE does what needs judgment (writing a
 * test's actions the first time, a repair, exploring). Live through qa_* socket events.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../types';
import { qaApi as defaultApi, type QaApi } from '../../lib/qaApi';
import { useSocket } from '../../hooks/useSocket';
import { QaArt, type QaArtName } from './art';
import type { QaFinding, QaJourneys, QaRepair, QaRun, QaTarget, QaTest } from './types';
import { TestsTab } from './TestsTab';
import { RunsTab } from './RunsTab';
import { FindingsTab } from './FindingsTab';
import { RepairsTab } from './RepairsTab';
import { JourneysTab } from './JourneysTab';
import { TargetSettings, blankTarget } from './TargetSettings';
import { FeatureQa } from './FeatureQa';
import { EpicQaSection } from './EpicQaSection';
import { BTN_GHOST, CARD, ErrorNote, INPUT, Loading } from './ui';

/** The tab registry, in order. Tests iterate it. */
export const QA_TABS = [
  { key: 'tests', label: 'Tests', art: 'module-runner', hint: 'Plain-language tests' },
  { key: 'runs', label: 'Runs', art: 'module-runner', hint: 'History, steps and evidence' },
  { key: 'findings', label: 'Findings', art: 'module-explorer', hint: 'What the Explorer found' },
  { key: 'repairs', label: 'Repairs', art: 'empty-repairs', hint: 'Self-repairs to review' },
  { key: 'journeys', label: 'Journeys', art: 'module-recorder', hint: 'Recorded usage and coverage' },
] as const satisfies readonly { key: string; label: string; art: QaArtName; hint: string }[];
export type QaTabKey = (typeof QA_TABS)[number]['key'];

const TARGET_KEY = 'neoncore.qa.target';
const readTarget = () => { try { return localStorage.getItem(TARGET_KEY) ?? ''; } catch { return ''; } };
const writeTarget = (id: string) => { try { localStorage.setItem(TARGET_KEY, id); } catch { /* not remembered */ } };

export function QaPage({ agents = [], api = defaultApi, origin }: { agents?: Agent[]; api?: QaApi; origin?: string }) {
  const [targets, setTargets] = useState<QaTarget[] | undefined>(undefined);
  const [targetId, setTargetIdState] = useState(readTarget);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [tab, setTab] = useState<QaTabKey>('tests');
  const [tests, setTests] = useState<QaTest[] | undefined>(undefined);
  const [runs, setRuns] = useState<QaRun[] | undefined>(undefined);
  const [findings, setFindings] = useState<QaFinding[] | undefined>(undefined);
  const [repairs, setRepairs] = useState<QaRepair[] | undefined>(undefined);
  const [journeys, setJourneys] = useState<QaJourneys | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when a QA run moves: the features report reads again. */
  const [featureTick, setFeatureTick] = useState(0);
  const here = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');

  const setTargetId = (id: string) => { setTargetIdState(id); writeTarget(id); };
  const target = useMemo(() => targets?.find((t) => t.id === targetId) ?? targets?.[0], [targets, targetId]);

  const loadTargets = useCallback(async () => {
    try { setTargets(await api.targets()); } catch (e) { setTargets([]); setError((e as Error).message); }
  }, [api]);
  useEffect(() => { void loadTargets(); }, [loadTargets]);

  const tid = target?.id ?? '';
  const loadTests = useCallback(async () => { if (tid) try { setTests(await api.tests(tid)); } catch (e) { setTests([]); setError((e as Error).message); } }, [api, tid]);
  const loadRuns = useCallback(async () => { if (tid) try { setRuns(await api.runs(tid)); } catch (e) { setRuns([]); setError((e as Error).message); } }, [api, tid]);
  const loadFindings = useCallback(async () => { if (tid) try { setFindings(await api.findings(tid)); } catch (e) { setFindings([]); setError((e as Error).message); } }, [api, tid]);
  // GET /api/qa/repairs takes no target (the contract): every pending repair is listed.
  const loadRepairs = useCallback(async () => {
    if (!tid) return;
    try { setRepairs(await api.repairs('pending')); } catch (e) { setRepairs([]); setError((e as Error).message); }
  }, [api, tid]);
  const loadJourneys = useCallback(async () => { if (tid) try { setJourneys(await api.journeys(tid)); } catch (e) { setJourneys({ journeys: [], coverage: { covered: 0, total: 0 }, sessions: 0 }); setError((e as Error).message); } }, [api, tid]);

  // A new target starts every tab from "loading", never from another target's records.
  useEffect(() => {
    setTests(undefined); setRuns(undefined); setFindings(undefined); setRepairs(undefined); setJourneys(undefined);
    if (!tid) return;
    void loadTests(); void loadRuns(); void loadFindings(); void loadJourneys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);
  useEffect(() => { if (tid) void loadRepairs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tid]);

  const mine = (d: { targetId?: string }) => !d.targetId || d.targetId === tid;
  useSocket({
    onQaRunUpdated: useCallback((d: { targetId?: string }) => { setFeatureTick((n) => n + 1); if (mine(d)) { void loadRuns(); void loadTests(); } }, [loadRuns, loadTests, tid]),
    onQaFindingAdded: useCallback((d: { targetId?: string }) => { if (mine(d)) void loadFindings(); }, [loadFindings, tid]),
    onQaRepairAdded: useCallback((d: { targetId?: string }) => { if (mine(d)) void loadRepairs(); }, [loadRepairs, tid]),
  });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const saveTarget = (t: Omit<QaTarget, 'id'> & { id?: string }) => act(async () => {
    const saved = t.id ? await api.updateTarget(t as QaTarget) : await api.createTarget(t);
    await loadTargets();
    if (saved.id) setTargetId(saved.id);
    setEditing(null);
  });

  const header = (
    <div className="space-y-4">
      <QaArt name="hero" className="w-full max-h-[260px]" />
      {/* QA follows the feature: what is being built, tested by itself — before any hand-made test. */}
      {/* Epic QA: every feature's locked tests + the project's QA command, when an epic finishes — no web UI needed. */}
      {!editing && <EpicQaSection />}
      {!editing && <FeatureQa api={api} tick={featureTick} onAddTarget={() => setEditing('new')} />}
      <div className="flex items-center gap-3 flex-wrap">
        {targets && targets.length > 0 && (
          <select className={`${INPUT} glass-input w-auto min-w-[220px]`} value={target?.id ?? ''} onChange={(e) => setTargetId(e.target.value)} aria-label="Target">
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {target && <span className="font-mono text-[12px] text-gray-400">{target.baseUrl}</span>}
        <span className="flex-1" />
        {target && <button className={BTN_GHOST} onClick={() => setEditing('edit')}>Target settings</button>}
        <button className={BTN_GHOST} onClick={() => setEditing('new')}>+ New target</button>
      </div>
      <ErrorNote error={error} />
    </div>
  );

  if (targets === undefined) return <div data-qa-page className="space-y-4">{header}<Loading what="targets" /></div>;

  if (editing || targets.length === 0) {
    return (
      <div data-qa-page className="space-y-4">
        {header}
        {targets.length === 0 && !editing && (
          <div className={`${CARD} text-[14px] text-gray-300`}>
            Add the app you want to test: its URL, the hosts the browser may open, and the cartridge that does the AI work. Start with the demo app (<span className="font-mono">eval/qa-demo</span>).
          </div>
        )}
        <TargetSettings
          key={editing === 'edit' && target ? target.id : 'new'}
          initial={editing === 'edit' && target ? target : blankTarget()}
          agents={agents}
          onSave={saveTarget}
          onCancel={targets.length > 0 ? () => setEditing(null) : undefined}
        />
      </div>
    );
  }

  const pendingRepairs = repairs?.filter((r) => r.status === 'pending').length ?? 0;
  const openFindings = findings?.filter((f) => f.status === 'open').length ?? 0;
  const badge: Partial<Record<QaTabKey, number>> = { repairs: pendingRepairs, findings: openFindings };

  return (
    <div data-qa-page className="space-y-4">
      {header}
      <div role="tablist" aria-label="QA views" className="flex items-center gap-1 p-1 rounded-xl bg-gl-surface/70 border border-white/[0.08] overflow-x-auto w-fit max-w-full">
        {QA_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} title={t.hint} onClick={() => setTab(t.key)}
            className={`h-9 px-4 rounded-lg text-[13px] font-semibold whitespace-nowrap transition-colors ${
              tab === t.key ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'
            }`}>
            {t.label}
            {badge[t.key] ? <span className={`ml-1.5 rounded-full px-1.5 text-[11px] ${t.key === 'repairs' ? 'bg-ember-500 text-ink' : 'bg-neon-500 text-ink'}`}>{badge[t.key]}</span> : null}
          </button>
        ))}
      </div>

      {target && tab === 'tests' && (
        <TestsTab
          tests={tests}
          busy={busy}
          onCreate={(t) => act(async () => { await api.createTest({ targetId: target.id, ...t, source: 'manual' }); await loadTests(); })}
          onRun={(testIds) => act(async () => { await api.startRun({ targetId: target.id, kind: 'run', testIds }); await loadRuns(); setTab('runs'); })}
          onDelete={(id) => act(async () => { await api.deleteTest(id); await loadTests(); })}
        />
      )}
      {target && tab === 'runs' && <RunsTab runs={runs} loadDetail={(id) => api.run(id)} />}
      {target && tab === 'findings' && (
        <FindingsTab
          findings={findings}
          target={target}
          busy={busy}
          onExplore={(goal, budgets) => act(async () => { await api.startRun({ targetId: target.id, kind: 'explore', goal: goal || undefined, budgets }); await loadRuns(); })}
          onAddTest={(f) => act(async () => { await api.createTest({ targetId: target.id, name: f.title, sentences: f.sentences, source: 'explorer' }); await loadTests(); await loadFindings(); })}
          onDismiss={(f) => act(async () => { await api.setFindingStatus(f.id, 'dismissed'); await loadFindings(); })}
        />
      )}
      {target && tab === 'repairs' && (
        <RepairsTab
          repairs={repairs}
          onAccept={(r) => act(async () => { await api.acceptRepair(r.id); await loadRepairs(); await loadTests(); })}
          onReject={(r) => act(async () => { await api.rejectRepair(r.id); await loadRepairs(); await loadTests(); })}
        />
      )}
      {target && tab === 'journeys' && (
        <JourneysTab
          data={journeys}
          target={target}
          origin={here}
          busy={busy}
          onGenerate={() => act(async () => { await api.startRun({ targetId: target.id, kind: 'generate' }); await loadRuns(); })}
        />
      )}
    </div>
  );
}
