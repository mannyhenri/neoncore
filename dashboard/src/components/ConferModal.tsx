import { useState } from 'react';
import { api } from '../lib/api';

type ConferAgent = { id: string; name: string; repoName?: string; agentType: string; status: string };

/**
 * Seed a multi-agent "confer" — two or more live cartridges (typically different
 * engines, e.g. Claude + Codex) get the SAME task plus each other's ids, and are
 * told to use the neoncore_message_agent / neoncore_read_agent MCP tools to
 * collaborate and converge on one agreed solution. Pure UI over the existing
 * sendCommand: no dedicated backend endpoint — each participant just gets a
 * command that wires it to its peers.
 */
export function ConferModal({ agents, onClose }: { agents: ConferAgent[]; onClose: () => void }) {
  const live = agents.filter((a) => a.status !== 'offline');
  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const start = async () => {
    if (selected.length < 2) { setError('Pick at least two cartridges to confer.'); return; }
    if (!task.trim()) { setError('Describe the task they should solve together.'); return; }
    setSending(true); setError('');
    try {
      const participants = selected
        .map((id) => live.find((a) => a.id === id))
        .filter((a): a is ConferAgent => !!a);
      for (const me of participants) {
        const peers = participants.filter((p) => p.id !== me.id);
        await api.sendCommand(me.id, conferPrompt(task.trim(), peers), false);
      }
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
          They get the same task + each other's ids, and confer via the neoncore message/read tools to converge on one solution.
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

/** Compose the wire-up prompt one participant receives. */
function conferPrompt(task: string, peers: ConferAgent[]): string {
  const peerLines = peers
    .map((p) => `- ${p.agentType} (${p.repoName || p.name}) — agentId: ${p.id}`)
    .join('\n');
  return [
    `[NeonCore Confer] You're collaborating with ${peers.length} other agent(s) on ONE task. Work together and converge on a single agreed solution — do not work in isolation.`,
    ``,
    `TASK:`,
    task,
    ``,
    `YOUR PEERS (use these ids with the neoncore MCP tools):`,
    peerLines,
    ``,
    `HOW TO CONFER:`,
    `1. neoncore_read_agent("<peerId>") — see what a peer has done so far.`,
    `2. neoncore_message_agent("<peerId>", "...") — share your plan, findings, or critiques.`,
    `3. Divide the work or review each other's approach; iterate until you agree.`,
    `4. Agree on ONE of you to post the final combined solution, and say who.`,
    ``,
    `Begin now by messaging your peer(s) with your initial plan.`,
  ].join('\n');
}
