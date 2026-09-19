import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from 'react';
import { SectionTitle } from './SectionTitle';
import { api } from '../lib/api';
import { CADENCES, CADENCE_LABEL, formFieldsFromSchedule, scheduleFromFormFields, type Cadence } from '../lib/heartbeatForm';
import { useSocket } from '../hooks/useSocket';
import type { Goal, Project, ProjectLearning, Heartbeat, Task, Agent, PortfolioSummary } from '../types';
import { GoalDraftPanel } from './GoalDraftPanel';
import { GoalDecomposePanel } from './GoalDecomposePanel';
import { unassignedNotice, unassignedProjects } from '../lib/goalStats';
import { UNASSIGNED, parseGoalHash, goalHash, resolveSelection } from '../lib/goalSelection';
import { progressView, healthView } from '../lib/goalRollup';

// ── FolderPicker ──────────────────────────────────────────────────────────────

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
}

function FolderPicker({ value, onChange }: FolderPickerProps) {
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
          className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
        <button
          type="button"
          onClick={() => setManualMode(false)}
          className="text-[11px] text-gray-500 hover:text-gray-300 whitespace-nowrap"
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
          className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm flex items-center gap-2 min-w-0 cursor-pointer hover:border-white/20"
          onClick={handleOpen}
        >
          {value ? (
            <>
              <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              <span className="text-gray-200 truncate">{displayName}</span>
              <span className="text-gray-600 text-[11px] truncate hidden sm:block">{value}</span>
            </>
          ) : (
            <span className="text-gray-600">Browse to select folder…</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleOpen}
          className="px-3 py-2 text-xs text-gray-400 bg-black/40 border border-white/10 rounded-md hover:border-white/20 hover:text-gray-200 transition-colors whitespace-nowrap"
        >
          Browse…
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-full bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden">
          {/* Current path breadcrumb */}
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-[11px] text-gray-500 truncate flex-1">{browsing?.current || '…'}</span>
            {value && (
              <button
                type="button"
                onClick={() => handleSelect(browsing?.current || value)}
                className="ml-2 text-[11px] text-violet-400 hover:text-violet-300 whitespace-nowrap"
              >
                Select this folder
              </button>
            )}
          </div>

          {loading ? (
            <div className="px-3 py-4 text-[12px] text-gray-600 text-center">Loading…</div>
          ) : browsing ? (
            <div className="max-h-48 overflow-y-auto py-1">
              {browsing.parent && (
                <button
                  type="button"
                  onClick={() => browse(browsing.parent!)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-gray-500 hover:bg-white/[0.04] flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                  <span>..</span>
                </button>
              )}
              {browsing.dirs.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-gray-600">No subdirectories</div>
              )}
              {browsing.dirs.map((dir) => {
                const fullPath = `${browsing.current}/${dir}`;
                return (
                  <div key={dir} className="flex items-center group">
                    <button
                      type="button"
                      onClick={() => handleEnterDir(dir)}
                      className="flex-1 text-left px-3 py-1.5 text-[12px] text-gray-300 hover:bg-white/[0.04] flex items-center gap-2 min-w-0"
                    >
                      <svg className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                      </svg>
                      <span className="truncate">{dir}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelect(fullPath)}
                      className="pr-3 text-[11px] text-violet-500 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
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
              className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
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

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `~${(n / 1000).toFixed(0)}K tokens`;
  return `~${(n / 1_000_000).toFixed(1)}M tokens`;
}

// Real USD spent (from session_usage), denominated for the goal/project budget view.
function formatUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}

function statusBadge(status: Goal['status']) {
  const map: Record<Goal['status'], { label: string; cls: string }> = {
    active:   { label: 'Active',   cls: 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50' },
    achieved: { label: 'Achieved', cls: 'bg-blue-900/40 text-blue-400 border-blue-800/50' },
    paused:   { label: 'Paused',   cls: 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50' },
  };
  const { label, cls } = map[status];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>{label}</span>;
}

const PROJECT_COLORS = [
  '#a855f7', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#84cc16',
];

// ── sub-components ────────────────────────────────────────────────────────────

interface GoalFormProps {
  initial?: Partial<Goal>;
  onSave: (data: { name: string; description: string; successMetric: string; budgetUsd: number | null; status: Goal['status']; acceptanceCriteria: string; noGos: string; rabbitHoles: string; invariants: string; targetDate: string; owner: string; investmentCategory: string; autonomy: string }) => void;
  onCancel: () => void;
}

function GoalForm({ initial, onSave, onCancel }: GoalFormProps) {
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
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Goal name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ship authentication v2"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Mission / why this matters</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Describe the business objective behind this goal"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>
      <div className="pt-1 border-t border-white/[0.06]">
        <p className="text-[11px] text-violet-300/80 uppercase tracking-wider mb-2 mt-2">
          Sent to every agent working on this goal
        </p>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          Acceptance criteria — what &ldquo;done&rdquo; is judged against
        </label>
        <textarea
          value={acceptanceCriteria}
          onChange={(e) => setAcceptanceCriteria(e.target.value)}
          rows={3}
          placeholder={"One per line, testable:\nWhen an admin uploads an invalid certificate, the system shall name the field at fault.\nWhile SSO is unconfigured, the system shall keep password login available."}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          No-gos — explicitly out of scope
        </label>
        <textarea
          value={noGos}
          onChange={(e) => setNoGos(e.target.value)}
          rows={2}
          placeholder="e.g. SCIM provisioning. Redesigning the admin nav. Anything Okta-specific."
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
        <p className="text-[11px] text-gray-600 mt-1">
          The highest-value field here: agents over-reach far more often than they under-deliver.
        </p>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          Invariants — what must not break
        </label>
        <input
          value={invariants}
          onChange={(e) => setInvariants(e.target.value)}
          placeholder="e.g. Existing password sessions must stay valid"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          Rabbit holes — traps already paid for once
        </label>
        <input
          value={rabbitHoles}
          onChange={(e) => setRabbitHoles(e.target.value)}
          placeholder="e.g. The provider-selector refactor burned a week last quarter"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Budget cap — USD (optional)</label>
          <input
            type="number"
            min="0"
            step="1"
            value={budgetUsdStr}
            onChange={(e) => setBudgetUsdStr(e.target.value)}
            placeholder="e.g. 50"
            className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
          />
        </div>
        {initial && (
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Goal['status'])}
              className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="active">Active</option>
              <option value="achieved">Achieved</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        )}
      </div>

      {/* PM surface. Grouped and labelled as optional because every one is genuinely optional:
          unset is a real state the rest of the system handles, not a gap to be filled. */}
      <div className="pt-2 border-t border-white/[0.06]">
        <h4 className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">Planning (optional)</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Target date</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            />
            <p className="text-[10px] text-gray-600 mt-1">Reaches the agent — it scopes work to fit.</p>
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Owner</label>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="Who is accountable"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-white/25"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Investment</label>
            <select
              value={investmentCategory}
              onChange={(e) => setInvestmentCategory(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">Uncategorised</option>
              {registries.categories.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Autonomy</label>
            <select
              value={autonomy}
              onChange={(e) => setAutonomy(e.target.value)}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">Not set — agents behave as they do today</option>
              {registries.autonomyLevels.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-600 mt-1">
              {registries.autonomyLevels.find((a) => a.key === autonomy)?.hint
                ?? 'Sent to every agent working under this goal, as an instruction.'}
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), successMetric: successMetric.trim(), budgetUsd: budgetUsdStr ? parseFloat(budgetUsdStr) : null, status, acceptanceCriteria: acceptanceCriteria.trim(), noGos: noGos.trim(), rabbitHoles: rabbitHoles.trim(), invariants: invariants.trim(), targetDate, owner: owner.trim(), investmentCategory, autonomy })}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
        >
          {initial ? 'Save' : 'Create Goal'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ProjectFormProps {
  goals: Goal[];
  initial?: Partial<Project>;
  onSave: (data: { name: string; description: string; goalId: string | null; primaryRepo: string; color: string; cartridges: string[] }) => void;
  onCancel: () => void;
}

function ProjectForm({ goals, initial, onSave, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [goalId, setGoalId] = useState<string | null>(initial?.goalId || null);
  const [primaryRepo, setPrimaryRepo] = useState(initial?.primaryRepo || '');
  const [color, setColor] = useState(initial?.color || '#a855f7');
  // The cartridges this project owns. Seeded from primaryRepo for a project created before
  // projects had a set, so editing an old project does not silently unlink it.
  const [cartridges, setCartridges] = useState<string[]>(
    initial?.cartridges?.length ? initial.cartridges : (initial?.primaryRepo ? [initial.primaryRepo] : []),
  );
  // Every repo a cartridge has ever registered in — the real candidates, deduped.
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    api.getAgents()
      .then((as) => setKnown([...new Set(as.map((a) => a.repoPath).filter(Boolean))].sort()))
      .catch(() => setKnown([]));
  }, []);
  const toggle = (repo: string) =>
    setCartridges((prev) => (prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo]));

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Project name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Auth service refactor"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What work does this project cover?"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Goal (optional)</label>
        <select
          value={goalId || ''}
          onChange={(e) => setGoalId(e.target.value || null)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
        >
          <option value="">— No goal —</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Codebase — for doc output &amp; save-to-project (optional)</label>
        <FolderPicker value={primaryRepo} onChange={setPrimaryRepo} />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          Cartridges — every repo whose work belongs to this project
        </label>
        {known.length === 0 ? (
          <p className="text-[11px] text-gray-600">No cartridges have registered yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {known.map((repo) => (
              <button
                key={repo}
                onClick={() => toggle(repo)}
                title={repo}
                className={`px-2 py-1 text-[11px] rounded transition-colors ${
                  cartridges.includes(repo)
                    ? 'bg-violet-900/60 text-violet-200'
                    : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'
                }`}
              >
                {repo.split('/').pop()}
              </button>
            ))}
          </div>
        )}
        <p className="text-[10px] text-gray-600 mt-1">
          Anything these cartridges do — prompts, confers, workflow runs — counts as this
          project's work. Nothing needs tagging.
        </p>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Color</label>
        <div className="flex gap-2 flex-wrap">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-white scale-110' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), goalId, primaryRepo: primaryRepo.trim(), color, cartridges })}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
        >
          {initial ? 'Save' : 'Create Project'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  onEdit: (p: Project) => void;
  onDelete: (id: string) => void;
  onLearnings: (p: Project) => void;
  onHeartbeats: (p: Project) => void;
  onRun: (p: Project) => void;
}

function ProjectCard({ project, onEdit, onDelete, onLearnings, onHeartbeats, onRun }: ProjectCardProps) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} />
          <span className="text-sm font-medium text-gray-200 truncate">{project.name}</span>
          {(project.activeRunCount ?? 0) > 0
            ? <span className="inline-flex items-center gap-1 text-[10px] text-blue-400 bg-blue-900/30 border border-blue-700/30 rounded-full px-1.5 py-0.5 flex-shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />{project.activeRunCount} running</span>
            : project.lastRunStatus && <RunStatusDot status={project.lastRunStatus} />
          }
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={() => onRun(project)}
            className="text-gray-600 hover:text-violet-400 transition-colors p-0.5"
            title="Run workflow"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
          </button>
          <button onClick={() => onEdit(project)} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button onClick={() => onDelete(project.id)} className="text-gray-600 hover:text-red-400 transition-colors p-0.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>
      {project.description && (
        <p className="text-[12px] text-gray-500 leading-relaxed line-clamp-2">{project.description}</p>
      )}
      <div className="flex items-center justify-between gap-2 mt-auto pt-1 border-t border-white/[0.05]">
        <div className="flex items-center gap-3 text-[11px] text-gray-600">
          {project.primaryRepo && (
            <span className="truncate max-w-[100px]" title={project.primaryRepo}>
              {project.primaryRepo.split('/').pop()}
            </span>
          )}
          <span>{project.runCount ?? 0} runs</span>
          {(project.tokensUsed ?? 0) > 0 && (
            <span className="text-violet-400">{formatTokens(project.tokensUsed!)}</span>
          )}
          {(project.costUsd ?? 0) > 0 && (
            <span className="text-emerald-400" title="Real spend on this cartridge (from session usage)">{formatUsd(project.costUsd!)}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onHeartbeats(project)}
            className="text-[10px] text-gray-600 hover:text-emerald-400 transition-colors flex items-center gap-1"
            title="Scheduled runs"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Schedule
          </button>
          <button
            onClick={() => onLearnings(project)}
            className="text-[10px] text-gray-600 hover:text-violet-400 transition-colors flex items-center gap-1"
            title="Workflow learnings"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
            Learnings
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectLearningsPanel({ project }: { project: Project; onClose: () => void }) {
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
        <p className="text-[12px] text-gray-500">Loading learnings...</p>
      ) : learnings.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-[12px] text-gray-600">No learnings captured yet.</p>
          <p className="text-[11px] text-gray-700 mt-1">Add a "Capture Learnings" connector step at the end of a workflow to start building project memory.</p>
        </div>
      ) : (
        learnings.map((l) => (
          <div key={l.id} className="bg-black/30 border border-white/[0.07] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] font-medium text-violet-400">{l.workflowName}</span>
              <span className="text-[10px] text-gray-600">{formatRelativeTime(l.createdAt)}</span>
              {l.tags.length > 0 && l.tags.map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-gray-500">{t}</span>
              ))}
            </div>
            <pre className="text-[11px] text-gray-400 whitespace-pre-wrap leading-relaxed font-sans line-clamp-6">{l.content}</pre>
          </div>
        ))
      )}
    </div>
  );
}

function RunStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-500',
    running:   'bg-blue-400 animate-pulse',
    failed:    'bg-red-500',
    paused:    'bg-yellow-500',
  };
  const cls = map[status] || 'bg-gray-600';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} title={status} />;
}

function LaunchFromProjectModal({ project, onClose }: { project: Project; onClose: (runId?: string) => void }) {
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
      );
      onClose(result?.workflow?.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Launch failed');
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Workflow template</label>
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
        >
          <option value="">— Select template —</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div>
        {/* NOT optional in practice. Every step of a template is `__deferred__` until launch,
            so without a cartridge the run is created and then dies on step 1. "Any available"
            was a promise nothing kept — nothing picks one for you. */}
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Cartridge</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
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
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
              Or confer across repos
            </label>
            <div className="flex flex-wrap gap-1">
              {agents.map((a) => {
                const on = conferAgents.includes(a.id);
                return (
                  <button
                    key={`confer-${a.id}`}
                    type="button"
                    onClick={() => setConferAgents((prev) =>
                      prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id])}
                    className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                      on
                        ? 'border-amber-400/40 bg-amber-500/10 text-amber-300'
                        : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {a.repoName || a.name}
                  </button>
                );
              })}
            </div>
            {conferAgents.length === 1 && (
              <p className="text-[11px] text-amber-400/70 mt-1">
                Pick one more. A single-cartridge confer is an ordinary run.
              </p>
            )}
            {conferAgents.length >= 2 && (
              <p className="text-[11px] text-gray-500 mt-1">
                {conferAgents.length} cartridges will work every step together. The cartridge
                above is ignored.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Run note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Additional context for this run…"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>

      {learningsCount > 0 && (
        <div className="flex items-center gap-2 bg-violet-900/20 border border-violet-700/30 rounded-lg px-3 py-2">
          <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="text-[12px] text-violet-300">{learningsCount} past learning{learningsCount !== 1 ? 's' : ''} will be auto-injected as context</span>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleLaunch}
          // The cartridge above is ignored while conferring — this said so in the hint
          // and then went on requiring it, so the Launch button stayed grey.
          disabled={!templateId || (!agentId && conferAgents.length < 2) || launching}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm rounded-md transition-colors"
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

function HeartbeatsPanel({ project }: { project: Project; onClose: () => void }) {
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

  if (loading) return <p className="text-[12px] text-gray-500">Loading...</p>;

  return (
    <div className="space-y-3">
      {firedRun && (
        <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-lg px-3 py-2 flex items-center justify-between">
          {/* An id tells you a run exists; the name tells you which one, which is what you go
              looking for in the workflow list a second later. */}
          <span className="text-[12px] text-emerald-400">
            Run started — {firedRunName || `ID: ${firedRun.slice(0, 8)}…`}
          </span>
          <button onClick={() => { setFiredRun(null); setFiredRunName(''); }} className="text-emerald-600 hover:text-emerald-400 text-[11px]">dismiss</button>
        </div>
      )}

      {!showForm && (
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
          className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-violet-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Schedule a recurring run
        </button>
      )}

      {showForm && (
        <div className="bg-black/30 border border-white/[0.07] rounded-lg p-3 space-y-3">
          <h4 className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider">
            {editingId ? 'Edit schedule' : 'New scheduled run'}
          </h4>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Label (optional)</label>
            <input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Weekly code health check"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Workflow template</label>
            <select
              value={form.templateId}
              onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">— Select template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Agent (optional)</label>
            <select
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">— Any available agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.repoName || a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Frequency</label>
              <select
                value={form.scheduleType}
                onChange={(e) => setForm((f) => ({ ...f, scheduleType: e.target.value as HeartbeatFormData['scheduleType'] }))}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>{CADENCE_LABEL[c]}</option>
                ))}
              </select>
            </div>
            {form.scheduleType !== 'hourly' && (
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Time</label>
                <input
                  type="time"
                  value={form.scheduleTime}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleTime: e.target.value }))}
                  className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
                />
              </div>
            )}
            {(form.scheduleType === 'monthly' || form.scheduleType === 'quarterly') && (
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Day of month</label>
                <select
                  value={form.scheduleDayOfMonth}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDayOfMonth: Number(e.target.value) }))}
                  className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}
            {form.scheduleType === 'weekly' && (
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Day</label>
                <select
                  value={form.scheduleDay}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDay: parseInt(e.target.value) }))}
                  className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
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
            <label htmlFor="hb-active" className="text-[12px] text-gray-400">Active</label>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!form.templateId}
              className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm rounded-md transition-colors"
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
        <p className="text-[12px] text-gray-600">No scheduled runs yet.</p>
      ) : (
        heartbeats.map((h) => (
          <div key={h.id} className={`bg-black/30 border rounded-lg p-3 ${h.active ? 'border-white/[0.07]' : 'border-white/[0.04] opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${h.active ? 'bg-emerald-500' : 'bg-gray-600'}`} />
                  <span className="text-[12px] font-medium text-gray-200 truncate">{h.label || h.templateName || h.templateId.slice(0, 8)}</span>
                </div>
                <p className="text-[11px] text-gray-500 ml-4">{h.scheduleLabel}</p>
                {h.templateName && h.label && (
                  <p className="text-[10px] text-gray-600 ml-4 mt-0.5">{h.templateName}</p>
                )}
                <div className="flex gap-3 text-[10px] text-gray-700 ml-4 mt-1">
                  {h.lastRunAt && <span>Last: {formatRelativeTime(h.lastRunAt)}</span>}
                  <span>Next: {formatNextRun(h.nextRunAt)}</span>
                  {h.agentName && <span>Agent: {h.agentName}</span>}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleFire(h.id)}
                  disabled={firing === h.id}
                  className="text-gray-600 hover:text-emerald-400 disabled:opacity-40 transition-colors p-0.5"
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
                <button onClick={() => startEdit(h)} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                </button>
                <button onClick={() => handleDelete(h.id)} className="text-gray-600 hover:text-red-400 transition-colors p-0.5">
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

const TASK_STATUS_DOT: Record<string, string> = {
  queued: 'bg-gray-500',
  claimed: 'bg-blue-400',
  in_progress: 'bg-violet-400 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-yellow-600',
};

// ── modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      {/* Scrolls INSIDE itself. Without the height cap a long form simply grows past the
          viewport: the title clips off the top, the Save button sits on the bottom edge, and
          neither can be reached because the page behind a `fixed inset-0` overlay does not
          scroll. The goal form crossed that line when the planning fields were added, but the
          bug was latent before — the fix belongs on the Modal, not on one form. */}
      <div className="relative bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-lg shadow-2xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── shared state ──────────────────────────────────────────────────────────────

/**
 * MASTER–DETAIL, AND WHY THE STATE HAD TO LEAVE THIS FILE'S TOP-LEVEL COMPONENT.
 *
 * The ask was "the list of goals on the 1/3 section with the 2/3 the place where we
 * work". Those are not two halves of one component — they are App's `<aside>` and
 * App's `<main>`, two sibling regions with the grid between them. A single `GoalsPage`
 * rendered inside `<main>` can only ever produce a nested 1/3 of the 2/3, which is a
 * different layout wearing the same proportions.
 *
 * So the page splits into two exported surfaces that App places independently, and the
 * state they share — goals, projects, selection, the modal stack — lifts into a context
 * that wraps the grid. `GoalsRail` and `GoalsWorkspace` are views onto one store; there
 * is no prop bridge between them and no second fetch.
 *
 * The provider stays MOUNTED across view switches and fetches only when `active`, so
 * moving to Agents and back does not re-request the whole hierarchy, and switching views
 * does not remount App's grid (which would tear down the cartridge tree beside it).
 */

type ModalState =
  | { type: 'new-goal' }
  | { type: 'edit-goal'; goal: Goal }
  | { type: 'new-project'; goalId: string | null }
  | { type: 'edit-project'; project: Project }
  | { type: 'learnings'; project: Project }
  | { type: 'heartbeats'; project: Project }
  | { type: 'run'; project: Project }
  | { type: 'draft'; goal: Goal }
  | { type: 'decompose'; goal: Goal }
  | null;

interface GoalsContextValue {
  goals: Goal[];
  /** Only for the authoring assistant's cartridge picker — drafting runs on a cartridge. */
  agents: Agent[];
  projects: Project[];
  tasks: Task[];
  loading: boolean;
  /** What the workspace can actually show — already resolved, never the raw request. */
  selected: string | null;
  select: (id: string) => void;
  modal: ModalState;
  setModal: (m: ModalState) => void;
  refresh: () => Promise<void>;
  createGoal: (data: Parameters<typeof api.createGoal>[0]) => Promise<void>;
  updateGoal: (id: string, data: Parameters<typeof api.updateGoal>[1]) => Promise<void>;
  deleteGoal: (id: string) => Promise<void>;
  createProject: (data: Parameters<typeof api.createProject>[0]) => Promise<void>;
  updateProject: (id: string, data: Parameters<typeof api.updateProject>[1]) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}

const GoalsContext = createContext<GoalsContextValue | null>(null);

function useGoalsContext(): GoalsContextValue {
  const ctx = useContext(GoalsContext);
  if (!ctx) throw new Error('GoalsRail/GoalsWorkspace must render inside <GoalsProvider>');
  return ctx;
}

export function GoalsProvider({ active, agents, children }: { active: boolean; agents: Agent[]; children: React.ReactNode }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);

  // What the URL asked for. Kept separate from what is shown — see lib/goalSelection.
  const [requested, setRequested] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : parseGoalHash(window.location.hash),
  );

  const refresh = useCallback(async () => {
    const [g, p, t] = await Promise.all([api.getGoals(), api.getGoalProjects(), api.getTasks()]);
    setGoals(g);
    setProjects(p);
    setTasks(t);
    setLoading(false);
  }, []);

  // Only the Goals view needs this data. Fetching on mount regardless would put three
  // requests behind every page load of the Agents view, which is the default view.
  useEffect(() => { if (active) refresh(); }, [active, refresh]);

  // Back/forward and pasted links both arrive as hashchange.
  useEffect(() => {
    const onHash = () => setRequested(parseGoalHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useSocket({
    onWorkflowUpdated: useCallback(() => { if (active) refresh(); }, [active, refresh]),
    onReconnect: useCallback(() => { if (active) refresh(); }, [active, refresh]),
  });

  const hasUnassigned = projects.some((p) => !p.goalId);
  const selected = useMemo(
    () => resolveSelection({ goalIds: goals.map((g) => g.id), hasUnassigned, requested }),
    [goals, hasUnassigned, requested],
  );

  const select = useCallback((id: string) => {
    // Writing the hash is what makes a goal addressable and survive a refresh; the local
    // set keeps the click instant rather than waiting on the hashchange round trip.
    window.location.hash = goalHash(id);
    setRequested(id);
  }, []);

  const createGoal = useCallback(async (data: Parameters<typeof api.createGoal>[0]) => {
    const goal = await api.createGoal(data);
    setGoals((prev) => [goal, ...prev]);
    setModal(null);
    select(goal.id);           // land in the new goal, not back on the old selection
  }, [select]);

  const updateGoal = useCallback(async (id: string, data: Parameters<typeof api.updateGoal>[1]) => {
    const updated = await api.updateGoal(id, data);
    setGoals((prev) => prev.map((g) => (g.id === id ? updated : g)));
    setModal(null);
  }, []);

  const deleteGoal = useCallback(async (id: string) => {
    if (!confirm('Delete this goal? Projects under it will lose their goal association.')) return;
    await api.deleteGoal(id);
    setGoals((prev) => prev.filter((g) => g.id !== id));
    // Projects survive the goal and become unassigned — reflect that without a refetch,
    // or the rail keeps showing them under a goal that no longer exists.
    setProjects((prev) => prev.map((p) => (p.goalId === id ? { ...p, goalId: null } : p)));
    // No explicit re-select: `resolveSelection` sees the id vanish and falls back.
  }, []);

  const createProject = useCallback(async (data: Parameters<typeof api.createProject>[0]) => {
    const project = await api.createProject(data);
    setProjects((prev) => [project, ...prev]);
    setModal(null);
  }, []);

  const updateProject = useCallback(async (id: string, data: Parameters<typeof api.updateProject>[1]) => {
    const updated = await api.updateProject(id, data);
    setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
    setModal(null);
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    if (!confirm('Delete this project?')) return;
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const value: GoalsContextValue = {
    goals, projects, tasks, agents, loading, selected, select, modal, setModal, refresh,
    createGoal, updateGoal, deleteGoal, createProject, updateProject, deleteProject,
  };

  return <GoalsContext.Provider value={value}>{children}</GoalsContext.Provider>;
}

// ── the rail (left 1/3) ───────────────────────────────────────────────────────

/**
 * Schedule tone. `met` is deliberately NOT red: a goal that finished after its date is done,
 * and colouring it as a failure forever trains people to ignore the badge.
 */
const SCHEDULE_TONE: Record<string, string> = {
  overdue: 'text-red-400',
  'due-soon': 'text-amber-300',
  'on-time': 'text-gray-600',
  met: 'text-emerald-400',
};
const SCHEDULE_LABEL: Record<string, string> = {
  overdue: 'overdue',
  'due-soon': 'due soon',
  'on-time': 'on time',
  met: 'met',
};

const STATUS_DOT: Record<Goal['status'], string> = {
  active: 'bg-violet-400',
  achieved: 'bg-emerald-400',
  paused: 'bg-gray-500',
};

function RailItem({ active, onSelect, children }: { active: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
        active
          ? 'bg-violet-900/25 border-violet-700/50'
          : 'bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06]'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The cross-goal strip.
 *
 * Renders ONLY when the server says so, and the server says so only above one goal. The
 * research objected to a portfolio view at this scale — above a single goal the strip is a
 * second, worse copy of the card beneath it — and `show` is computed server-side precisely so
 * that rule lives in one place instead of being duplicated here and drifting.
 */
function PortfolioStrip() {
  const [data, setData] = useState<{ show: boolean; summary: PortfolioSummary } | null>(null);

  useEffect(() => {
    api.getPortfolio().then((p) => setData({ show: p.show, summary: p.summary })).catch(() => {});
  }, []);

  if (!data?.show) return null;
  const s = data.summary;
  const pct = s.fraction === null ? null : Math.round(s.fraction * 100);

  return (
    <div className="mb-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] text-gray-500 uppercase tracking-wider">Across {s.goalCount} goals</span>
        {s.totalCostUsd > 0 && <span className="text-[11px] text-emerald-400">{formatUsd(s.totalCostUsd)}</span>}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-gray-600 flex-wrap">
        <span>{s.activeCount} active</span>
        {/* Both counts are shown only when non-zero: a row of confident zeroes reads as
            "everything is fine", which is a claim, whereas absence is not. */}
        {s.needsAttentionCount > 0 && (
          <span className="text-amber-300">{s.needsAttentionCount} need you</span>
        )}
        {s.overdueCount > 0 && <span className="text-red-400">{s.overdueCount} overdue</span>}
        <span>{pct === null ? 'nothing measurable yet' : `${pct}% of steps done`}</span>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-0.5 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${pct}%` }} />
        </div>
      )}
      {/* Uncategorised is shown as its own slice rather than dropped — hiding it would make the
          split look complete while the largest share of spend is missing. */}
      {s.byCategory.filter((c) => c.costUsd > 0).length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-600">
          {s.byCategory.filter((c) => c.costUsd > 0).map((c) => (
            <span key={c.category || 'none'}>
              {c.label} {formatUsd(c.costUsd)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The goals list. Lives in App's `<aside>`, which is sticky and scrolls on its own — so a
 * long list of goals never pushes the working surface beside it down the page.
 */
export function GoalsRail() {
  const { goals, projects, loading, selected, select, setModal } = useGoalsContext();
  const ungrouped = unassignedProjects(projects);

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <SectionTitle>Goals</SectionTitle>
        {/* HIERARCHY ORDER: Goal, then Project.
            They read Project-then-Goal, which inverts the containment the whole page is built
            on — a project lives under a goal, and this is the one place a user meets both at
            once. Goal also keeps the primary treatment: creating a project without a goal is
            legal but produces work that rolls up to nothing (the amber notice below). */}
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={() => setModal({ type: 'new-goal' })}
            title="New goal"
            className="text-[11px] text-white bg-violet-600 hover:bg-violet-500 px-2 py-1 rounded-md transition-colors font-medium"
          >
            + Goal
          </button>
          <button
            onClick={() => setModal({ type: 'new-project', goalId: null })}
            title="New project — lives under a goal"
            className="text-[11px] text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/20 px-2 py-1 rounded-md transition-colors"
          >
            + Project
          </button>
        </div>
      </div>

      {/* A project without a goal is allowed on purpose — quick work should not need
          ceremony. That makes this line the entire safety mechanism: unattached work
          contributes nothing to reach or cost and receives no goal brief, and until now
          nothing said so. Silent at zero. */}
      {unassignedNotice(projects) && (
        <p className="text-[11px] text-amber-300/80 mb-2 leading-snug">{unassignedNotice(projects)}</p>
      )}

      <PortfolioStrip />

      {loading ? (
        <p className="text-[12px] text-gray-600 py-4">Loading…</p>
      ) : goals.length === 0 && ungrouped.length === 0 ? (
        <div className="border border-white/[0.06] rounded-lg bg-white/[0.02] p-4 text-center">
          <div className="text-2xl mb-2">🎯</div>
          <p className="text-[12px] text-gray-500 leading-snug">
            Goals connect workflow runs to something. Create one and every run counts toward it.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {goals.map((goal) => {
            const count = projects.filter((p) => p.goalId === goal.id).length;
            const reach = goal.reach ?? 0;
            const spent = goal.costUsd ?? 0;
            return (
              <RailItem key={goal.id} active={selected === goal.id} onSelect={() => select(goal.id)}>
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[goal.status]}`} title={goal.status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-gray-100 truncate">{goal.name}</div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-600 flex-wrap">
                      <span>{count} {count === 1 ? 'project' : 'projects'}</span>
                      {/* Reach is the number that makes the others legible: at 0 the brief
                          reaches no prompt and the spend beside it cannot move. */}
                      {reach === 0 ? (
                        <span className="text-amber-300/90" title="No cartridge resolves to this goal — its brief reaches no prompts and its cost stays $0">
                          reaches nothing
                        </span>
                      ) : (
                        <span>{reach} {reach === 1 ? 'cartridge' : 'cartridges'}</span>
                      )}
                      {spent > 0 && <span className="text-emerald-400">{formatUsd(spent)}</span>}
                      {goal.schedule && (
                        <span className={SCHEDULE_TONE[goal.schedule.state]} title={goal.schedule.detail}>
                          {SCHEDULE_LABEL[goal.schedule.state]}
                        </span>
                      )}
                    </div>
                    {/* Progress. The bar is drawn ONLY when there is something to measure —
                        an empty bar for a goal nobody has started reads as failing. */}
                    {(() => {
                      const pv = progressView(goal);
                      return (
                        <div className="mt-1.5">
                          {pv.pct !== null && (
                            <div className="h-0.5 bg-white/10 rounded-full overflow-hidden mb-1">
                              <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${pv.pct}%` }} />
                            </div>
                          )}
                          <div className="text-[10px] text-gray-600">
                            {pv.pct !== null ? `${pv.pct}% · ${pv.text}` : pv.text}
                          </div>
                        </div>
                      );
                    })()}
                    {/* Health — the "does anything need me" answer, at a glance across goals. */}
                    {(() => {
                      const hv = healthView(goal.health);
                      if (!hv) return null;
                      return (
                        <div
                          className={`mt-1.5 text-[10px] font-medium ${hv.tone === 'bad' ? 'text-red-400' : 'text-amber-300'}`}
                          title={hv.detail}
                        >
                          ● {hv.label}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </RailItem>
            );
          })}

          {ungrouped.length > 0 && (
            <RailItem active={selected === UNASSIGNED} onSelect={() => select(UNASSIGNED)}>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-400/70" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-amber-200/90 truncate">No goal</div>
                  <div className="mt-1 text-[10px] text-gray-600">
                    {ungrouped.length} {ungrouped.length === 1 ? 'project' : 'projects'} · rolls up to nothing
                  </div>
                </div>
              </div>
            </RailItem>
          )}
        </div>
      )}
    </section>
  );
}

// ── the working surface (right 2/3) ───────────────────────────────────────────

/**
 * The intent a goal carries. Driven by a registry rather than written out inline, so the
 * detail pane, the "how complete is this goal" count and any field added later cannot
 * drift apart — adding a field here adds it to all three.
 *
 * These are the fields that reach the agent at dispatch through the goal brief, which is
 * why an empty one is worth showing as empty rather than hiding.
 */
const INTENT_FIELDS: { key: string; label: string; hint: string; read: (g: Goal) => string }[] = [
  { key: 'description', label: 'Why this matters', hint: 'The reason the work is worth doing', read: (g) => g.description },
  { key: 'acceptanceCriteria', label: 'Acceptance criteria', hint: 'EARS-form statements — what "done" is judged against', read: (g) => g.acceptanceCriteria },
  { key: 'invariants', label: 'Invariants', hint: 'What must stay true while the work happens', read: (g) => g.invariants },
  { key: 'noGos', label: 'No-gos', hint: 'Explicitly out of scope — the field that fights agent over-reach', read: (g) => g.noGos },
  { key: 'rabbitHoles', label: 'Rabbit holes', hint: 'Known time sinks to steer around', read: (g) => g.rabbitHoles },
];

function IntentBlock({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div>
      <h4 className="text-[11px] text-gray-500 uppercase tracking-wider" title={hint}>{label}</h4>
      {value ? (
        <p className="text-[13px] text-gray-300 mt-1 whitespace-pre-wrap leading-relaxed">{value}</p>
      ) : (
        <p className="text-[12px] text-gray-600 mt-1 italic">Not set — this reaches no agent</p>
      )}
    </div>
  );
}

function GoalDetail({ goal }: { goal: Goal }) {
  const { projects, tasks, setModal, deleteGoal, deleteProject } = useGoalsContext();
  const mine = projects.filter((p) => p.goalId === goal.id);
  const reach = goal.reach ?? 0;
  const spentUsd = goal.costUsd ?? 0;
  const budgetPct = goal.budgetUsd && spentUsd > 0 ? Math.min(100, (spentUsd / goal.budgetUsd) * 100) : null;
  const totalTokens = mine.reduce((s, p) => s + (p.tokensUsed ?? 0), 0);

  const projectIds = new Set(mine.map((p) => p.id));
  const goalTasks = tasks.filter((t) => t.projectId && projectIds.has(t.projectId));
  const activeTasks = goalTasks.filter((t) => ['queued', 'claimed', 'in_progress'].includes(t.status));

  const filled = INTENT_FIELDS.filter((f) => f.read(goal).trim()).length;

  const projectHandlers = {
    onEdit: (p: Project) => setModal({ type: 'edit-project', project: p }),
    onDelete: deleteProject,
    onLearnings: (p: Project) => setModal({ type: 'learnings', project: p }),
    onHeartbeats: (p: Project) => setModal({ type: 'heartbeats', project: p }),
    onRun: (p: Project) => setModal({ type: 'run', project: p }),
  };

  return (
    <div className="space-y-5">
      {/* Identity. Titled through the shared primitive rather than hand-set type — the
          working surface is a new screen, and a new screen with its own heading style is
          exactly how the five variants SectionTitle replaced came about. */}
      <div>
        <SectionTitle
          actions={
            <>
              <button
                onClick={() => setModal({ type: 'edit-goal', goal })}
                className="text-xs text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-md transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => deleteGoal(goal.id)}
                className="text-xs text-gray-500 hover:text-red-400 border border-white/10 hover:border-red-700/40 px-3 py-1.5 rounded-md transition-colors"
              >
                Delete
              </button>
            </>
          }
        >
          {goal.name}
          {statusBadge(goal.status)}
        </SectionTitle>
        {goal.successMetric && (
          <p className="text-[13px] text-gray-500 -mt-1">
            <span className="text-gray-600">Done when: </span>{goal.successMetric}
          </p>
        )}
      </div>

      {/* Does anything need me? First, because it is the only thing here that is time-sensitive
          — cost and progress can wait, a blocked run cannot. Absent entirely when nothing is
          waiting: an "all good" badge on a goal with no runs would claim evidence there is none. */}
      {(() => {
        const hv = healthView(goal.health);
        if (!hv) return null;
        return (
          <div
            className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border ${
              hv.tone === 'bad'
                ? 'bg-red-900/25 border-red-700/40 text-red-300'
                : 'bg-amber-900/20 border-amber-700/40 text-amber-200'
            }`}
          >
            <span className="mt-0.5 text-[13px] leading-none" aria-hidden="true">●</span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{hv.label}</div>
              <p className="text-[12px] opacity-80 mt-0.5">{hv.detail}</p>
              {hv.runName && <p className="text-[11px] opacity-60 mt-0.5">in {hv.runName}</p>}
            </div>
          </div>
        );
      })()}

      {/* How far along. Words and counts, not a bare percentage — "30%" of what is
          unanswerable, "12 of 40 steps" can be checked against the runs themselves. */}
      {(() => {
        const pv = progressView(goal);
        return (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <h3 className="text-[11px] text-gray-500 uppercase tracking-wider">Progress</h3>
              <span className="text-[11px] text-gray-500">
                {pv.pct !== null ? `${pv.pct}% · ${pv.text}` : pv.text}
              </span>
            </div>
            {pv.pct !== null ? (
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${pv.pct}%` }} />
              </div>
            ) : (
              // No bar at all. An empty track would read as 0% — work started, got nowhere —
              // which is a different and more damning claim than "nothing has run yet".
              <p className="text-[12px] text-gray-600">
                Progress appears once a workflow runs against one of this goal's projects.
              </p>
            )}
            {pv.pct !== null && (
              <p className="text-[11px] text-gray-600 mt-1">
                Counted across {goal.progress?.runsCounted ?? 0}{' '}
                {(goal.progress?.runsCounted ?? 0) === 1 ? 'run' : 'runs'}; cancelled runs excluded.
                Measures steps completed, not acceptance criteria met.
              </p>
            )}
          </div>
        );
      })()}

      {/* Where it stands */}
      <div className="flex items-center gap-4 text-[11px] text-gray-600 flex-wrap border-y border-white/[0.06] py-2.5">
        <span>{mine.length} {mine.length === 1 ? 'project' : 'projects'}</span>
        {reach === 0 ? (
          <span className="text-amber-300/90 font-medium" title="No cartridge resolves to this goal, so its brief reaches no prompts and its cost stays $0. Attach a repo to one of its projects.">
            reaches no cartridges
          </span>
        ) : (
          <span title="Cartridges that receive this goal's brief at dispatch">
            reaches {reach} {reach === 1 ? 'cartridge' : 'cartridges'}
          </span>
        )}
        <span>{goal.runCount ?? 0} runs</span>
        {goalTasks.length > 0 && (
          <span>{activeTasks.length} active {activeTasks.length === 1 ? 'task' : 'tasks'}</span>
        )}
        {spentUsd > 0 && (
          <span className="text-emerald-400 font-medium" title="Real spend across this goal's cartridges — workflows + tasks, cache-inclusive">
            {formatUsd(spentUsd)} spent
          </span>
        )}
        {goal.budgetUsd && <span>/ {formatUsd(goal.budgetUsd)} budget</span>}
        {totalTokens > 0 && (
          <span className="text-violet-400/60" title="Workflow token estimate (does not include tasks)">
            {formatTokens(totalTokens)} · workflows
          </span>
        )}
        {/* Only rendered when a date was actually set. A goal with no target is not "on time" —
            it has no schedule, and a badge on every goal would mean nothing. */}
        {goal.schedule && (
          <span className={`font-medium ${SCHEDULE_TONE[goal.schedule.state]}`} title={goal.schedule.detail}>
            {goal.schedule.state === 'met' ? 'target met' : `${SCHEDULE_LABEL[goal.schedule.state]} · ${goal.schedule.targetDate}`}
          </span>
        )}
        {goal.owner && <span title="Accountable for this goal">owner: {goal.owner}</span>}
      </div>
      {goal.schedule && goal.schedule.state !== 'on-time' && (
        <p className={`text-[12px] -mt-2 ${SCHEDULE_TONE[goal.schedule.state]}`}>{goal.schedule.detail}</p>
      )}

      {budgetPct !== null && (
        <div>
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${budgetPct >= 90 ? 'bg-red-500' : budgetPct >= 70 ? 'bg-yellow-500' : 'bg-violet-500'}`}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
          {budgetPct >= 90 && (
            <div className={`mt-2 flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] font-medium ${budgetPct >= 100 ? 'bg-red-900/30 border border-red-700/40 text-red-400' : 'bg-yellow-900/30 border border-yellow-700/40 text-yellow-400'}`}>
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              {budgetPct >= 100 ? 'Budget cap reached — heartbeats paused' : `${Math.round(budgetPct)}% of budget used — approaching cap`}
            </div>
          )}
        </div>
      )}

      {/* Intent. This is what the goal brief carries into every dispatched prompt, so an
          unfilled goal is a goal that says nothing to the agents working under it —
          shown as a countable gap rather than an empty area. */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-[11px] text-gray-500 uppercase tracking-wider">Intent</h3>
          <div className="flex items-center gap-3">
            {/* Offered right where the gap is already visible. The count says how much of the
                goal says nothing to the agents working under it; this is how you fill it. */}
            <button
              onClick={() => setModal({ type: 'draft', goal })}
              className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
              title="A cartridge drafts the intent from a sentence or two. You accept it field by field — nothing is applied automatically."
            >
              ✎ Help me write this
            </button>
            <span className={`text-[10px] ${filled === INTENT_FIELDS.length ? 'text-gray-600' : 'text-amber-300/80'}`}>
              {filled}/{INTENT_FIELDS.length} filled
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
          {INTENT_FIELDS.map((f) => (
            <IntentBlock key={f.key} label={f.label} hint={f.hint} value={f.read(goal)} />
          ))}
        </div>
        {goal.keyResults?.length > 0 && (
          <div className="mt-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
            <h4 className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">Key results</h4>
            <div className="space-y-1.5">
              {goal.keyResults.map((kr, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px] text-gray-400">
                  <span className="text-gray-300">{kr.metric}</span>
                  {kr.baseline && <span className="text-gray-600">from {kr.baseline}</span>}
                  {kr.target && <span className="text-emerald-400/80">to {kr.target}</span>}
                  {kr.measure && <span className="text-gray-600">· {kr.measure}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Projects */}
      <div>
        <h3 className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">Projects</h3>
        {mine.length === 0 ? (
          <p className="text-[12px] text-gray-600">No projects yet — add one to start tracking work against this goal.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {mine.map((p) => <ProjectCard key={p.id} project={p} {...projectHandlers} />)}
          </div>
        )}
        <button
          onClick={() => setModal({ type: 'new-project', goalId: goal.id })}
          className="mt-3 flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-violet-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add project
        </button>
        {/* Decompose. Offered next to the manual path rather than instead of it: the point is
            to stop the user typing every task, not to remove the option. */}
        <button
          onClick={() => setModal({ type: 'decompose', goal })}
          className="mt-3 ml-4 text-[12px] text-violet-400 hover:text-violet-300 transition-colors"
          title="A cartridge reads the repo and proposes projects and tasks. You pick what becomes real — nothing is created automatically."
        >
          ✦ Plan the work for me
        </button>
      </div>

      {/* Tasks under this goal's projects */}
      {goalTasks.length > 0 && (
        <div>
          <h3 className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">Tasks</h3>
          <div className="space-y-1.5">
            {goalTasks.slice(0, 12).map((t) => {
              const project = mine.find((p) => p.id === t.projectId);
              return (
                <div key={t.id} className="flex items-center gap-2 text-[12px] bg-black/20 border border-white/[0.05] rounded-md px-2.5 py-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TASK_STATUS_DOT[t.status] || 'bg-gray-600'}`} title={t.status} />
                  <span className="text-gray-300 truncate flex-1">{t.title}</span>
                  {project && (
                    <span className="text-[10px] flex-shrink-0" style={{ color: project.color }} title={project.name}>
                      {project.name}
                    </span>
                  )}
                </div>
              );
            })}
            {goalTasks.length > 12 && (
              <p className="text-[11px] text-gray-600 pl-1">+{goalTasks.length - 12} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UnassignedDetail() {
  const { projects, setModal, deleteProject } = useGoalsContext();
  const mine = unassignedProjects(projects);

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle>Projects without a goal</SectionTitle>
        <p className="text-[13px] text-gray-500 -mt-1 max-w-xl leading-relaxed">
          These are legal — quick work should not need ceremony. But they contribute nothing to any
          goal's reach or cost, and the cartridges working on them receive no goal brief at dispatch.
          Attach one to a goal from its Edit form to change that.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {mine.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onEdit={(proj) => setModal({ type: 'edit-project', project: proj })}
            onDelete={deleteProject}
            onLearnings={(proj) => setModal({ type: 'learnings', project: proj })}
            onHeartbeats={(proj) => setModal({ type: 'heartbeats', project: proj })}
            onRun={(proj) => setModal({ type: 'run', project: proj })}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The working surface. Lives in App's `<main>`.
 *
 * Modals render here rather than in the rail so there is exactly one of each in the tree,
 * and so they are reachable from the empty state — where "New Goal" is the only thing to do.
 */
export function GoalsWorkspace() {
  const { goals, agents, loading, selected, modal, setModal, refresh, createGoal, updateGoal, createProject, updateProject } = useGoalsContext();
  const goal = selected && selected !== UNASSIGNED ? goals.find((g) => g.id === selected) : undefined;

  return (
    <section>
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <span className="text-sm text-gray-500">Loading...</span>
        </div>
      ) : selected === null ? (
        <div className="text-center py-16 border border-white/[0.06] rounded-xl bg-white/[0.02]">
          <div className="text-3xl mb-3">🎯</div>
          <h3 className="text-sm font-medium text-gray-400 mb-1">No goals yet</h3>
          <p className="text-[12px] text-gray-600 max-w-xs mx-auto">
            Goals connect your AI workflows to business objectives. Set a goal, create projects under
            it, and every workflow run counts toward something.
          </p>
          <button
            onClick={() => setModal({ type: 'new-goal' })}
            className="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-md transition-colors"
          >
            Create your first goal
          </button>
        </div>
      ) : selected === UNASSIGNED ? (
        <UnassignedDetail />
      ) : goal ? (
        <GoalDetail goal={goal} />
      ) : null}

      {/* Modals */}
      {modal?.type === 'new-goal' && (
        <Modal title="New Goal" onClose={() => setModal(null)}>
          <GoalForm onSave={createGoal} onCancel={() => setModal(null)} />
        </Modal>
      )}

      {modal?.type === 'edit-goal' && (
        <Modal title="Edit Goal" onClose={() => setModal(null)}>
          <GoalForm
            initial={modal.goal}
            onSave={(data) => updateGoal(modal.goal.id, data)}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'new-project' && (
        <Modal title="New Project" onClose={() => setModal(null)}>
          <ProjectForm
            goals={goals}
            initial={modal.goalId ? { goalId: modal.goalId } : undefined}
            onSave={createProject}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'edit-project' && (
        <Modal title="Edit Project" onClose={() => setModal(null)}>
          <ProjectForm
            goals={goals}
            initial={modal.project}
            onSave={(data) => updateProject(modal.project.id, data)}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'learnings' && (
        <Modal title={`Learnings — ${modal.project.name}`} onClose={() => setModal(null)}>
          <ProjectLearningsPanel project={modal.project} onClose={() => setModal(null)} />
        </Modal>
      )}

      {modal?.type === 'heartbeats' && (
        <Modal title={`Scheduled Runs — ${modal.project.name}`} onClose={() => setModal(null)}>
          <HeartbeatsPanel project={modal.project} onClose={() => setModal(null)} />
        </Modal>
      )}

      {/* Assisted authoring. The panel produces a PROPOSAL; only its accept writes anything,
          and only the fields ticked there. See components/GoalDraftPanel.tsx. */}
      {modal?.type === 'draft' && (
        <Modal title={`Draft intent — ${modal.goal.name}`} onClose={() => setModal(null)}>
          <GoalDraftPanel
            goal={modal.goal}
            agents={agents}
            onApplied={() => refresh()}
            onClose={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'decompose' && (
        <Modal title={`Plan the work — ${modal.goal.name}`} onClose={() => setModal(null)}>
          <GoalDecomposePanel
            goal={modal.goal}
            agents={agents}
            onAccepted={() => refresh()}
            onClose={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'run' && (
        <Modal title={`Run Workflow — ${modal.project.name}`} onClose={() => setModal(null)}>
          <LaunchFromProjectModal
            project={modal.project}
            onClose={(runId) => {
              setModal(null);
              if (runId) refresh();
            }}
          />
        </Modal>
      )}
    </section>
  );
}
