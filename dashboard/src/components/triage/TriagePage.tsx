/**
 * THE TRIAGE SECTION (docs/plans/bug-triage.md). Every new Jira bug, worked the way a careful
 * developer would — checked, reproduced, fixed, opened as a PR for review — with the reporter kept
 * informed. The agent proposes, people approve: nothing here merges or deploys.
 *   Board     every issue in its column: the seven stages, then where it rests
 *   Issue     one issue's whole audit trail, with Retry / Hand over / Reopen
 *   Messages  every comment sent to a reporter
 *   Metrics   the scope's measures of success
 *
 * The PAUSE switch is always on screen. Live through triage_* socket events.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../types';
import { triageApi as defaultApi, type TriageApi } from '../../lib/triageApi';
import { useSocket } from '../../hooks/useSocket';
import { TriageArt, type TriageArtName } from './art';
import type { TriageIssue, TriageMetrics, TriageSettings, TriageSource, TriageSocketEvent } from './types';
import { BoardTab } from './BoardTab';
import { IssueTab } from './IssueTab';
import { MessagesTab } from './MessagesTab';
import { MetricsTab } from './MetricsTab';
import { PauseSwitch } from './PauseSwitch';
import { SourceSettings, blankSource } from './SourceSettings';
import { BTN_GHOST, CARD, ErrorNote, INPUT, Loading } from './ui';

/** The tab registry, in order. Tests iterate it. */
export const TRIAGE_TABS = [
  { key: 'board', label: 'Board', art: 'stage-triage', hint: 'Every issue, by stage' },
  { key: 'issue', label: 'Issue', art: 'stage-code-check', hint: 'One issue, end to end' },
  { key: 'messages', label: 'Messages', art: 'stage-follow-up', hint: 'What each reporter was told' },
  { key: 'metrics', label: 'Metrics', art: 'stage-pr', hint: 'Measures of success' },
] as const satisfies readonly { key: string; label: string; art: TriageArtName; hint: string }[];
export type TriageTabKey = (typeof TRIAGE_TABS)[number]['key'];

const SOURCE_KEY = 'neoncore.triage.source';
const readSource = () => { try { return localStorage.getItem(SOURCE_KEY) ?? ''; } catch { return ''; } };
const writeSource = (id: string) => { try { localStorage.setItem(SOURCE_KEY, id); } catch { /* not remembered */ } };

export function TriagePage({ agents = [], api = defaultApi, origin }: { agents?: Agent[]; api?: TriageApi; origin?: string }) {
  const [sources, setSources] = useState<TriageSource[] | undefined>(undefined);
  const [sourceId, setSourceIdState] = useState(readSource);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [tab, setTab] = useState<TriageTabKey>('board');
  const [issues, setIssues] = useState<TriageIssue[] | undefined>(undefined);
  const [selected, setSelected] = useState('');
  const [settings, setSettings] = useState<TriageSettings | undefined>(undefined);
  const [metrics, setMetrics] = useState<TriageMetrics | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');

  const setSourceId = (id: string) => { setSourceIdState(id); writeSource(id); };
  const source = useMemo(() => sources?.find((s) => s.id === sourceId) ?? sources?.[0], [sources, sourceId]);
  const sid = source?.id ?? '';

  const loadSources = useCallback(async () => {
    try { setSources(await api.sources()); } catch (e) { setSources([]); setError((e as Error).message); }
  }, [api]);
  const loadSettings = useCallback(async () => {
    try { setSettings(await api.settings()); } catch (e) { setError((e as Error).message); }
  }, [api]);
  const loadIssues = useCallback(async () => {
    if (sid) try { setIssues(await api.issues(sid)); } catch (e) { setIssues([]); setError((e as Error).message); }
  }, [api, sid]);
  const loadMetrics = useCallback(async () => {
    if (sid) try { setMetrics(await api.metrics(sid)); } catch (e) { setError((e as Error).message); }
  }, [api, sid]);
  const loadDetail = useCallback((id: string) => api.issue(id), [api]);

  useEffect(() => { void loadSources(); void loadSettings(); }, [loadSources, loadSettings]);
  // A new source starts every tab from "loading", never from another source's records.
  useEffect(() => {
    setIssues(undefined); setMetrics(undefined); setSelected('');
    if (!sid) return;
    void loadIssues(); void loadMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const mine = (d: TriageSocketEvent) => !d.sourceId || d.sourceId === sid;
  useSocket({
    onTriageIssueUpdated: useCallback((d: TriageSocketEvent) => {
      if (!mine(d)) return;
      void loadIssues(); void loadMetrics(); setRefreshKey((k) => k + 1);
    }, [loadIssues, loadMetrics, sid]),
    onTriageEventAdded: useCallback((d: TriageSocketEvent) => { if (mine(d)) setRefreshKey((k) => k + 1); }, [sid]),
  });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const saveSource = (s: Omit<TriageSource, 'id'> & { id?: string }) => act(async () => {
    const saved = s.id ? await api.updateSource(s as TriageSource) : await api.createSource(s);
    await loadSources();
    if (saved.id) setSourceId(saved.id);
    setEditing(null);
  });
  const issueAction = (fn: (id: string) => Promise<unknown>) => (id: string) => act(async () => {
    await fn(id); await loadIssues(); setRefreshKey((k) => k + 1);
  });

  const header = (
    <div className="space-y-4">
      <TriageArt name={settings?.paused ? 'paused' : 'hero'} className={settings?.paused ? 'w-40' : 'w-full max-h-[260px]'} />
      <PauseSwitch settings={settings} busy={busy} onToggle={(paused) => act(async () => { setSettings(await api.updateSettings({ paused })); })} />
      <div className="flex items-center gap-3 flex-wrap">
        {sources && sources.length > 0 && (
          <select className={`${INPUT} glass-input w-auto min-w-[220px]`} value={source?.id ?? ''} onChange={(e) => setSourceId(e.target.value)} aria-label="Source">
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {source && <span className="font-mono text-[12px] text-gray-400">{source.jiraBaseUrl} · {source.projects.join(', ')}</span>}
        <span className="flex-1" />
        {source && <button className={BTN_GHOST} disabled={busy} onClick={() => act(async () => { await api.pollSource(source.id); await loadIssues(); })}>Check Jira now</button>}
        {source && <button className={BTN_GHOST} onClick={() => setEditing('edit')}>Source settings</button>}
        <button className={BTN_GHOST} onClick={() => setEditing('new')}>+ New source</button>
      </div>
      <ErrorNote error={error} />
    </div>
  );

  if (sources === undefined) return <div data-triage-page className="space-y-4">{header}<Loading what="sources" /></div>;

  if (editing || sources.length === 0) {
    return (
      <div data-triage-page className="space-y-4">
        {header}
        {sources.length === 0 && !editing && (
          <div className={`${CARD} text-[14px] text-gray-300`}>
            Connect a Jira site: its projects, the repository each one's code lives in, and the cartridge that triages. The agent proposes and people approve — it never merges or deploys. Start with the demo (<span className="font-mono">eval/triage-demo</span>).
          </div>
        )}
        <SourceSettings
          key={editing === 'edit' && source ? source.id : 'new'}
          initial={editing === 'edit' && source ? source : blankSource()}
          agents={agents}
          origin={here}
          onSave={saveSource}
          onCancel={sources.length > 0 ? () => setEditing(null) : undefined}
        />
      </div>
    );
  }

  const waiting = issues?.filter((i) => i.state === 'waiting_reporter' || i.state === 'waiting_review').length ?? 0;
  const badge: Partial<Record<TriageTabKey, number>> = { board: waiting };

  return (
    <div data-triage-page className="space-y-4">
      {header}
      <div role="tablist" aria-label="Triage views" className="flex items-center gap-1 p-1 rounded-xl bg-gl-surface/70 border border-white/[0.08] overflow-x-auto w-fit max-w-full">
        {TRIAGE_TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} title={t.hint} onClick={() => setTab(t.key)}
            className={`h-9 px-4 rounded-lg text-[13px] font-semibold whitespace-nowrap transition-colors ${
              tab === t.key ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'
            }`}>
            {t.label}
            {badge[t.key] ? <span className="ml-1.5 rounded-full px-1.5 text-[11px] bg-ember-500 text-ink">{badge[t.key]}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'board' && <BoardTab issues={issues} onOpen={(id) => { setSelected(id); setTab('issue'); }} />}
      {tab === 'issue' && (
        <IssueTab
          issues={issues}
          selectedId={selected}
          loadDetail={loadDetail}
          busy={busy}
          refreshKey={refreshKey}
          onRetry={issueAction(api.retry)}
          onHandover={issueAction(api.handover)}
          onReopen={issueAction(api.reopen)}
        />
      )}
      {tab === 'messages' && <MessagesTab issues={issues} loadDetail={loadDetail} refreshKey={refreshKey} />}
      {tab === 'metrics' && <MetricsTab metrics={metrics} />}
    </div>
  );
}
