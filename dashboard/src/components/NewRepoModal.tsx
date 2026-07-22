import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

// The tool to launch in the new folder. Values map to open-directory.ts relay-terminal
// launchers, which self-register a cartridge so it shows up in the grid immediately.
const TOOLS: { value: string; label: string }[] = [
  { value: 'claude-cli', label: 'Claude' },
  { value: 'gridlight-cli', label: 'Gridlight' },
  { value: 'codex-cli', label: 'Codex' },
];

interface Props {
  onClose: () => void;
}

export function NewRepoModal({ onClose }: Props) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="glass rounded-lg border border-white/10 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
          <h2 className="font-pixel text-sm text-white tracking-wide">New Repo</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors" title="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {result ? (
          /* ── Success ── */
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <span className="w-2 h-2 bg-emerald-400 rounded-full" />
              Repo created and pushed
            </div>
            <div className="text-xs text-gray-400 font-mono break-all">{result.path}</div>
            <a
              href={result.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm text-gl-purple hover:text-white underline break-all"
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
                className="text-sm px-3.5 py-1.5 text-white rounded-md gl-gradient hover:opacity-90 transition-opacity"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* ── Form ── */
          <div className="p-4 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Repo name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nameValid) handleCreate(); }}
                placeholder="my-quick-example"
                className="w-full glass-input text-gray-200 text-sm rounded-md px-3 py-2 focus:outline-none placeholder-gray-600"
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
              <label className="block text-xs text-gray-400 mb-1">GitHub account</label>
              {accounts.length === 0 ? (
                <p className="text-[11px] text-gray-500">No connected accounts found (is the gh CLI logged in?).</p>
              ) : (
                <div className="flex rounded-md overflow-hidden border border-white/10 w-fit max-w-full flex-wrap">
                  {accounts.map((a) => (
                    <button
                      key={a.login}
                      onClick={() => setOwner(a.login)}
                      className={`px-3 py-1 text-xs transition-colors ${owner === a.login ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
                    >
                      {a.login}{a.active && <span className="text-emerald-400/70"> ·active</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Description <span className="text-gray-600">(optional)</span></label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A quick example for…"
                className="w-full glass-input text-gray-200 text-sm rounded-md px-3 py-2 focus:outline-none placeholder-gray-600"
              />
            </div>

            {/* Folder browser */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Create in</label>
              <div className="rounded-md border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/[0.06]">
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
                    <div className="px-3 py-2 text-[11px] text-gray-600">No subfolders here</div>
                  ) : (
                    dirs.map((d) => (
                      <button
                        key={d}
                        onClick={() => browse(`${current}/${d}`)}
                        className="w-full text-left px-3 py-1 text-xs text-gray-300 hover:bg-white/[0.05] transition-colors font-mono truncate"
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
              <label className="text-xs text-gray-400">Visibility</label>
              <div className="flex rounded-md overflow-hidden border border-white/10">
                <button
                  onClick={() => setIsPrivate(true)}
                  className={`px-3 py-1 text-xs transition-colors ${isPrivate ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
                >
                  Private
                </button>
                <button
                  onClick={() => setIsPrivate(false)}
                  className={`px-3 py-1 text-xs transition-colors ${!isPrivate ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
                >
                  Public
                </button>
              </div>
            </div>

            {/* Launch agent */}
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={launchAgent} onChange={(e) => setLaunchAgent(e.target.checked)} />
                Launch agent after create
              </label>
              {launchAgent && (
                <div className="flex rounded-md overflow-hidden border border-white/10">
                  {TOOLS.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setTool(t.value)}
                      className={`px-3 py-1 text-xs transition-colors ${tool === t.value ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="text-sm px-3 py-1.5 text-gray-400 hover:text-gray-200 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !nameValid || !current || !owner}
                className="text-sm px-3.5 py-1.5 text-white rounded-md gl-gradient hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
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
