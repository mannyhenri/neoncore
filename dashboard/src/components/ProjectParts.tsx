/**
 * The building blocks of the Projects view (ProjectsPage.tsx): the project and feature forms, the
 * folder picker, scheduled runs, learnings, "run a workflow", the modal shell, and the intent
 * fields a feature carries to every agent.
 *
 * They used to live in GoalsPage.tsx, under a goal → projects hierarchy. The hierarchy is now
 * project → features (a feature is a goal row filed under a project), and these pieces serve it
 * unchanged apart from their wording.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ConferModePicker, type ConferMode, type ConferIsolation } from './ConferModePicker';
import { api } from '../lib/api';
import { workflowAgentOptions, conferOptionLabel } from '../lib/workflow-agent-options';
import { CADENCES, CADENCE_LABEL, formFieldsFromSchedule, scheduleFromFormFields, type Cadence } from '../lib/heartbeatForm';
import type { Goal, Project, ProjectLearning, Heartbeat } from '../types';
import { DatePicker } from './DatePicker';

// ── FolderPicker ──────────────────────────────────────────────────────────────

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
}

export function FolderPicker({ value, onChange }: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState<{ current: string; parent: string | null; dirs: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function browse(path?: string) {
    setLoading(true);
    try {
      const result = await api.browseDir(path) as { current: string; parent: string | null; dirs: string[] };
      setBrowsing(result);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  function handleOpen() {
    setOpen(true);
    setManualMode(false);
    browse(value || undefined);
  }

  function handleSelect(path: string) {
    onChange(path);
    setOpen(false);
    setBrowsing(null);
  }

  function handleEnterDir(dirName: string) {
    if (!browsing) return;
    browse(`${browsing.current}/${dirName}`);
  }

  const displayName = value ? value.split('/').filter(Boolean).pop() || value : '';

  if (manualMode) {
    return (
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/Users/you/projects/my-repo"
          className="flex-1 glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setManualMode(false)}
          className="text-[12px] text-gray-500 hover:text-gray-300 whitespace-nowrap"
        >
          Use picker
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <div className="flex gap-2">
        <div
          className="flex-1 glass-input rounded-[10px] px-3 py-2.5 text-sm flex items-center gap-2 min-w-0 cursor-pointer hover:border-white/20"
          onClick={handleOpen}
        >
          {value ? (
            <>
              <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              <span className="text-gray-200 truncate">{displayName}</span>
              <span className="text-gray-500 text-[12px] truncate hidden sm:block">{value}</span>
            </>
          ) : (
            <span className="text-gray-500">Browse to select folder…</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleOpen}
          className="px-3 py-2 text-xs text-gray-400 glass-input rounded-[10px] hover:border-white/20 hover:text-gray-200 transition-colors whitespace-nowrap"
        >
          Browse…
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-full glass-dark border border-white/[0.08] rounded-[18px] shadow-2xl overflow-hidden">
          {/* Current path breadcrumb */}
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-[12px] text-gray-500 truncate flex-1">{browsing?.current || '…'}</span>
            {value && (
              <button
                type="button"
                onClick={() => handleSelect(browsing?.current || value)}
                className="ml-2 text-[12px] text-neon-400 hover:text-neon-300 whitespace-nowrap"
              >
                Select this folder
              </button>
            )}
          </div>

          {loading ? (
            <div className="px-3 py-4 text-[13px] text-gray-500 text-center">Loading…</div>
          ) : browsing ? (
            <div className="max-h-48 overflow-y-auto py-1">
              {browsing.parent && (
                <button
                  type="button"
                  onClick={() => browse(browsing.parent!)}
                  className="w-full text-left px-3 py-1.5 text-[13px] text-gray-500 hover:bg-white/[0.04] flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                  <span>..</span>
                </button>
              )}
              {browsing.dirs.length === 0 && (
                <div className="px-3 py-2 text-[13px] text-gray-500">No subdirectories</div>
              )}
              {browsing.dirs.map((dir) => {
                const fullPath = `${browsing.current}/${dir}`;
                return (
                  <div key={dir} className="flex items-center group">
                    <button
                      type="button"
                      onClick={() => handleEnterDir(dir)}
                      className="flex-1 text-left px-3 py-1.5 text-[13px] text-gray-300 hover:bg-white/[0.04] flex items-center gap-2 min-w-0"
                    >
                      <svg className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                      </svg>
                      <span className="truncate">{dir}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelect(fullPath)}
                      className="pr-3 text-[12px] text-violet-500 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                    >
                      Select
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="border-t border-white/[0.06] px-3 py-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setManualMode(true); }}
              className="text-[12px] text-gray-500 hover:text-gray-400 transition-colors"
            >
              Enter path manually instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Real USD spent (from session_usage), denominated for the goal/project budget view.
export function formatUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}

export const PROJECT_COLORS = [
  '#5AAEFF', '#7C6CFF', '#2EE6D6', '#FF8A3D',
  '#FF7AC0', '#4ADE80', '#FFC44D', '#FF6B6B',
];

// ── sub-components ────────────────────────────────────────────────────────────

export interface FeatureFormProps {
  initial?: Partial<Goal>;
  onSave: (data: { name: string; description: string; successMetric: string; budgetUsd: number | null; status: Goal['status']; acceptanceCriteria: string; noGos: string; rabbitHoles: string; invariants: string; targetDate: string; owner: string; investmentCategory: string; autonomy: string }) => void;
  onCancel: () => void;
}

export function FeatureForm({ initial, onSave, onCancel }: FeatureFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  // Kept, not edited: existing goals carry a free-text success metric, and the migration
  // copied it into acceptanceCriteria. Round-tripping it on save preserves the original rather
  // than blanking a field the user never saw a form for.
  const [successMetric] = useState(initial?.successMetric || '');
  const [budgetUsdStr, setBudgetUsdStr] = useState(initial?.budgetUsd != null ? String(initial.budgetUsd) : '');
  const [status, setStatus] = useState<Goal['status']>(initial?.status || 'active');
  // The fields that actually reach the agents. Everything above this line was already here
  // and, apart from the budget cap, was never read by anything.
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(initial?.acceptanceCriteria || '');
  const [noGos, setNoGos] = useState(initial?.noGos || '');
  const [rabbitHoles, setRabbitHoles] = useState(initial?.rabbitHoles || '');
  const [invariants, setInvariants] = useState(initial?.invariants || '');
  // PM surface. Every one defaults to '' meaning UNSET — an autonomy posture nobody chose must
  // not grant latitude, and a goal with no target date has no schedule rather than being late.
  const [targetDate, setTargetDate] = useState(initial?.targetDate || '');
  const [owner, setOwner] = useState(initial?.owner || '');
  const [investmentCategory, setInvestmentCategory] = useState(initial?.investmentCategory || '');
  const [autonomy, setAutonomy] = useState(initial?.autonomy || '');
  const [registries, setRegistries] = useState<{
    categories: { key: string; label: string; hint: string }[];
    autonomyLevels: { key: string; label: string; hint: string }[];
  }>({ categories: [], autonomyLevels: [] });

  // Fetched rather than hard-coded: the server owns both registries, and a second copy here is
  // how an option gets added in one place and silently rejected in the other.
  useEffect(() => {
    api.getPortfolio()
      .then((p) => setRegistries({ categories: p.categories, autonomyLevels: p.autonomyLevels }))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Feature name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sign in with Google"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">What it is, and why</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="A sentence or two: what the feature does and who it is for"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none resize-none"
        />
      </div>
      <div className="pt-1 border-t border-white/[0.06]">
        <p className="text-[12px] text-violet-300/80 uppercase tracking-[0.12em] mb-2 mt-2">
          Sent to every agent working on this feature
        </p>
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
          Acceptance criteria — what &ldquo;done&rdquo; is judged against
        </label>
        <textarea
          value={acceptanceCriteria}
          onChange={(e) => setAcceptanceCriteria(e.target.value)}
          rows={3}
          placeholder={"One per line, testable:\nWhen an admin uploads an invalid certificate, the system shall name the field at fault.\nWhile SSO is unconfigured, the system shall keep password login available."}
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
          No-gos — explicitly out of scope
        </label>
        <textarea
          value={noGos}
          onChange={(e) => setNoGos(e.target.value)}
          rows={2}
          placeholder="e.g. SCIM provisioning. Redesigning the admin nav. Anything Okta-specific."
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none resize-none"
        />
        <p className="text-[12px] text-gray-500 mt-1">
          The highest-value field here: agents over-reach far more often than they under-deliver.
        </p>
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
          Invariants — what must not break
        </label>
        <input
          value={invariants}
          onChange={(e) => setInvariants(e.target.value)}
          placeholder="e.g. Existing password sessions must stay valid"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
          Rabbit holes — traps already paid for once
        </label>
        <input
          value={rabbitHoles}
          onChange={(e) => setRabbitHoles(e.target.value)}
          placeholder="e.g. The provider-selector refactor burned a week last quarter"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Budget cap — USD (optional)</label>
          <input
            type="number"
            min="0"
            step="1"
            value={budgetUsdStr}
            onChange={(e) => setBudgetUsdStr(e.target.value)}
            placeholder="e.g. 50"
            className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
          />
        </div>
        {initial && (
          <div>
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Goal['status'])}
              className="glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              <option value="active">Active</option>
              <option value="achieved">Done</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        )}
      </div>

      {/* PM surface. Grouped and labelled as optional because every one is genuinely optional:
          unset is a real state the rest of the system handles, not a gap to be filled. */}
      <div className="pt-2 border-t border-white/[0.06]">
        <h4 className="text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-2">Planning (optional)</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Target date</label>
            <DatePicker value={targetDate} onChange={setTargetDate} placeholder="No target date" />
            <p className="text-[11px] text-gray-500 mt-1">Reaches the agent — it scopes work to fit.</p>
          </div>
          <div>
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Owner</label>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="Who is accountable"
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder:text-gray-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Investment</label>
            <select
              value={investmentCategory}
              onChange={(e) => setInvestmentCategory(e.target.value)}
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              <option value="">Uncategorised</option>
              {registries.categories.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Autonomy</label>
            <select
              value={autonomy}
              onChange={(e) => setAutonomy(e.target.value)}
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              <option value="">Not set — agents behave as they do today</option>
              {registries.autonomyLevels.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-500 mt-1">
              {registries.autonomyLevels.find((a) => a.key === autonomy)?.hint
                ?? 'Sent to every agent working on this feature, as an instruction.'}
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), successMetric: successMetric.trim(), budgetUsd: budgetUsdStr ? parseFloat(budgetUsdStr) : null, status, acceptanceCriteria: acceptanceCriteria.trim(), noGos: noGos.trim(), rabbitHoles: rabbitHoles.trim(), invariants: invariants.trim(), targetDate, owner: owner.trim(), investmentCategory, autonomy })}
          disabled={!name.trim()}
          className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {initial ? 'Save' : 'Add feature'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

export interface ProjectFormData {
  name: string;
  description: string;
  primaryRepo: string;
  color: string;
  cartridges: string[];
  /** Run when an epic finishes, with every feature's locked tests (epic QA). Epics can override it. */
  qaCommand?: string;
}

interface ProjectFormProps {
  initial?: Partial<Project>;
  onSave: (data: ProjectFormData) => void;
  onCancel: () => void;
}

/**
 * A project: its name, what it is, and the repos (cartridges) its features are built in. The repos
 * are the heart of it — every feature's pipeline runs in them, so they come first after the name.
 */
export function ProjectForm({ initial, onSave, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [color, setColor] = useState(initial?.color || PROJECT_COLORS[0]);
  // The cartridges this project owns. Seeded from primaryRepo for a project created before
  // projects had a set, so editing an old project does not silently unlink it.
  const [cartridges, setCartridges] = useState<string[]>(
    initial?.cartridges?.length ? initial.cartridges : (initial?.primaryRepo ? [initial.primaryRepo] : []),
  );
  // The main repo: where documents and saved files land. Defaults to the first repo picked.
  const [primaryRepo, setPrimaryRepo] = useState(initial?.primaryRepo || '');
  const [qaCommand, setQaCommand] = useState(initial?.qaCommand || '');
  const [adding, setAdding] = useState('');
  // Every repo a cartridge has registered in, with whether one is running there now.
  const [known, setKnown] = useState<{ repo: string; online: boolean }[]>([]);
  useEffect(() => {
    api.getAgents()
      .then((as) => {
        const by = new Map<string, boolean>();
        for (const a of as) if (a.repoPath) by.set(a.repoPath, (by.get(a.repoPath) ?? false) || a.status !== 'offline');
        setKnown([...by.entries()].map(([repo, online]) => ({ repo, online })).sort((x, y) => x.repo.localeCompare(y.repo)));
      })
      .catch(() => setKnown([]));
  }, []);
  const toggle = (repo: string) =>
    setCartridges((prev) => (prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo]));
  const main = cartridges.includes(primaryRepo) ? primaryRepo : (cartridges[0] || '');
  const candidates = [...new Set([...known.map((k) => k.repo), ...cartridges])];
  const online = new Map(known.map((k) => [k.repo, k.online]));

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Project name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Customer portal"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">What is it? <span className="normal-case tracking-normal text-gray-500">(optional)</span></label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="One or two sentences. The planner reads this when it scopes each feature."
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
          Repos &amp; cartridges involved
        </label>
        <p className="text-[12px] text-gray-500 mb-2">
          Every feature of this project is built in these repos. Pick the ones a cartridge has worked in, or add a folder.
        </p>
        {candidates.length === 0 ? (
          <p className="text-[13px] text-gray-500 mb-2">No cartridge has registered yet — add the repo folder below, then launch a cartridge in it from the Agents view.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto mb-2">
            {candidates.map((repo) => {
              const on = cartridges.includes(repo);
              return (
                <button
                  key={repo}
                  type="button"
                  onClick={() => toggle(repo)}
                  title={repo}
                  className={`px-2.5 py-1 text-[13px] rounded-[10px] border transition-colors flex items-center gap-1.5 ${
                    on ? 'bg-violet-900/50 border-violet-600/60 text-violet-100' : 'bg-white/[0.03] border-white/10 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${online.get(repo) ? 'bg-emerald-400' : 'bg-gray-600'}`} title={online.get(repo) ? 'a cartridge is running here' : 'no cartridge running'} />
                  {on ? '✓ ' : ''}{repo.split(/[\\/]/).pop()}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex gap-2 items-start">
          <div className="flex-1"><FolderPicker value={adding} onChange={setAdding} /></div>
          <button
            type="button"
            disabled={!adding.trim()}
            onClick={() => { const p = adding.trim(); if (p) setCartridges((prev) => (prev.includes(p) ? prev : [...prev, p])); setAdding(''); }}
            className="px-3 py-2 text-xs text-gray-300 bg-white/[0.05] border border-white/10 rounded-[10px] hover:border-white/25 disabled:opacity-40"
          >
            Add repo
          </button>
        </div>
        {cartridges.length > 1 && (
          <div className="mt-2">
            <label className="block text-[12px] text-gray-500 mb-1">Main repo — where documents and saved files go</label>
            <select
              value={main}
              onChange={(e) => setPrimaryRepo(e.target.value)}
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              {cartridges.map((r) => <option key={r} value={r}>{r.split(/[\\/]/).pop()} — {r}</option>)}
            </select>
          </div>
        )}
      </div>
      {/* EPIC QA for any project, web UI or not: this runs with every feature's locked tests when an epic finishes. */}
      <div>
        <label htmlFor="project-qa-command" className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">QA command <span className="normal-case tracking-normal text-gray-500">(optional)</span></label>
        <input
          id="project-qa-command"
          value={qaCommand}
          onChange={(e) => setQaCommand(e.target.value)}
          placeholder="e.g. npm test"
          className="w-full h-10 px-3 rounded-[10px] glass-input text-[13px] font-mono text-gray-100 placeholder:text-gray-500"
        />
        <p className="mt-1 text-[12px] text-gray-500">Runs when an epic finishes, from the repo root, with every feature's acceptance tests; it passes on exit 0. {'{n}'} is the epic's phase number — e.g. bash scripts/run_gates.sh {'{n}'}. An epic can override it.</p>
      </div>
      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Color</label>
        <div className="flex gap-2 flex-wrap">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-white scale-110' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), primaryRepo: main, color, cartridges, qaCommand: qaCommand.trim() })}
          disabled={!name.trim()}
          className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {initial?.id ? 'Save' : 'Create project'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ProjectLearningsPanel({ project }: { project: Project }) {
  const [learnings, setLearnings] = useState<ProjectLearning[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getProjectLearnings(project.id).then((data) => {
      setLearnings(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [project.id]);

  function formatRelativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <p className="text-[13px] text-gray-500">Loading learnings...</p>
      ) : learnings.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-[13px] text-gray-500">No learnings captured yet.</p>
          <p className="text-[12px] text-gray-700 mt-1">Add a "Capture Learnings" connector step at the end of a workflow to start building project memory.</p>
        </div>
      ) : (
        learnings.map((l) => (
          <div key={l.id} className="bg-black/30 border border-white/[0.07] rounded-xl p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[12px] font-medium text-violet-400">{l.workflowName}</span>
              <span className="text-[11px] text-gray-500">{formatRelativeTime(l.createdAt)}</span>
              {l.tags.length > 0 && l.tags.map((t) => (
                <span key={t} className="text-[11px] px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-gray-500">{t}</span>
              ))}
            </div>
            <pre className="text-[12px] text-gray-400 whitespace-pre-wrap leading-relaxed font-sans line-clamp-6">{l.content}</pre>
          </div>
        ))
      )}
    </div>
  );
}

export function LaunchFromProjectModal({ project, onClose }: { project: Project; onClose: (runId?: string) => void }) {
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; repoName: string; status: string }[]>([]);
  const [learningsCount, setLearningsCount] = useState(0);
  const [templateId, setTemplateId] = useState('');
  const [agentId, setAgentId] = useState('');
  /**
   * Run-level confer: 2+ cartridges work every step together and decide between themselves
   * which repo owns each piece. Overrides `agentId` — in confer mode no single cartridge owns
   * a step, and sending both would leave the outcome depending on which the server wrote last.
   */
  const [conferAgents, setConferAgents] = useState<string[]>([]);
  const [conferMode, setConferMode] = useState<ConferMode>('divide');
  const [conferIsolation, setConferIsolation] = useState<ConferIsolation>('shared');
  /**
   * The cartridges offered for a confer: the SAME set the rest of the app shows. This mapped
   * the raw `agents` array, so it listed dismissed rows and superseded duplicates no other
   * selector shows. Already-picked ids are kept so a selection cannot vanish mid-edit.
   */
  const conferCandidates = useMemo(
    () => workflowAgentOptions(agents, { keepIds: conferAgents }),
    [agents, conferAgents],
  );
  const [note, setNote] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getWorkflows().then((ws) => ws.filter((w) => !w.templateId).map((w) => ({ id: w.id, name: w.name }))),
      // Offline cartridges are listed too — a run aimed at one queues until it reconnects.
      // Hiding them made a disconnected cartridge unselectable with no explanation.
      api.getAgents().then((as) => as
        .map((a) => ({ id: a.id, name: a.name, repoName: a.repoName, status: a.status }))
        .sort((a, b) => Number(a.status === 'offline') - Number(b.status === 'offline'))),
      api.getProjectLearnings(project.id, 3).then((ls) => ls.length).catch(() => 0),
    ]).then(([tmps, ags, count]) => { setTemplates(tmps); setAgents(ags); setLearningsCount(count); });
  }, [project.id]);

  async function handleLaunch() {
    if (!templateId) return;
    setLaunching(true);
    setError('');
    try {
      // agentId is the RUN-LEVEL cartridge (arg 6) — it fills every step that has none.
      // This used to pass `{ [templateId]: agentId }` as `agentOverrides` (arg 2), which is a
      // stepId→agentId map: keyed by a template id it matched no step, so the cartridge you
      // picked assigned nothing and all 47 steps launched deferred.
      const result = await api.startWorkflowV2(
        templateId,
        undefined,
        undefined,
        note.trim() || undefined,
        project.id,
        conferAgents.length >= 2 ? undefined : (agentId || undefined),
        undefined,
        conferAgents.length >= 2 ? conferAgents : undefined,
        conferAgents.length >= 2 ? conferMode : undefined,
        conferAgents.length >= 2 ? conferIsolation : undefined,
      );
      onClose(result?.workflow?.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Launch failed');
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[13px] text-red-400">{error}</p>}

      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Workflow template</label>
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
        >
          <option value="">— Select template —</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div>
        {/* NOT optional in practice. Every step of a template is `__deferred__` until launch,
            so without a cartridge the run is created and then dies on step 1. "Any available"
            was a promise nothing kept — nothing picks one for you. */}
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Cartridge</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
        >
          <option value="">— Pick a cartridge —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.repoName || a.name} ({a.status})</option>
          ))}
        </select>

        {/* Run-level confer. A third option beside "one cartridge": 2+ cartridges work every
            step together and settle between themselves which repo owns each piece. */}
        {agents.length >= 2 && (
          <div className="mt-2">
            <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">
              Or confer across repos
            </label>
            <div className="flex flex-wrap gap-1">
              {conferCandidates.map((a) => {
                const on = conferAgents.includes(a.id);
                return (
                  <button
                    key={`confer-${a.id}`}
                    type="button"
                    onClick={() => setConferAgents((prev) =>
                      prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id])}
                    className={`text-[12px] px-2 py-1 rounded-full border transition-colors ${
                      on
                        ? 'border-amber-400/40 bg-amber-500/10 text-ember-300'
                        : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {conferOptionLabel(a)}
                  </button>
                );
              })}
            
                        {conferAgents.length >= 2 && (
                          <ConferModePicker value={conferMode} onChange={setConferMode} isolation={conferIsolation} onIsolationChange={setConferIsolation} />
                        )}
                        </div>
            {conferAgents.length === 1 && (
              <p className="text-[12px] text-amber-400/70 mt-1">
                Pick one more. A single-cartridge confer is an ordinary run.
              </p>
            )}
            {conferAgents.length >= 2 && (
              <p className="text-[12px] text-gray-500 mt-1">
                {conferAgents.length} cartridges will work every step together. The cartridge
                above is ignored.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-1">Run note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Additional context for this run…"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none resize-none"
        />
      </div>

      {learningsCount > 0 && (
        <div className="flex items-center gap-2 bg-violet-900/20 border border-violet-700/30 rounded-xl px-3 py-2">
          <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="text-[13px] text-violet-300">{learningsCount} past learning{learningsCount !== 1 ? 's' : ''} will be auto-injected as context</span>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleLaunch}
          // The cartridge above is ignored while conferring — this said so in the hint
          // and then went on requiring it, so the Launch button stayed grey.
          disabled={!templateId || (!agentId && conferAgents.length < 2) || launching}
          className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {launching ? 'Launching…' : 'Launch'}
        </button>
        <button onClick={() => onClose()} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
      </div>
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface HeartbeatFormData {
  templateId: string;
  agentId: string;
  // Derived from the shared Heartbeat type, never restated: this field used to name three
  // cadences while the server had six, so the edit form rewrote monthly schedules as hourly.
  // See lib/heartbeatForm.ts.
  scheduleType: Cadence;
  scheduleTime: string;
  scheduleDay: number;
  scheduleDayOfMonth: number;
  label: string;
  active: boolean;
}

const EMPTY_FORM: HeartbeatFormData = {
  templateId: '', agentId: '', scheduleType: 'daily', scheduleDayOfMonth: 1,
  scheduleTime: '09:00', scheduleDay: 1, label: '', active: true,
};

export function HeartbeatsPanel({ project }: { project: Project }) {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; repoName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<HeartbeatFormData>(EMPTY_FORM);
  const [firing, setFiring] = useState<string | null>(null);
  const [firedRun, setFiredRun] = useState<string | null>(null);
  const [firedRunName, setFiredRunName] = useState('');

  useEffect(() => {
    Promise.all([
      api.getHeartbeats(project.id),
      api.getWorkflows().then((ws) => ws.filter((w) => !w.templateId).map((w) => ({ id: w.id, name: w.name }))),
      api.getAgents().then((as) => as.map((a) => ({ id: a.id, name: a.name, repoName: a.repoName }))),
    ]).then(([hbs, tmps, ags]) => {
      setHeartbeats(hbs);
      setTemplates(tmps);
      setAgents(ags);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [project.id]);

  async function handleSave() {
    const schedule = {
      ...scheduleFromFormFields(form),
    };
    try {
      if (editingId) {
        const updated = await api.updateHeartbeat(editingId, {
          templateId: form.templateId, agentId: form.agentId,
          schedule, label: form.label, active: form.active,
        });
        setHeartbeats((prev) => prev.map((h) => (h.id === editingId ? updated : h)));
      } else {
        const created = await api.createHeartbeat({
          projectId: project.id, templateId: form.templateId, agentId: form.agentId,
          schedule, label: form.label, active: form.active,
        });
        setHeartbeats((prev) => [created, ...prev]);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (e) { /* no-op */ }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this scheduled run?')) return;
    await api.deleteHeartbeat(id);
    setHeartbeats((prev) => prev.filter((h) => h.id !== id));
  }

  async function handleFire(id: string) {
    setFiring(id);
    try {
      const result = await api.fireHeartbeat(id);
      setFiredRun(result.runId);
      // The schedule already knows what it launches, and it is the same name the row above is
      // labelled with — so the confirmation names the run instead of handing back an id.
      const fired = heartbeats.find((h) => h.id === id);
      setFiredRunName(fired?.label || fired?.templateName || '');
      const updated = await api.getHeartbeats(project.id);
      setHeartbeats(updated);
    } catch { /* no-op */ } finally {
      setFiring(null);
    }
  }

  function startEdit(h: Heartbeat) {
    setForm({
      templateId: h.templateId,
      agentId: h.agentId,
      ...formFieldsFromSchedule(h.schedule),
      label: h.label,
      active: h.active,
    });
    setEditingId(h.id);
    setShowForm(true);
  }

  function formatRelativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function formatNextRun(iso: string) {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff < 0) return 'overdue';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.floor(hrs / 24)}d`;
  }

  if (loading) return <p className="text-[13px] text-gray-500">Loading...</p>;

  return (
    <div className="space-y-3">
      {firedRun && (
        <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl px-3 py-2 flex items-center justify-between">
          {/* An id tells you a run exists; the name tells you which one, which is what you go
              looking for in the workflow list a second later. */}
          <span className="text-[13px] text-emerald-400">
            Run started — {firedRunName || `ID: ${firedRun.slice(0, 8)}…`}
          </span>
          <button onClick={() => { setFiredRun(null); setFiredRunName(''); }} className="text-emerald-600 hover:text-emerald-400 text-[12px]">dismiss</button>
        </div>
      )}

      {!showForm && (
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
          className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-violet-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Schedule a recurring run
        </button>
      )}

      {showForm && (
        <div className="bg-black/30 border border-white/[0.07] rounded-xl p-3 space-y-3">
          <h4 className="text-[12px] text-gray-400 font-semibold uppercase tracking-[0.12em]">
            {editingId ? 'Edit schedule' : 'New scheduled run'}
          </h4>

          <div>
            <label className="block text-[12px] text-gray-500 mb-1">Label (optional)</label>
            <input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Weekly code health check"
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[12px] text-gray-500 mb-1">Workflow template</label>
            <select
              value={form.templateId}
              onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              <option value="">— Select template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[12px] text-gray-500 mb-1">Agent (optional)</label>
            <select
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
            >
              <option value="">— Any available agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.repoName || a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div>
              <label className="block text-[12px] text-gray-500 mb-1">Frequency</label>
              <select
                value={form.scheduleType}
                onChange={(e) => setForm((f) => ({ ...f, scheduleType: e.target.value as HeartbeatFormData['scheduleType'] }))}
                className="glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>{CADENCE_LABEL[c]}</option>
                ))}
              </select>
            </div>
            {form.scheduleType !== 'hourly' && (
              <div>
                <label className="block text-[12px] text-gray-500 mb-1">Time</label>
                <input
                  type="time"
                  value={form.scheduleTime}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleTime: e.target.value }))}
                  className="glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
                />
              </div>
            )}
            {(form.scheduleType === 'monthly' || form.scheduleType === 'quarterly') && (
              <div>
                <label className="block text-[12px] text-gray-500 mb-1">Day of month</label>
                <select
                  value={form.scheduleDayOfMonth}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDayOfMonth: Number(e.target.value) }))}
                  className="glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}
            {form.scheduleType === 'weekly' && (
              <div>
                <label className="block text-[12px] text-gray-500 mb-1">Day</label>
                <select
                  value={form.scheduleDay}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDay: parseInt(e.target.value) }))}
                  className="glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none"
                >
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hb-active"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              className="rounded border-white/20 bg-black/40"
            />
            <label htmlFor="hb-active" className="text-[13px] text-gray-400">Active</label>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!form.templateId}
              className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {editingId ? 'Save' : 'Create'}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}
              className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {heartbeats.length === 0 && !showForm ? (
        <p className="text-[13px] text-gray-500">No scheduled runs yet.</p>
      ) : (
        heartbeats.map((h) => (
          <div key={h.id} className={`bg-black/30 border rounded-xl p-3 ${h.active ? 'border-white/[0.07]' : 'border-white/[0.04] opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${h.active ? 'bg-emerald-500' : 'bg-gray-600'}`} />
                  <span className="text-[13px] font-medium text-gray-200 truncate">{h.label || h.templateName || h.templateId.slice(0, 8)}</span>
                </div>
                <p className="text-[12px] text-gray-500 ml-4">{h.scheduleLabel}</p>
                {h.templateName && h.label && (
                  <p className="text-[11px] text-gray-500 ml-4 mt-0.5">{h.templateName}</p>
                )}
                <div className="flex gap-3 text-[11px] text-gray-700 ml-4 mt-1">
                  {h.lastRunAt && <span>Last: {formatRelativeTime(h.lastRunAt)}</span>}
                  <span>Next: {formatNextRun(h.nextRunAt)}</span>
                  {h.agentName && <span>Agent: {h.agentName}</span>}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleFire(h.id)}
                  disabled={firing === h.id}
                  className="text-gray-500 hover:text-emerald-400 disabled:opacity-40 transition-colors p-0.5"
                  title="Fire now"
                >
                  {firing === h.id ? (
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                    </svg>
                  )}
                </button>
                <button onClick={() => startEdit(h)} className="text-gray-500 hover:text-gray-300 transition-colors p-0.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                </button>
                <button onClick={() => handleDelete(h.id)} className="text-gray-500 hover:text-red-400 transition-colors p-0.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export const TASK_STATUS_DOT: Record<string, string> = {
  queued: 'bg-gray-500',
  claimed: 'bg-blue-400',
  in_progress: 'bg-violet-400 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-yellow-600',
};

// ── modal wrapper ─────────────────────────────────────────────────────────────

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  // Rendered on document.body, not where it is opened from. The Projects page lives inside the
  // bridge's console panel, with the captain and the bars on layers of their own beside it: a
  // dialog left in place is only on top WITHIN that panel, and they paint over it. No z-index
  // wins against a sibling layer — the dialog has to leave the panel.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-modal
      className="fixed inset-0 z-overlay flex items-center justify-center p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="absolute inset-0 bg-ink/75 backdrop-blur-sm" onClick={onClose} />
      {/* Scrolls INSIDE itself. Without the height cap a long form simply grows past the
          viewport: the title clips off the top, the Save button sits on the bottom edge, and
          neither can be reached because the page behind a `fixed inset-0` overlay does not
          scroll. The goal form crossed that line when the planning fields were added, but the
          bug was latent before — the fix belongs on the Modal, not on one form. */}
      <div className="relative glass-dark rounded-[22px] p-6 w-full max-w-lg shadow-[0_30px_80px_rgba(0,0,0,0.6)] max-h-[calc(100vh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-xl font-semibold text-gray-100">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-[10px] btn-ghost flex items-center justify-center text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The intent a feature carries. Driven by a registry rather than written out inline, so the
 * detail pane, the "how complete is this feature" count and any field added later cannot
 * drift apart — adding a field here adds it to all three.
 *
 * These are the fields that reach the agent at dispatch through the goal brief, which is
 * why an empty one is worth showing as empty rather than hiding.
 */
export const INTENT_FIELDS: { key: string; label: string; hint: string; read: (g: Goal) => string }[] = [
  { key: 'description', label: 'Why this matters', hint: 'The reason the work is worth doing', read: (g) => g.description },
  { key: 'acceptanceCriteria', label: 'Acceptance criteria', hint: 'EARS-form statements — what "done" is judged against', read: (g) => g.acceptanceCriteria },
  { key: 'invariants', label: 'Invariants', hint: 'What must stay true while the work happens', read: (g) => g.invariants },
  { key: 'noGos', label: 'No-gos', hint: 'Explicitly out of scope — the field that fights agent over-reach', read: (g) => g.noGos },
  { key: 'rabbitHoles', label: 'Rabbit holes', hint: 'Known time sinks to steer around', read: (g) => g.rabbitHoles },
];

export function IntentBlock({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 border-b border-white/[0.06] last:border-b-0">
      <h4 className="text-[13px] text-gray-500 uppercase tracking-[0.12em]" title={hint}>{label}</h4>
      {value ? (
        <p className="text-[14px] text-gray-100 whitespace-pre-wrap leading-relaxed">{value}</p>
      ) : (
        <p className="text-[14px] text-ember-300">Not set — this reaches no agent</p>
      )}
    </div>
  );
}
