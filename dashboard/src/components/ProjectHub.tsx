/**
 * THE PROJECT AS THE SINGLE PLACE — the tabs beside the feature list (ProjectsPage.tsx):
 *
 *   Spec          every feature's intent beside the evidence for each acceptance criterion — and the
 *                 features whose delivered work does not (yet) match what was intended
 *   Roadmap       Now / Next / Later / Done, for a roadmap conversation — drag features between columns
 *   Changelog     what shipped: an entry per feature marked done, edited and released by a person
 *   Architecture  how the product is built
 *
 * Each document is kept from NeonCore's own records as features are built — and, for a codebase new to
 * NeonCore, can be written by a cartridge from the repos ("✦ Generate with AI", AiGenerate below):
 * reviewed item by item, kept only when applied.
 *
 * Plus the DocsBar: all of it published into the main repo as docs/product/, on demand or kept in sync.
 * Everything is read from the server (lib/project-spec.ts and friends) — nothing is computed twice.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import type { Agent, Project, ProjectSpec, SpecFeature, SpecAlignment, SpecStatus, ChangelogEntry, ChangeKind, ProjectImport, ImportPart } from '../types';
import { plannerCandidates } from '../lib/goalPilot';

const primaryBtn = 'h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const quietBtn = 'h-10 px-4 btn-ghost rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40';
const input = 'w-full glass-input rounded-[10px] px-3 py-2.5 text-[13px] text-gray-200 placeholder-gray-500 focus:outline-none';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '');
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function docUrl(projectId: string, doc: 'spec' | 'roadmap' | 'changelog' | 'architecture', opts: { html?: boolean; download?: boolean } = {}) {
  const q = [opts.html ? 'format=html' : '', opts.download ? 'download=1' : ''].filter(Boolean).join('&');
  return `/api/projects/${encodeURIComponent(projectId)}/docs/${doc}${q ? `?${q}` : ''}`;
}

export const STATUS_LABEL: Record<SpecStatus, string> = {
  existing: 'Existing', planned: 'Planned', 'in-progress': 'In progress', delivered: 'Delivered — sign off', done: 'Done', paused: 'Paused',
};
const STATUS_TONE: Record<SpecStatus, string> = {
  existing: 'bg-gl-teal/[0.1] border-gl-teal/45 text-[#9FF5EC]',
  planned: 'bg-white/[0.04] border-white/[0.14] text-gray-300',
  'in-progress': 'bg-neon-500/[0.16] border-neon-500/55 text-neon-200',
  delivered: 'bg-ember-500/[0.14] border-ember-500/50 text-ember-300',
  done: 'bg-emerald-400/[0.12] border-emerald-400/45 text-emerald-300',
  paused: 'bg-red-500/[0.12] border-red-400/45 text-red-200',
};
const ALIGN: Record<SpecAlignment, { label: string; tone: string }> = {
  verified: { label: 'Meets its criteria', tone: 'text-emerald-300' },
  partial: { label: 'Some criteria not met', tone: 'text-ember-300' },
  unverified: { label: 'Not verified', tone: 'text-ember-300' },
  'intent-only': { label: 'No criteria yet', tone: 'text-gray-500' },
  pending: { label: 'Criteria set', tone: 'text-gray-400' },
  documented: { label: 'Documented as it behaves today', tone: 'text-sky-300' },
};
const RESULT_ICON = { met: '✓', 'not-met': '✗', 'not-checked': '○' } as const;
const RESULT_TONE = { met: 'text-emerald-400', 'not-met': 'text-red-400', 'not-checked': 'text-gray-500' } as const;

function useSpec(projectId: string, version: number) {
  const [spec, setSpec] = useState<ProjectSpec | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.getProjectSpec(projectId).then((s) => { if (live) { setSpec(s); setError(''); } }).catch((e) => live && setError(errText(e)));
    return () => { live = false; };
  }, [projectId, version]);
  return { spec, error };
}

function Tile({ value, label, tone = 'text-gray-100' }: { value: React.ReactNode; label: string; tone?: string }) {
  return (
    <div className="rounded-[14px] border border-white/[0.1] bg-gl-surface/60 px-4 py-3 min-w-[120px]">
      <div className={`font-display text-[26px] font-semibold leading-tight ${tone}`}>{value}</div>
      <div className="text-[12px] text-gray-500">{label}</div>
    </div>
  );
}

// ── the docs bar ───────────────────────────────────────────────────────────────

export function DocsBar({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const repo = project.primaryRepo || project.cartridges?.[0] || '';
  const publish = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.publishProjectDocs(project.id);
      setMsg(r.written.length ? `Wrote ${r.written.length} file${r.written.length === 1 ? '' : 's'}${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}.` : 'Already up to date.');
      onChanged();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const toggle = async () => {
    try { await api.updateProject(project.id, { docsAutoPublish: !project.docsAutoPublish }); onChanged(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap rounded-[14px] border border-white/[0.1] bg-gl-surface/60 px-3 py-2">
      <div className="min-w-0 text-[13px] text-gray-400">
        <span className="text-gray-300">docs/product/</span>
        {repo ? <span> in <span className="text-gray-300">{repo.split(/[\\/]/).pop()}</span></span> : <span className="text-ember-300"> — add a repo to the project first</span>}
        <span className="text-gray-500"> · spec, a page per feature, roadmap, changelog, architecture · </span>
        {project.docsPublishedAt ? <span>published {ago(project.docsPublishedAt)}</span> : <span className="text-gray-500">not published yet</span>}
        {msg && <span className="text-emerald-400"> · {msg}</span>}
        {(err || project.docsPublishError) && <div className="text-[12px] text-ember-300 mt-0.5">{err || `Last publish failed: ${project.docsPublishError}`}</div>}
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[12px] text-gray-400 cursor-pointer" title="Rewrite docs/product/ whenever a feature changes: a plan accepted, a feature delivered or marked done, the list or the changelog edited">
          <input type="checkbox" className="accent-neon-500" checked={!!project.docsAutoPublish} onChange={toggle} disabled={!repo} />
          Keep in sync
        </label>
        <button onClick={publish} disabled={busy || !repo} className={quietBtn}>{busy ? 'Publishing…' : 'Publish now'}</button>
      </div>
    </div>
  );
}

// ── Spec ───────────────────────────────────────────────────────────────────────

function FeatureSpecCard({ f, onOpen }: { f: SpecFeature; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const a = ALIGN[f.alignment];
  return (
    <div className="rounded-[14px] border border-white/[0.1] bg-gl-surface/60">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2.5 flex items-center gap-3">
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${STATUS_TONE[f.status]}`}>{STATUS_LABEL[f.status]}</span>
        <span className="flex-1 min-w-0 text-[13px] text-gray-100 truncate">{f.name}</span>
        {f.criteria.length > 0 && (
          <span className="flex items-center gap-0.5 text-[13px]" title={`${f.criteriaMet} of ${f.criteria.length} criteria met`}>
            {f.criteria.map((c) => <span key={c.id} className={RESULT_TONE[c.result]}>{RESULT_ICON[c.result]}</span>)}
          </span>
        )}
        <span className={`text-[12px] whitespace-nowrap ${a.tone}`}>{a.label}</span>
        <span className="text-gray-500 text-[12px]">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-white/[0.05] pt-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <h5 className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-1">Intent</h5>
              <p className="text-[13px] text-gray-300 leading-relaxed">{f.intent.summary || <span className="text-gray-500 italic">Written when the feature is scoped.</span>}</p>
              {f.intent.doneWhen && <p className="text-[13px] text-gray-400 mt-1"><span className="text-gray-500">Done when: </span>{f.intent.doneWhen}</p>}
              {f.intent.outOfScope && <p className="text-[12px] text-gray-500 mt-1 whitespace-pre-wrap"><span className="text-gray-500">Out of scope: </span>{f.intent.outOfScope}</p>}
            </div>
            <div>
              <h5 className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-1">Delivered</h5>
              {f.delivery ? (
                <div className="text-[13px] text-gray-400 space-y-1">
                  <p>
                    {f.delivery.reportStatus && <span className="text-gray-200">{f.delivery.reportStatus} · </span>}
                    {f.delivery.workflows.join(' → ')}
                    {f.delivery.costUsd > 0 && <span className="text-emerald-400"> · ${f.delivery.costUsd.toFixed(2)}</span>}
                    {f.delivery.finishedAt && <span> · {day(f.delivery.finishedAt)}</span>}
                  </p>
                  {f.delivery.summary && <p className="text-gray-300 leading-relaxed">{f.delivery.summary}</p>}
                  {f.delivery.openItems.length > 0 && <p className="text-ember-300">{f.delivery.openItems.length} open item{f.delivery.openItems.length === 1 ? '' : 's'}</p>}
                </div>
              ) : <p className="text-[13px] text-gray-500 italic">{f.status === 'existing' ? 'Already in the product when the project was taken on.' : 'Not built yet.'}</p>}
            </div>
          </div>
          <div>
            <h5 className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-1">Acceptance criteria — intent vs what NeonCore found</h5>
            {f.criteria.length === 0 ? (
              <p className="text-[13px] text-gray-500 italic">None yet — there is nothing to check the delivered work against. Scoping the feature writes them.</p>
            ) : (
              <ul className="space-y-1.5">
                {f.criteria.map((c) => (
                  <li key={c.id} className="text-[13px] flex gap-2">
                    <span className={`${RESULT_TONE[c.result]} w-3`}>{RESULT_ICON[c.result]}</span>
                    <div className="min-w-0">
                      <span className="text-gray-500 font-mono text-[12px] mr-1">{c.id}</span>
                      <span className="text-gray-200">{c.text}</span>
                      {c.expect && <div className="text-gray-500">Expected: {c.expect}</div>}
                      {c.evidence && <div className="text-gray-500 truncate" title={c.evidence}>{c.verify === 'test' ? 'Test' : 'Review'}: {c.evidence}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {f.status !== 'existing' && <button onClick={() => onOpen(f.id)} className="text-[12px] text-neon-400 hover:text-neon-300">Open the feature →</button>}
        </div>
      )}
    </div>
  );
}

type SpecFilter = 'all' | 'gaps' | 'building' | 'done' | 'planned' | 'existing';

export function SpecTab({ project, agents, version, onOpenFeature, onChanged }: {
  project: Project; agents: Agent[]; version: number; onOpenFeature: (id: string) => void; onChanged: () => void;
}) {
  const { spec, error } = useSpec(project.id, version);
  const [filter, setFilter] = useState<SpecFilter>('all');
  if (error) return <p className="text-[13px] text-ember-300">{error}</p>;
  if (!spec) return <p className="text-[13px] text-gray-500">Loading…</p>;
  const t = spec.totals;
  // Built (delivered or done) and not matching its intent: criteria unmet or unchecked, or none to check.
  const isGap = (f: SpecFeature) => (f.status === 'done' || f.status === 'delivered')
    && (f.alignment === 'partial' || f.alignment === 'unverified' || f.alignment === 'intent-only');
  const shown = spec.features.filter((f) => filter === 'all' ? true
    : filter === 'gaps' ? isGap(f)
    : filter === 'building' ? ['in-progress', 'delivered', 'paused'].includes(f.status)
    : f.status === filter);
  const chips: [SpecFilter, string, number][] = [
    ['all', 'All', spec.features.length],
    ['gaps', 'Needs attention', spec.features.filter(isGap).length],
    ['building', 'In progress', t.inProgress + t.delivered + t.paused],
    ['done', 'Done', t.done],
    ['planned', 'Planned', t.planned],
    ['existing', 'Existing', t.existing],
  ];
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <Tile value={`${t.done}/${t.features - t.existing}`} label="planned features done" />
        <Tile value={t.verified} label="meet every criterion" tone="text-emerald-300" />
        <Tile value={t.gaps} label="delivered with gaps" tone={t.gaps ? 'text-ember-300' : 'text-gray-100'} />
        <Tile value={t.intentOnly} label="built without criteria" tone={t.intentOnly ? 'text-ember-300' : 'text-gray-100'} />
        {t.existing > 0 && <Tile value={t.existing} label="already in the product" tone="text-sky-200" />}
      </div>
      <p className="text-[13px] text-gray-500 max-w-2xl">
        The spec is every feature's <span className="text-gray-300">intent</span> (what was agreed when it was scoped) beside the
        <span className="text-gray-300"> evidence</span> for each acceptance criterion (NeonCore's own test runs and the independent
        reviewer's verdicts). It is generated from the records, so it is always current.
      </p>
      <AiGenerate project={project} agents={agents} version={version} onChanged={onChanged} parts={['features']}
        title={t.existing ? 'Document more of what the product already does' : 'Write the spec of what the product already does'}
        blurb={t.existing ? undefined : <>For a codebase new to NeonCore: a cartridge reads the docs and the code and proposes the
          features already there, each with acceptance criteria for how it behaves today. You tick what to keep.</>} />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {chips.map(([k, label, n]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`text-[12px] px-2.5 h-9 rounded-[10px] border ${filter === k ? 'bg-neon-500/20 border-neon-500/60 text-neon-50' : 'bg-white/[0.03] border-white/10 text-gray-400 hover:text-gray-200'}`}>
              {label} <span className="text-gray-500">{n}</span>
            </button>
          ))}
        </div>
        <a href={docUrl(project.id, 'spec', { download: true })} className="text-[12px] text-gray-400 hover:text-gray-200">Download spec (.md)</a>
      </div>
      <div className="space-y-1.5">
        {shown.length === 0 ? <p className="text-[13px] text-gray-500">Nothing here.</p> : shown.map((f) => <FeatureSpecCard key={f.id} f={f} onOpen={onOpenFeature} />)}
      </div>
    </div>
  );
}

// ── Roadmap ────────────────────────────────────────────────────────────────────

type Lane = 'now' | 'next' | 'later' | 'done';
const LANES: { key: Lane; title: string; empty: string; hint: string }[] = [
  { key: 'now', title: 'Now', empty: 'Nothing in progress.', hint: 'Being built — automatically while its pipeline runs' },
  { key: 'next', title: 'Next', empty: 'Nothing queued.', hint: 'Automatically the top of the feature list' },
  { key: 'later', title: 'Later', empty: 'Nothing further on the list.', hint: 'The rest of the list' },
  { key: 'done', title: 'Done', empty: 'Nothing finished yet.', hint: 'Marked done' },
];

/** The columns, as the server placed each feature (lib/project-spec.ts) — the page and the exports agree. */
function lanesOf(features: SpecFeature[]): Record<Lane, SpecFeature[]> {
  const r: Record<Lane, SpecFeature[]> = { now: [], next: [], later: [], done: [] };
  for (const f of features) if (f.column) r[f.column].push(f);
  r.done.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  return r;
}

export function RoadmapTab({ project, version, onOpenFeature, onChanged }: {
  project: Project; version: number; onOpenFeature: (id: string) => void; onChanged: () => void;
}) {
  const { spec, error } = useSpec(project.id, version);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Lane | null>(null);
  const [err, setErr] = useState('');
  if (error) return <p className="text-[13px] text-ember-300">{error}</p>;
  if (!spec) return <p className="text-[13px] text-gray-500">Loading…</p>;
  const lanes = lanesOf(spec.features);
  const t = spec.totals;
  const total = t.features - t.existing;

  /**
   * Put a feature in a column. Done is a status — moving there marks it done (its changelog entry is
   * written), moving out of it reopens it. The other columns are a placement the person chooses;
   * "automatic" hands it back to the rule.
   */
  const move = async (f: SpecFeature, to: Lane | 'auto') => {
    setErr('');
    try {
      if (to === 'done') {
        if (f.status === 'done') return;
        if (!confirm(`Mark "${f.name}" done? Its changelog entry is written from its records.`)) return;
        await api.updateGoal(f.id, { status: 'achieved', roadmapLane: '' });
      } else if (f.status === 'done') {
        await api.updateGoal(f.id, { status: 'active', roadmapLane: to === 'auto' ? '' : to });
      } else {
        await api.updateGoal(f.id, { roadmapLane: to === 'auto' ? '' : to });
      }
      onChanged();
    } catch (e) { setErr(errText(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[13px] text-gray-400">
          {t.done} of {total} features done · {t.inProgress + t.paused + t.delivered} in progress · {t.planned} to go
          {t.verified > 0 && <> · <span className="text-emerald-300">{t.verified} verified against their criteria</span></>}
        </p>
        <div className="flex items-center gap-2">
          <a href={docUrl(project.id, 'roadmap', { html: true })} target="_blank" rel="noreferrer" className={primaryBtn}>Open shareable page</a>
          <a href={docUrl(project.id, 'roadmap', { html: true, download: true })} className={quietBtn}>Download .html</a>
          <a href={docUrl(project.id, 'roadmap', { download: true })} className={quietBtn}>.md</a>
        </div>
      </div>
      {total > 0 && (
        <div className="h-1.5 bg-neon-500/10 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500/80 rounded-full" style={{ width: `${Math.round((t.done / total) * 100)}%` }} />
        </div>
      )}
      {err && <p className="text-[13px] text-ember-300">{err}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {LANES.map((lane) => {
          const items = lanes[lane.key];
          return (
            <div
              key={lane.key}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(lane.key); } }}
              onDragLeave={() => setOver((o) => (o === lane.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const f = spec.features.find((x) => x.id === e.dataTransfer.getData('text/plain'));
                setDragging(null); setOver(null);
                if (f) move(f, lane.key);
              }}
              className={`rounded-[18px] p-3 border bg-gl-code/70 transition-colors ${over === lane.key ? 'border-neon-500/70 shadow-[0_0_20px_rgba(90,174,255,0.25)]' : 'border-white/[0.08]'}`}
            >
              <h4 className="text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-2" title={lane.hint}>{lane.title} <span className="text-gray-500">{items.length}</span></h4>
              <div className="space-y-2 min-h-[48px]">
                {items.length === 0 ? <p className="text-[13px] text-gray-500 italic">{dragging ? 'Drop here' : lane.empty}</p> : items.map((f) => (
                  <div
                    key={f.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'move'; setDragging(f.id); }}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    className={`rounded-[14px] border border-white/[0.1] bg-gl-surface/60 hover:border-white/[0.2] px-3 py-2 cursor-grab active:cursor-grabbing ${dragging === f.id ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <button onClick={() => onOpenFeature(f.id)} className="flex-1 min-w-0 text-left text-[14px] font-semibold text-gray-100 hover:text-white">{f.name}</button>
                      <select
                        aria-label={`Move ${f.name}`}
                        value=""
                        onChange={(e) => { const v = e.target.value as Lane | 'auto'; if (v) move(f, v); }}
                        className="glass-input text-[11px] text-gray-300 rounded-[8px] px-1.5 py-1 cursor-pointer"
                      >
                        <option value="">Move…</option>
                        {LANES.filter((l) => l.key !== lane.key).map((l) => <option key={l.key} value={l.key}>to {l.title}</option>)}
                        {f.lane && f.status !== 'done' && <option value="auto">back to automatic</option>}
                      </select>
                    </div>
                    {f.intent.summary && <div className="text-[12px] text-gray-500 mt-0.5 line-clamp-2">{f.intent.summary}</div>}
                    <div className="flex gap-1.5 flex-wrap mt-1.5 text-[11px]">
                      {f.lane && f.status !== 'done' && <span className="px-1.5 py-0.5 rounded-full bg-white/[0.06] text-gray-400" title="You placed it here — the automatic rule no longer moves it">placed</span>}
                      {f.lane && f.lane !== 'now' && ['in-progress', 'paused', 'delivered'].includes(f.status) && <span className="px-1.5 py-0.5 rounded-full bg-neon-500/[0.16] text-neon-200">pipeline running</span>}
                      {f.status === 'paused' && <span className="px-1.5 py-0.5 rounded-full bg-red-500/[0.14] text-red-200">needs a decision</span>}
                      {f.status === 'delivered' && <span className="px-1.5 py-0.5 rounded-full bg-ember-500/[0.14] text-ember-300">awaiting sign-off</span>}
                      {f.criteria.length > 0 && f.status !== 'planned' && (
                        <span className={`px-1.5 py-0.5 rounded-full ${f.criteriaMet === f.criteria.length ? 'bg-emerald-400/[0.12] text-emerald-300' : 'bg-white/[0.06] text-gray-400'}`}>
                          {f.criteriaMet}/{f.criteria.length} criteria
                        </span>
                      )}
                      {f.targetDate && <span className="px-1.5 py-0.5 rounded-full bg-white/[0.06] text-gray-400">target {f.targetDate}</span>}
                      {f.status === 'done' && f.completedAt && <span className="px-1.5 py-0.5 rounded-full bg-emerald-400/[0.12] text-emerald-300">done {day(f.completedAt)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[12px] text-gray-500">
        Drag a feature to another column, or use Move… on its card. Without a placement, a feature is in Now while its pipeline runs,
        and in Next when it is among the top three of the feature list. Moving to Done marks it done; moving out of Done reopens it.
      </p>
    </div>
  );
}

// ── Changelog ──────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<ChangeKind, string> = { added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', security: 'Security' };
const KIND_TONE: Record<ChangeKind, string> = {
  added: 'bg-emerald-400/[0.12] text-emerald-300', changed: 'bg-sky-900/30 text-sky-200', fixed: 'bg-amber-900/30 text-ember-300',
  removed: 'bg-red-900/30 text-red-300', security: 'bg-fuchsia-900/30 text-fuchsia-200',
};

function EntryEditor({ initial, onSave, onCancel }: { initial?: Partial<ChangelogEntry>; onSave: (d: { kind: ChangeKind; title: string; body: string }) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<ChangeKind>(initial?.kind ?? 'added');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 rounded-[14px] border border-white/[0.1] bg-gl-code p-3">
      <div className="flex gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as ChangeKind)} className="glass-input rounded-[10px] px-2 py-1.5 text-[13px] text-gray-200">
          {(Object.keys(KIND_LABEL) as ChangeKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What changed, in a few words" autoFocus />
      </div>
      <textarea rows={3} className={input} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Details (optional) — a sentence, or lines starting with - " />
      <div className="flex gap-2">
        <button disabled={busy || !title.trim()} className={primaryBtn}
          onClick={async () => { setBusy(true); try { await onSave({ kind, title: title.trim(), body }); } finally { setBusy(false); } }}>Save</button>
        <button onClick={onCancel} className="px-3 py-1.5 text-[13px] text-gray-400 hover:text-gray-200">Cancel</button>
      </div>
    </div>
  );
}

export function ChangelogTab({ project, agents, version, onChanged }: { project: Project; agents: Agent[]; version: number; onChanged: () => void }) {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [release, setRelease] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.getProjectChangelog(project.id).then((d) => setEntries(d.entries)).catch((e) => setErr(errText(e))), [project.id]);
  useEffect(() => { load(); }, [load, version]);
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await load(); onChanged(); } catch (e) { setErr(errText(e)); } };

  const groups = useMemo(() => {
    const m = new Map<string, ChangelogEntry[]>();
    for (const e of entries ?? []) { const k = e.release || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(e); }
    return [...m.entries()];
  }, [entries]);
  const unreleased = (entries ?? []).filter((e) => !e.release).length;

  if (!entries) return <p className="text-[13px] text-gray-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[13px] text-gray-500 max-w-xl">An entry is written when a feature is marked done, from its report. Edit them, add your own, and cut a release when they ship.</p>
        <a href={docUrl(project.id, 'changelog', { download: true })} className="text-[12px] text-gray-400 hover:text-gray-200">Download CHANGELOG.md</a>
      </div>
      <AiGenerate project={project} agents={agents} version={version} onChanged={() => { load(); onChanged(); }} parts={['changelog']}
        title={entries.length ? 'Fill in history from git' : 'Write the changelog so far from git'}
        blurb={entries.length ? undefined : <>A cartridge reads the git history — commits, tags, merges — and any CHANGELOG already in the
          repo, and proposes entries grouped by release. You tick what to keep; entries already here are not proposed again.</>} />
      <div className="flex items-center gap-2 flex-wrap">
        {!adding && <button onClick={() => setAdding(true)} className={quietBtn}>+ Add an entry</button>}
        <div className="flex items-center gap-2 ml-auto">
          <input value={release} onChange={(e) => setRelease(e.target.value)} placeholder="Version, e.g. 1.4.0"
            className="glass-input rounded-[10px] px-2.5 py-1.5 text-[13px] text-gray-200 placeholder-gray-500 w-40" />
          <button disabled={!release.trim() || unreleased === 0} className={primaryBtn}
            onClick={() => act(async () => { await api.releaseChangelog(project.id, release.trim()); setRelease(''); })}
            title={unreleased ? `Ship the ${unreleased} unreleased entr${unreleased === 1 ? 'y' : 'ies'} in this version` : 'Nothing unreleased'}>
            Cut release{unreleased ? ` · ${unreleased}` : ''}
          </button>
        </div>
      </div>
      {err && <p className="text-[13px] text-ember-300">{err}</p>}
      {adding && <EntryEditor onCancel={() => setAdding(false)} onSave={(d) => act(async () => { await api.addChangelogEntry(project.id, d); setAdding(false); })} />}
      {groups.length === 0 && !adding && <p className="text-[13px] text-gray-500 italic">Nothing yet — mark a feature done and its entry appears here, or generate the history so far with AI above.</p>}
      {groups.map(([rel, list]) => (
        <div key={rel || 'unreleased'}>
          <h4 className="text-[13px] text-gray-300 font-semibold mb-2">{rel ? `${rel}` : 'Unreleased'}{rel && list[0].releasedAt && <span className="text-gray-500 font-normal"> — {day(list[0].releasedAt)}</span>}</h4>
          <div className="space-y-1.5">
            {list.map((e) => editing === e.id ? (
              <EntryEditor key={e.id} initial={e} onCancel={() => setEditing(null)}
                onSave={(d) => act(async () => { await api.updateChangelogEntry(project.id, e.id, d); setEditing(null); })} />
            ) : (
              <div key={e.id} className="group rounded-[14px] border border-white/[0.1] bg-gl-surface/60 px-3 py-2 flex gap-3">
                <span className={`text-[11px] h-fit px-1.5 py-0.5 rounded ${KIND_TONE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-100">{e.title}{e.goalId && <span className="text-[11px] text-gray-500 ml-2">from the feature</span>}</div>
                  {e.body && <div className="prose prose-invert prose-sm max-w-none text-[13px] text-gray-400"><Markdown remarkPlugins={[remarkGfm]}>{e.body}</Markdown></div>}
                </div>
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity text-[12px]">
                  <button onClick={() => setEditing(e.id)} className="text-gray-500 hover:text-gray-200">Edit</button>
                  <button onClick={() => { if (confirm('Delete this entry?')) act(() => api.deleteChangelogEntry(project.id, e.id)); }} className="text-gray-500 hover:text-red-400">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Generate with AI ───────────────────────────────────────────────────────────

/**
 * What a cartridge can be asked to write from the codebase (server lib/project-import.ts). Each tab asks
 * for its own part; the Architecture tab can ask for any mix — the "first time in NeonCore" case.
 */
const PARTS: { key: ImportPart; label: string; hint: string }[] = [
  { key: 'architecture', label: 'Architecture', hint: 'components, how data flows, the stack, where the tests are' },
  { key: 'features', label: 'Existing features + specs', hint: 'what the product already does, each with acceptance criteria for how it behaves today' },
  { key: 'changelog', label: 'Changelog', hint: 'the history of what shipped — from git commits and tags, and any CHANGELOG already there' },
  { key: 'backlog', label: 'Backlog', hint: 'work the code points at — TODOs, half-built paths — offered as planned features' },
];
const partsText = (parts: ImportPart[]) => {
  const names = parts.map((k) => PARTS.find((x) => x.key === k)!.label.toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Format cents as dollars." says nothing more than the name "Format cents as dollars". */
const sameText = (a: string, b: string) => a.trim().replace(/[.\s]+$/, '').toLowerCase() === b.trim().replace(/[.\s]+$/, '').toLowerCase();

function useImports(projectId: string, version: number) {
  const [imports, setImports] = useState<ProjectImport[] | null>(null);
  const load = useCallback(() => api.getProjectImports(projectId).then(setImports).catch(() => setImports([])), [projectId]);
  useEffect(() => { load(); }, [load, version]);
  const waiting = imports?.[0]?.status === 'pending';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [waiting, load]);
  return { imports, load };
}

/** The proposal, item by item. Nothing reaches the project until Apply — and only what is ticked. */
function ImportReview({ imp, onApplied, onCancel }: { imp: ProjectImport; onApplied: () => void; onCancel: () => void }) {
  const p = imp.proposal!;
  const [arch, setArch] = useState(p.architecture);
  const [useArch, setUseArch] = useState(!!p.architecture);
  const [features, setFeatures] = useState<Set<string>>(() => new Set(p.features.map((f) => f.name)));
  const [backlog, setBacklog] = useState<Set<string>>(() => new Set());
  const [changes, setChanges] = useState<Set<string>>(() => new Set(p.changelog.map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); setter(next);
  };
  const areas = [...new Set(p.features.map((f) => f.area || 'General'))];
  const releases = [...new Set(p.changelog.map((c) => c.release))];
  const asked = new Set(imp.parts);
  const kept = [
    useArch ? 'the architecture' : '',
    features.size ? plural(features.size, 'existing feature') : '',
    changes.size ? plural(changes.size, 'changelog entry', 'changelog entries') : '',
    backlog.size ? plural(backlog.size, 'backlog item') : '',
  ].filter(Boolean);
  const apply = async () => {
    setBusy(true); setErr('');
    try {
      await api.applyProjectImport(imp.id, { architecture: useArch ? arch : '', features: [...features], backlog: [...backlog], changelog: [...changes] });
      onApplied();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const tickAll = (on: boolean, all: string[], setter: (s: Set<string>) => void) => setter(on ? new Set(all) : new Set());
  return (
    <div className="space-y-4 rounded-[18px] panel-live p-4">
      <div>
        <h4 className="text-[13px] text-violet-100 font-semibold">✦ Review what the cartridge wrote — {partsText(imp.parts)}</h4>
        <p className="text-[13px] text-gray-400 mt-0.5">{p.message} Nothing is added until you apply — untick anything that is wrong, and edit the text.</p>
        {imp.notes.length > 0 && <p className="text-[12px] text-ember-300 mt-1">Adjusted on arrival: {imp.notes.join('; ')}</p>}
      </div>

      {asked.has('architecture') && (
        <div>
          <label className="flex items-center gap-2 text-[13px] text-gray-300 mb-1.5">
            <input type="checkbox" className="accent-neon-500" checked={useArch} onChange={() => setUseArch((v) => !v)} disabled={!p.architecture} />
            Architecture {p.architecture
              ? <span className="text-gray-500">— {p.architecture.split('\n').length} lines, editable{useArch ? ' below' : ''}; replaces what the project has</span>
              : <span className="text-gray-500">— none proposed</span>}
          </label>
          {p.architecture && useArch && <textarea rows={10} className={`${input} font-mono text-[12px]`} value={arch} onChange={(e) => setArch(e.target.value)} />}
        </div>
      )}

      {asked.has('features') && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <h5 className="text-[13px] text-gray-300">Already in the product — {features.size} of {p.features.length} kept <span className="text-gray-500">(join the list as existing features, their criteria as documented behaviour)</span></h5>
            {p.features.length > 0 && <button className="text-[12px] text-gray-500 hover:text-gray-300" onClick={() => tickAll(!features.size, p.features.map((f) => f.name), setFeatures)}>{features.size ? 'Untick all' : 'Tick all'}</button>}
          </div>
          {p.features.length === 0 ? <p className="text-[13px] text-gray-500">None proposed.</p> : areas.map((area) => (
            <div key={area} className="mb-2">
              <div className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-1">{area}</div>
              {p.features.filter((f) => (f.area || 'General') === area).map((f) => (
                <div key={f.name} className="flex items-start gap-2 py-1 text-[13px]">
                  <input type="checkbox" aria-label={`Keep ${f.name}`} className="accent-neon-500 mt-0.5 cursor-pointer" checked={features.has(f.name)} onChange={() => toggle(features, setFeatures, f.name)} />
                  <div className="min-w-0 flex-1">
                    <span className="text-gray-100">{f.name}</span>{f.description && !sameText(f.description, f.name) && <span className="text-gray-500"> — {f.description}</span>}
                    {f.evidence && <span className="block text-[11px] text-gray-500 font-mono truncate">{f.evidence}</span>}
                    {f.criteria.length > 0 && (
                      <details className="mt-0.5">
                        <summary className="text-[12px] text-violet-300/80 cursor-pointer select-none">{plural(f.criteria.length, 'acceptance criterion', 'acceptance criteria')}</summary>
                        <ul className="mt-1 space-y-0.5 pl-3 border-l border-white/10">
                          {f.criteria.map((c, i) => (
                            <li key={i} className="text-[12px] text-gray-400">
                              <span className="text-gray-500 font-mono mr-1">AC-{i + 1}</span>{c.text}
                              {c.expect && <span className="block text-gray-500">Expected: {c.expect}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {asked.has('changelog') && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <h5 className="text-[13px] text-gray-300">Changelog — {changes.size} of {p.changelog.length} kept</h5>
            {p.changelog.length > 0 && <button className="text-[12px] text-gray-500 hover:text-gray-300" onClick={() => tickAll(!changes.size, p.changelog.map((c) => c.id), setChanges)}>{changes.size ? 'Untick all' : 'Tick all'}</button>}
          </div>
          {p.changelog.length === 0 ? <p className="text-[13px] text-gray-500">None proposed.</p> : releases.map((rel) => {
            const list = p.changelog.filter((c) => c.release === rel);
            return (
              <div key={rel || 'unreleased'} className="mb-2">
                <div className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-1">{rel || 'Unreleased'}{list[0]?.date && rel ? <span className="normal-case tracking-normal text-gray-500"> — {list[0].date}</span> : null}</div>
                {list.map((c) => (
                  <label key={c.id} className="flex items-start gap-2 py-0.5 text-[13px] cursor-pointer">
                    <input type="checkbox" className="accent-neon-500 mt-0.5" checked={changes.has(c.id)} onChange={() => toggle(changes, setChanges, c.id)} />
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${KIND_TONE[c.kind]}`}>{KIND_LABEL[c.kind]}</span>
                    <span className="min-w-0"><span className="text-gray-100">{c.title}</span>{c.body && <span className="text-gray-500"> — {c.body}</span>}
                      {c.date && !rel && <span className="text-gray-500"> · {c.date}</span>}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {asked.has('backlog') && (
        <div>
          <h5 className="text-[13px] text-gray-300 mb-1.5">Backlog the code points at — tick to add as planned features ({backlog.size})</h5>
          {p.backlog.length === 0 ? <p className="text-[13px] text-gray-500">None found.</p> : p.backlog.map((b) => (
            <label key={b.name} className="flex items-start gap-2 py-1 text-[13px] cursor-pointer">
              <input type="checkbox" className="accent-neon-500 mt-0.5" checked={backlog.has(b.name)} onChange={() => toggle(backlog, setBacklog, b.name)} />
              <span className="min-w-0"><span className="text-gray-100">{b.name}</span>{b.description && <span className="text-gray-500"> — {b.description}</span>}
                {b.source && <span className="block text-[11px] text-gray-500 font-mono truncate">{b.source}</span>}</span>
            </label>
          ))}
        </div>
      )}

      {err && <p className="text-[13px] text-ember-300">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-[13px] text-gray-400 hover:text-gray-200">Not now</button>
        <button onClick={apply} disabled={busy || kept.length === 0} className={primaryBtn}>
          {busy ? 'Applying…' : kept.length ? `Keep ${kept.join(', ')}` : 'Tick something to keep'}
        </button>
      </div>
    </div>
  );
}

/**
 * "✦ Generate with AI" — one panel, used by the Spec, Changelog and Architecture tabs. It asks a cartridge
 * in the project's repos to write `parts` (or, with `choose`, the parts the person ticks), waits for the
 * proposal, shows it for review, and after it is applied offers to publish docs/product/ into the repo.
 * Requests are per project: asking again — from any tab — replaces one still outstanding.
 */
function AiGenerate({ project, agents, version, onChanged, parts, choose = false, title, blurb, button = '✦ Generate with AI' }: {
  project: Project; agents: Agent[]; version: number; onChanged: () => void;
  parts: ImportPart[]; choose?: boolean; title: string; blurb?: React.ReactNode; button?: string;
}) {
  const { imports, load } = useImports(project.id, version);
  const [agentId, setAgentId] = useState('');
  const [picked, setPicked] = useState<Set<ImportPart>>(() => new Set(parts));
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [published, setPublished] = useState('');
  const [err, setErr] = useState('');
  const repos = useMemo(() => [...new Set([...(project.cartridges ?? []), project.primaryRepo].filter(Boolean))], [project]);
  const candidates = useMemo(() => plannerCandidates(agents, repos), [agents, repos]);
  useEffect(() => { if (!candidates.some((a) => a.id === agentId)) setAgentId(candidates[0]?.id ?? ''); }, [candidates, agentId]);

  // The project's newest request (one can be outstanding at a time), and the newest one for this
  // tab's parts — a changelog asked for later does not hide a features proposal still waiting for review.
  const latest = imports?.[0] ?? null;
  const relevant = imports?.find((i) => i.status !== 'superseded' && i.parts.some((k) => parts.includes(k))) ?? null;
  const waiting = latest?.status === 'pending';
  const mine = !!relevant && relevant.id === latest?.id;
  const asking = choose ? PARTS.map((x) => x.key).filter((k) => picked.has(k)) : parts;
  const repo = project.primaryRepo || project.cartridges?.[0] || '';

  const start = async () => {
    setErr(''); setStarting(true); setPublished('');
    try { await api.startProjectImport(project.id, agentId, asking); setDismissed(null); await load(); }
    catch (e) { setErr(errText(e)); } finally { setStarting(false); }
  };
  const publish = async () => {
    setErr('');
    try {
      const r = await api.publishProjectDocs(project.id);
      setPublished(r.written.length ? `Wrote ${plural(r.written.length, 'file')} to ${r.dir}/.` : 'docs/product/ was already up to date.');
      onChanged();
    } catch (e) { setErr(errText(e)); }
  };
  const appliedText = (a: NonNullable<ProjectImport['applied']>) => [
    a.architecture ? 'the architecture' : '',
    a.features.length ? plural(a.features.length, 'existing feature') : '',
    a.changelog ? plural(a.changelog, 'changelog entry', 'changelog entries') : '',
    a.backlog.length ? plural(a.backlog.length, 'backlog item') : '',
  ].filter(Boolean).join(', ');

  return (
    <div className="space-y-3">
      <div className="rounded-[18px] border border-[#7C6CFF]/45 bg-[#7C6CFF]/[0.07] shadow-[0_0_26px_rgba(124,108,255,0.14)] p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="max-w-xl min-w-0">
            <h4 className="text-[13px] text-gray-100 font-medium">{title}</h4>
            {blurb && <p className="text-[13px] text-gray-500 mt-0.5">{blurb}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Cartridge that writes it"
              className="glass-input rounded-[10px] px-2 py-1.5 text-[13px] text-gray-300 max-w-[220px]">
              {candidates.length === 0 && <option value="">No cartridge online</option>}
              {candidates.map((a) => <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}{a.mode === 'manual' ? ' (Manual — you approve each command)' : ''}{a.status === 'working' ? ' (busy — will queue)' : ''}</option>)}
            </select>
            <button onClick={start} disabled={!agentId || asking.length === 0 || starting} className={waiting && mine ? quietBtn : primaryBtn}
              title={waiting ? 'A request is still out — asking now replaces it' : `A cartridge reads ${repos.length > 1 ? 'the project\'s repos' : 'the repo'} and proposes the ${partsText(asking)}; you review before anything is kept`}>
              {starting ? 'Asking…' : waiting && mine ? 'Ask again' : button}
            </button>
          </div>
        </div>
        {choose && (
          <div className="flex gap-x-4 gap-y-1.5 flex-wrap">
            {PARTS.map((x) => (
              <label key={x.key} title={x.hint} className="flex items-center gap-1.5 text-[13px] text-gray-300 cursor-pointer">
                <input type="checkbox" className="accent-neon-500" checked={picked.has(x.key)}
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(x.key)) n.delete(x.key); else n.add(x.key); return n; })} />
                {x.label}
              </label>
            ))}
          </div>
        )}
        {repos.length === 0 && <p className="text-[13px] text-ember-300">Add the project's repos first — the cartridge reads them.</p>}
        {waiting && (
          <div className="flex items-center gap-2 text-[13px] text-violet-200">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse flex-shrink-0" />
            <span>A cartridge is writing the {partsText(latest!.parts)} (asked {ago(latest!.createdAt)}). You can leave this page — the proposal waits here for your review. If the cartridge went offline, ask again.</span>
          </div>
        )}
        {relevant?.status === 'failed' && <p className="text-[13px] text-ember-300">The last request did not finish: {relevant.error} — try again, or pick another cartridge.</p>}
        {relevant?.status === 'applied' && relevant.applied && (
          <div className="flex items-center gap-3 flex-wrap text-[13px]">
            <span className="text-emerald-300/90">✓ Kept {appliedText(relevant.applied) || 'nothing'} ({day(relevant.completedAt)}).</span>
            {published ? <span className="text-emerald-400">{published}</span>
              : project.docsAutoPublish ? <span className="text-gray-500">docs/product/ is kept in sync — the repo's copy updates on its own.</span>
              : repo ? <button onClick={publish} className="text-neon-400 hover:text-neon-300">Publish it to docs/product/ in the repo now →</button>
              : null}
          </div>
        )}
        {err && <p className="text-[13px] text-ember-300">{err}</p>}
      </div>
      {relevant?.status === 'ready' && relevant.proposal && dismissed !== relevant.id && (
        <ImportReview key={relevant.id} imp={relevant} onCancel={() => setDismissed(relevant.id)} onApplied={() => { load(); onChanged(); }} />
      )}
    </div>
  );
}

// ── Architecture ───────────────────────────────────────────────────────────────

export function ArchitectureTab({ project, agents, version, onChanged }: { project: Project; agents: Agent[]; version: number; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(project.architecture ?? '');
  const [err, setErr] = useState('');
  useEffect(() => { setText(project.architecture ?? ''); }, [project.architecture]);
  const save = async () => {
    setErr('');
    try { await api.updateProject(project.id, { architecture: text }); setEditing(false); onChanged(); } catch (e) { setErr(errText(e)); }
  };

  return (
    <div className="space-y-5">
      <AiGenerate project={project} agents={agents} version={version} onChanged={onChanged} choose
        parts={['architecture', 'features', 'changelog', 'backlog']}
        title={project.architecture ? 'Regenerate from the codebase' : 'First time using NeonCore on this codebase?'}
        blurb={<>A cartridge reads the project's repos — existing docs (README, docs/, CHANGELOG) first, then the code and the git
          history — and writes what you tick: the architecture, the features the product already has with a spec of how each behaves
          today, the changelog so far, and the backlog the code points at. You review it item by item; nothing is kept until you apply,
          and then <span className="text-gray-300">Publish</span> writes it all into the repo as Markdown under docs/product/.</>} />

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 className="text-[12px] text-gray-500 uppercase tracking-[0.12em]">How the product is built</h4>
          <div className="flex items-center gap-3">
            {project.architecture && <a href={docUrl(project.id, 'architecture', { download: true })} className="text-[12px] text-gray-400 hover:text-gray-200">Download .md</a>}
            {!editing && <button onClick={() => setEditing(true)} className="text-[12px] text-neon-400 hover:text-neon-300">{project.architecture ? 'Edit' : 'Write it yourself'}</button>}
          </div>
        </div>
        <p className="text-[12px] text-gray-500 mb-2">The planner reads this when it scopes each feature, so its questions are grounded in the real system.</p>
        {err && <p className="text-[13px] text-ember-300 mb-2">{err}</p>}
        {editing ? (
          <div className="space-y-2">
            <textarea rows={16} className={`${input} font-mono text-[13px]`} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={'## Components\n- api/ — …\n\n## How data flows\n…\n\n## Tests\n…'} />
            <div className="flex gap-2">
              <button onClick={save} className={primaryBtn}>Save</button>
              <button onClick={() => { setEditing(false); setText(project.architecture ?? ''); }} className="px-3 py-1.5 text-[13px] text-gray-400 hover:text-gray-200">Cancel</button>
            </div>
          </div>
        ) : project.architecture ? (
          <div className="prose prose-invert prose-sm max-w-none rounded-[18px] border border-white/[0.1] bg-gl-code p-4">
            <Markdown remarkPlugins={[remarkGfm]}>{project.architecture}</Markdown>
          </div>
        ) : (
          <p className="text-[13px] text-gray-500 italic">Not written yet — generate it with AI above, or write it yourself.</p>
        )}
      </div>
    </div>
  );
}
