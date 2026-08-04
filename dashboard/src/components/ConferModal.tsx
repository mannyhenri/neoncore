import { useState } from 'react';
import { api } from '../lib/api';
import { AttachmentField, useAttachments } from './AttachmentPicker';
import type { CommandAttachmentInput, ConferMode } from '../types';

type ConferAgent = { id: string; name: string; repoName?: string; agentType: string; status: string; machine?: string };

/** Bare hostname — cartridges report both "Mac-Pro" and "Mac-Pro.local" for the same box. */
const hostOf = (a: ConferAgent) => (a.machine || '').trim().replace(/\.local$/i, '');

/**
 * Start a milestone-driven "confer" — two or more live cartridges (typically different
 * engines, e.g. Claude + Codex) collaborate on ONE task through a fixed cycle of
 * milestones (Align → Build → Cross-review → Converge → Finalize). The server-side
 * conductor dispatches each milestone to both agents and auto-advances only when both
 * have signalled done, so they keep re-engaging across the whole cycle with no manual step.
 */
export function ConferModal({ agents, onClose }: { agents: ConferAgent[]; onClose: () => void }) {
  const live = agents.filter((a) => a.status !== 'offline');
  // Two machines can each run a cartridge on a repo of the same NAME (your laptop's
  // "backend-interlag" and your desktop's are different checkouts on different disks).
  // Show the machine whenever the fleet spans more than one, so identically-named tiles
  // are tellable apart before you click — and so a cross-machine pick is a choice.
  const hosts = [...new Set(live.map(hostOf).filter(Boolean))];
  const showMachine = hosts.length > 1;

  // Projects (repos) that have 2+ live engines — one click confers them together,
  // matching the "two agents, one project" case without hunting for two tiles.
  // Keyed by repo AND machine: two same-named repos on different boxes are not one
  // project, and quick-picking them together produced a confer whose attachments could
  // never be written for half the participants.
  const byRepo = new Map<string, { repo: string; host: string; list: ConferAgent[] }>();
  for (const a of live) {
    const repo = a.repoName || a.name;
    const host = hostOf(a);
    const key = repo + '\u0000' + host;
    const group = byRepo.get(key) || { repo, host, list: [] as ConferAgent[] };
    group.list.push(a);
    byRepo.set(key, group);
  }
  const readyProjects = [...byRepo.values()].filter((g) => g.list.length >= 2);

  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // divide = split the task into per-agent slices, then merge. collaborate = the whole
  // panel works ONE problem into ONE shared solution. Worktree isolation gives each agent
  // its own git worktree+branch — only meaningful for divide.
  const [mode, setMode] = useState<ConferMode>('divide');
  const [worktree, setWorktree] = useState(false);
  // How many times the build/fix milestone repeats. One pass is fine for a single feature;
  // a list of 20 bugs needs several, each ending in its own commit + push.
  const [buildRounds, setBuildRounds] = useState(1);
  const {
    attachments,
    error: attachmentError,
    setError: setAttachmentError,
    addFiles,
    removeAttachment,
    encode: encodeAttachments,
  } = useAttachments();

  // Attachments are written by THIS server into each participant's checkout, so a
  // cross-machine selection can never receive them. Say so here rather than after upload.
  const selectedHosts = [...new Set(live.filter((a) => selected.includes(a.id)).map(hostOf).filter(Boolean))];

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const start = async () => {
    if (selected.length < 2) { setError('Pick at least two cartridges to confer.'); return; }
    if (!task.trim()) { setError('Describe the task they should solve together.'); return; }
    setSending(true); setError(''); setAttachmentError('');

    let payloads: CommandAttachmentInput[] = [];
    try {
      payloads = await encodeAttachments();
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : 'Could not read attachment.');
      setSending(false);
      return;
    }

    try {
      await api.startConfer(selected, task.trim(), payloads.length > 0 ? payloads : undefined, {
        mode,
        isolation: mode === 'divide' && worktree ? 'worktree' : 'shared',
        buildRounds,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-white/10 bg-[#12141a] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-200">Confer — two agents, one job</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
        <p className="text-[11px] text-gray-500 mb-4">
          They run one task through a milestone cycle — <span className="text-gray-400">{mode === 'collaborate'
            ? `Frame → Draft${buildRounds > 1 ? ` ×${buildRounds}` : ''} → Critique → Revise → Finalize`
            : `Align → Build${buildRounds > 1 ? ` ×${buildRounds}` : ''} → Cross-review → Converge → Finalize`}</span> —
          coordinating via the neoncore message/read tools. Each milestone advances only when every participant signals done; no manual steps.
        </p>

        <label className="block text-xs text-gray-500 mb-1.5">
          Cartridges (pick 2+) ·{' '}
          <span className={selected.length >= 2 ? 'text-emerald-400' : 'text-amber-400'}>
            {selected.length} selected
          </span>
        </label>
        <p className="text-[11px] text-gray-600 mb-2">
          Two engines in the <span className="text-gray-400">same project</span> (e.g. Claude + Codex in one repo) collaborate on it. Different projects = work across codebases.
        </p>

        {readyProjects.length > 0 && (
          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1.5">Quick pick — a project with two engines (one click selects both)</label>
            <div className="flex flex-wrap gap-1.5">
              {readyProjects.map((g) => (
                <button
                  key={`${g.repo}-${g.host}`}
                  onClick={() => setSelected(g.list.map((a) => a.id))}
                  className="rounded-lg px-2.5 py-1.5 border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-[12px]"
                >
                  {g.repo} — {g.list.map((a) => a.agentType).join(' + ')}
                  {showMachine && g.host && <span className="ml-1.5 opacity-60">· {g.host}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {live.length < 2 ? (
          <p className="text-xs text-amber-400 mb-3">Need at least two live cartridges — start another agent first.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 mb-4 max-h-52 overflow-y-auto pr-0.5">
            {live.map((a) => {
              const on = selected.includes(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={`text-left rounded-lg px-2.5 py-2 border transition-colors ${
                    on ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                       : 'bg-white/[0.02] border-white/[0.06] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="text-[13px] font-medium leading-tight capitalize">{a.agentType}</div>
                  <div className="text-[11px] leading-snug opacity-60">{a.repoName || a.name}</div>
                  {showMachine && hostOf(a) && (
                    <div className="text-[10px] leading-snug opacity-45 truncate">{hostOf(a)}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <label className="block text-xs text-gray-500 mb-1.5">Task</label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          placeholder="What should they solve together? (e.g. 'Design + implement the licensing retry logic; one drafts, the other critiques.')"
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none mb-3"
        />

        {/* How the panel relates to the task */}
        <label className="block text-xs text-gray-500 mb-1.5">How they work</label>
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          {([
            { key: 'divide', title: 'Divide', sub: 'Split into per-agent slices, then merge' },
            { key: 'collaborate', title: 'Collaborate', sub: 'One shared solution, together' },
          ] as const).map((m) => {
            const on = mode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`text-left rounded-lg px-2.5 py-2 border transition-colors ${
                  on ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                     : 'bg-white/[0.02] border-white/[0.06] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
                }`}
              >
                <div className="text-[13px] font-medium leading-tight">{m.title}</div>
                <div className="text-[11px] leading-snug opacity-60">{m.sub}</div>
              </button>
            );
          })}
        </div>
        {mode === 'divide' ? (
          <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              className="mt-0.5 accent-emerald-500"
            />
            <span className="text-[11px] text-gray-400 leading-snug">
              Isolate each agent in its own git worktree + branch. Converge becomes a real merge
              (conflicts surface there). Best for same-machine repos — remote agents fall back to the shared checkout.
            </span>
          </label>
        ) : (
          <p className="text-[11px] text-gray-600 mb-3">Collaborate works one shared checkout — no per-agent worktrees.</p>
        )}

        {/* Build rounds — one milestone per round, so a long list of fixes gets several passes
            instead of one rushed one. Each round ends with a commit + push to the same branch. */}
        <label className="block text-xs text-gray-500 mb-1.5">
          {mode === 'collaborate' ? 'Draft' : 'Build'} rounds
        </label>
        <div className="flex items-center gap-1.5 mb-1.5">
          {[1, 2, 3, 5, 10].map((n) => (
            <button
              key={n}
              onClick={() => setBuildRounds(n)}
              className={`rounded-lg px-2.5 py-1.5 border text-[12px] transition-colors ${
                buildRounds === n
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'bg-white/[0.02] border-white/[0.06] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
              }`}
            >
              ×{n}
            </button>
          ))}
          <input
            type="number"
            min={1}
            max={20}
            value={buildRounds}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setBuildRounds(Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 1);
            }}
            className="w-16 text-sm glass-input text-gray-300 rounded-md px-2 py-1 focus:outline-none"
            aria-label="Build rounds"
          />
        </div>
        <p className="text-[11px] text-gray-600 mb-3">
          {buildRounds > 1
            ? `${buildRounds} build passes before review. Each round takes the NEXT batch of items and ends with a commit + push to the same ongoing branch — use this when the task is a list (e.g. 20 bugs from an eval), not one feature.`
            : 'One build pass, then review. Raise this when the task is a list of fixes — each extra round works the next batch and pushes it.'}
        </p>

        <div className="mb-3">
          <AttachmentField
            attachments={attachments}
            error={attachmentError}
            onAddFiles={addFiles}
            onRemove={removeAttachment}
            hint="Optional — copied into each participant's repo so both engines can open them. Referenced in every milestone prompt."
          />
          {attachments.length > 0 && selectedHosts.length > 1 && (
            <p className="text-[11px] text-amber-400 mt-1.5">
              This selection spans {selectedHosts.join(' and ')}. Attachments can only be copied into
              checkouts on this machine — drop the attachments, or pick cartridges on one machine.
            </p>
          )}
        </div>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        {(selected.length < 2 || !task.trim()) && !error && (
          <p className="text-[11px] text-gray-500 mb-3">
            {selected.length < 2 ? 'Select at least 2 cartridges' : 'Enter a task'} to enable Start.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-md">Cancel</button>
          <button
            onClick={start}
            disabled={sending}
            className="text-sm font-medium text-emerald-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 px-4 py-1.5 rounded-md"
          >
            {sending ? 'Starting…' : `Start confer (${selected.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
