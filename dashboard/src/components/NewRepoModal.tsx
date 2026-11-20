import { SELECTABLE_ENGINES, ENGINE_NAME } from '@neoncore/client';
import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useEscapeKey } from '../hooks/useEscapeKey';

// The tool to launch in the new folder. Values map to open-directory.ts relay-terminal
// launchers, which self-register a cartridge so it shows up in the grid immediately.
// The selectable engines (SELECTABLE_ENGINES).
const TOOLS: { value: string; label: string }[] = SELECTABLE_ENGINES.map((e) => ({ value: `${e}-cli`, label: ENGINE_NAME[e] }));

interface Props {
  onClose: () => void;
}

export function NewRepoModal({ onClose }: Props) {
  useEscapeKey(onClose);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [launchAgent, setLaunchAgent] = useState(true);
  const [tool, setTool] = useState(TOOLS[0].value);

  // GitHub owner — which connected account the repo is created under.
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[]>([]);
  const [owner, setOwner] = useState('');

  // Folder browser state
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ path: string; repoUrl: string; launchError: string | null } | null>(null);

  const browse = useCallback((path?: string) => {
    api.browseDir(path)
      .then((r) => { setCurrent(r.current); setParent(r.parent); setDirs(r.dirs); })
      .catch(() => {});
  }, []);

  // Start at the configured projects dir if there is one, else the browser's default (home).
  useEffect(() => {
    api.getRepos()
      .then((r) => browse(r.projectsDirs[0]))
      .catch(() => browse());
  }, [browse]);

  // Load connected GitHub accounts; default the owner to the active one.
  useEffect(() => {
    api.getGithubAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        setOwner((r.accounts.find((a) => a.active) || r.accounts[0])?.login || '');
      })
      .catch(() => {});
  }, []);

  const nameValid = /^[A-Za-z0-9._-]+$/.test(name);

  const handleCreate = async () => {
    if (!nameValid || !current || !owner) return;
    setCreating(true);
    setError('');
    try {
      const res = await api.createRepo({
        name,
        parentDir: current,
        description: description.trim() || undefined,
        isPrivate,
        agentType: launchAgent ? tool : 'none',
        owner,
      });
      setResult({ path: res.path, repoUrl: res.repoUrl, launchError: res.launchError });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="glass-dark rounded-[22px] shadow-[0_30px_80px_rgba(0,0,0,0.6)] w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-1">
          <h2 className="font-display text-xl font-semibold text-gray-100">New Repo</h2>
          <button onClick={onClose} className="w-10 h-10 rounded-[10px] border border-white/[0.16] flex items-center justify-center text-gray-300 hover:text-white transition-colors" title="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {result ? (
          /* ── Success ── */
          <div className="px-6 pb-6 pt-3 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <span className="w-2 h-2 bg-emerald-400 rounded-full" />
              Repo created and pushed
            </div>
            <div className="text-xs text-gray-400 font-mono break-all">{result.path}</div>
            <a
              href={result.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm text-neon-400 hover:text-neon-200 underline break-all"
            >
              {result.repoUrl}
            </a>
            {launchAgent && (
              result.launchError ? (
                <p className="text-xs text-amber-400">
                  Repo is ready, but the agent didn't launch: {result.launchError}
                </p>
              ) : (
                <p className="text-xs text-gray-500">
                  Launching the agent — the cartridge will appear in the grid shortly.
                </p>
              )
            )}
            <div className="flex justify-end pt-1">
              <button
                onClick={onClose}
                className="text-sm px-3.5 py-1.5 text-white rounded-[10px] btn-primary font-semibold transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* ── Form ── */
          <div className="px-6 pb-6 pt-3 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-[13px] text-gray-400 mb-1.5">Repo name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nameValid) handleCreate(); }}
                placeholder="my-quick-example"
                className="w-full glass-input text-gray-100 text-sm rounded-[10px] px-3 py-2.5 focus:outline-none placeholder-gray-600"
              />
              {name && !nameValid && (
                <p className="text-[11px] text-red-400 mt-1">
                  Only letters, numbers, dots, dashes, and underscores.
                </p>
              )}
              <p className="text-[11px] text-gray-500 mt-1">
                Will be created as <span className="text-gray-400 font-mono">{owner || 'account'}/{name || 'name'}</span> on GitHub.
              </p>
            </div>

            {/* GitHub account (owner) */}
            <div>
              <label className="block text-[13px] text-gray-400 mb-1.5">GitHub account</label>
              {accounts.length === 0 ? (
                <p className="text-[11px] text-gray-500">No connected accounts found (is the gh CLI logged in?).</p>
              ) : (
                <div className="flex gap-1 p-1 rounded-[10px] bg-gl-code border border-white/[0.12] w-fit max-w-full flex-wrap">
                  {accounts.map((a) => (
                    <button
                      key={a.login}
                      onClick={() => setOwner(a.login)}
                      className={`h-9 px-3 rounded-[8px] text-[13px] font-semibold transition-colors ${owner === a.login ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                      {a.login}{a.active && <span className="text-emerald-400/70"> ·active</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="block text-[13px] text-gray-400 mb-1.5">Description <span className="text-gray-500">(optional)</span></label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A quick example for…"
                className="w-full glass-input text-gray-100 text-sm rounded-[10px] px-3 py-2.5 focus:outline-none placeholder-gray-600"
              />
            </div>

            {/* Folder browser */}
            <div>
              <label className="block text-[13px] text-gray-400 mb-1.5">Create in</label>
              <div className="rounded-[10px] border border-white/[0.12] bg-gl-code">
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/[0.08]">
                  <button
                    onClick={() => parent && browse(parent)}
                    disabled={!parent}
                    className="text-gray-400 hover:text-white disabled:opacity-30 text-xs px-1"
                    title="Up one level"
                  >
                    ↑
                  </button>
                  <span className="text-[11px] text-gray-400 font-mono truncate flex-1" title={current}>{current || '…'}</span>
                </div>
                <div className="max-h-32 overflow-y-auto">
                  {dirs.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-gray-500">No subfolders here</div>
                  ) : (
                    dirs.map((d) => (
                      <button
                        key={d}
                        onClick={() => browse(`${current}/${d}`)}
                        className="w-full text-left px-3 py-1.5 text-[13px] text-gray-300 hover:bg-white/[0.05] transition-colors font-mono truncate"
                      >
                        {d}/
                      </button>
                    ))
                  )}
                </div>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                New folder: <span className="text-gray-400 font-mono">{current}/{name || 'name'}</span>
              </p>
            </div>

            {/* Visibility */}
            <div className="flex items-center gap-2">
              <label className="text-[13px] text-gray-400">Visibility</label>
              <div className="flex gap-1 p-1 rounded-[10px] bg-gl-code border border-white/[0.12]">
                <button
                  onClick={() => setIsPrivate(true)}
                  className={`h-9 px-4 rounded-[8px] text-[13px] font-semibold transition-colors ${isPrivate ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'}`}
                >
                  Private
                </button>
                <button
                  onClick={() => setIsPrivate(false)}
                  className={`h-9 px-4 rounded-[8px] text-[13px] font-semibold transition-colors ${!isPrivate ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'}`}
                >
                  Public
                </button>
              </div>
            </div>

            {/* Launch agent */}
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                <input type="checkbox" checked={launchAgent} onChange={(e) => setLaunchAgent(e.target.checked)} />
                Launch agent after create
              </label>
              {launchAgent && (
                <div className="flex gap-1 p-1 rounded-[10px] bg-gl-code border border-white/[0.12]">
                  {TOOLS.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setTool(t.value)}
                      className={`h-9 px-4 rounded-[8px] text-[13px] font-semibold transition-colors ${tool === t.value ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="btn-ghost h-11 text-sm font-semibold px-4 rounded-[10px] transition-colors">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !nameValid || !current || !owner}
                className="h-11 text-sm font-semibold px-5 rounded-[10px] btn-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? 'Creating…' : 'Create & Push'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
