import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, Worktree } from '../types';
import { api } from '../lib/api';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface Props {
  agent: Agent;
  onClose: () => void;
}

type Tab = 'status' | 'worktrees' | 'branches';

export function GitPanel({ agent, onClose }: Props) {
  useEscapeKey(onClose);
  const [tab, setTab] = useState<Tab>('status');
  const [loading, setLoading] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Status tab state
  const [gitStatus, setGitStatus] = useState('');
  const [gitDiff, setGitDiff] = useState('');
  const [staged, setStaged] = useState(false);

  // Worktrees tab state
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [newBranch, setNewBranch] = useState('');
  const [creating, setCreating] = useState(false);

  // Branches tab state
  const [branches, setBranches] = useState<string[]>([]);

  const loadStatus = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getGitStatus(agent.id),
      api.getGitDiff(agent.id, staged),
    ])
      .then(([s, d]) => {
        setGitStatus(s.status);
        setGitDiff(d.diff);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agent.id, staged]);

  const loadWorktrees = useCallback(() => {
    setLoading(true);
    api.getWorktrees(agent.id)
      .then(setWorktrees)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agent.id]);

  const loadBranches = useCallback(() => {
    setLoading(true);
    api.getBranches(agent.id)
      .then(setBranches)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => {
    if (tab === 'status') loadStatus();
    else if (tab === 'worktrees') loadWorktrees();
    else if (tab === 'branches') loadBranches();
  }, [tab, loadStatus, loadWorktrees, loadBranches]);

  const handleCreateWorktree = async () => {
    if (!newBranch.trim()) return;
    setCreating(true);
    try {
      await api.createWorktree(agent.id, newBranch.trim());
      setNewBranch('');
      loadWorktrees();
    } catch {
      // error handled silently
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveWorktree = async (path: string) => {
    try {
      await api.removeWorktree(agent.id, path);
      loadWorktrees();
    } catch {
      // error handled silently
    }
  };

  const handleOpenWorktree = async (path: string) => {
    try {
      await api.openWorktree(agent.id, path);
    } catch {
      // error handled silently
    }
  };

  const tabClass = (t: Tab) =>
    `flex-1 h-9 px-3 text-[13px] font-semibold rounded-[7px] transition-colors ${
      tab === t
        ? 'bg-neon-500/[0.22] text-neon-50'
        : 'text-gray-400 hover:text-gray-200'
    }`;

  return createPortal(
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
    >
      <div className="glass-dark rounded-[22px] shadow-[0_30px_80px_rgba(0,0,0,0.6)] w-full max-w-3xl mx-2 md:mx-0 max-h-[95vh] md:max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-xl font-semibold text-gray-100 flex items-center gap-2">
              <svg className="w-5 h-5 text-neon-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
              </svg>
              Git
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">{agent.repoName || agent.name}{agent.branch ? ` (${agent.branch})` : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-[10px] border border-white/[0.16] text-gray-300 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mx-6 mt-4 p-1 rounded-[10px] bg-gl-code border border-white/[0.1]">
          <button onClick={() => setTab('status')} className={tabClass('status')}>Status</button>
          <button onClick={() => setTab('worktrees')} className={tabClass('worktrees')}>Worktrees</button>
          <button onClick={() => setTab('branches')} className={tabClass('branches')}>Branches</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 md:px-6 md:py-4 space-y-4">
          {loading && (
            <div className="text-sm text-gray-500 text-center py-4">Loading...</div>
          )}

          {/* Status Tab */}
          {tab === 'status' && !loading && (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400 uppercase tracking-[1.2px] font-semibold">Status</span>
                  <button onClick={loadStatus} className="text-xs text-gray-500 hover:text-neon-300 transition-colors">
                    Refresh
                  </button>
                </div>
                <pre className="text-xs text-gray-300 bg-gl-code border border-white/[0.1] rounded-[10px] p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                  {gitStatus || '(clean)'}
                </pre>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400 uppercase tracking-[1.2px] font-semibold">Diff</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setStaged(!staged)}
                      className={`text-xs px-2 py-0.5 rounded transition-colors ${
                        staged ? 'bg-green-900/60 text-green-400' : 'glass-input text-gray-400'
                      }`}
                    >
                      {staged ? 'Staged' : 'Unstaged'}
                    </button>
                  </div>
                </div>
                <pre className="text-xs text-gray-300 bg-gl-code border border-white/[0.1] rounded-[10px] p-3 overflow-x-auto font-mono whitespace-pre-wrap max-h-80">
                  {gitDiff || '(no changes)'}
                </pre>
              </div>
            </>
          )}

          {/* Worktrees Tab */}
          {tab === 'worktrees' && !loading && (
            <>
              {worktrees.length === 0 && (
                <p className="text-sm text-gray-500 italic text-center py-4">No worktrees found</p>
              )}
              <div className="space-y-2">
                {worktrees.map((wt, i) => (
                  <div key={wt.path} className="glass-light rounded-lg p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-200 font-mono truncate">{wt.branch || '(detached)'}</span>
                        {i === 0 && (
                          <span className="text-[13px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400">main</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5" title={wt.path}>{wt.path}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleOpenWorktree(wt.path)}
                        className="text-xs px-2.5 py-1 btn-ghost rounded-[9px] transition-colors"
                        title="Open in VS Code"
                      >
                        Open
                      </button>
                      {i > 0 && (
                        <button
                          onClick={() => handleRemoveWorktree(wt.path)}
                          className="text-xs px-2 py-1 text-gray-500 hover:text-red-400 transition-colors"
                          title="Remove worktree"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Create worktree form */}
              <div className="glass-light rounded-lg p-3">
                <span className="text-xs text-gray-400 uppercase tracking-[1.2px] font-semibold">Create Worktree</span>
                <div className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="Branch name..."
                    className="flex-1 glass-input text-sm text-gray-200 rounded-md px-3 py-1.5 focus:outline-none placeholder-gray-600"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateWorktree(); }}
                  />
                  <button
                    onClick={handleCreateWorktree}
                    disabled={!newBranch.trim() || creating}
                    className="text-sm px-3 py-1.5 btn-primary font-semibold rounded-[10px] disabled:opacity-30 transition-opacity"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Branches Tab */}
          {tab === 'branches' && !loading && (
            <>
              {branches.length === 0 && (
                <p className="text-sm text-gray-500 italic text-center py-4">No branches found</p>
              )}
              <div className="space-y-1">
                {branches.map((b) => (
                  <div key={b} className="flex items-center gap-2 px-3 py-1.5 rounded hover:bg-white/[0.06] transition-colors">
                    <svg className="w-3.5 h-3.5 text-gray-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                    </svg>
                    <span className={`text-sm font-mono ${b === agent.branch ? 'text-neon-400 font-semibold' : 'text-gray-400'}`}>
                      {b}
                    </span>
                    {b === agent.branch && (
                      <span className="text-[13px] px-1.5 py-0.5 rounded bg-neon-500/20 text-neon-200">current</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
