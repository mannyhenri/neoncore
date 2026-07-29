import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface Props {
  onClose: () => void;
}

const TOOL_ORDER = ['claude', 'amazonq', 'codex', 'cursor'] as const;

const TOOL_META: Record<string, { color: string; badge: string }> = {
  claude: { color: 'blue', badge: 'Claude CC' },
  gemini: { color: 'teal', badge: 'Gemini CLI' },
  amazonq: { color: 'orange', badge: 'Amazon Q' },
  codex: { color: 'green', badge: 'Codex CLI' },
  cursor: { color: 'violet', badge: 'Cursor' },
};

const BADGE_STYLES: Record<string, string> = {
  blue: 'bg-blue-900/60 text-blue-300',
  teal: 'bg-teal-900/60 text-teal-300',
  orange: 'bg-orange-900/60 text-orange-300',
  green: 'bg-green-900/60 text-green-300',
  violet: 'bg-violet-900/60 text-violet-300',
};

type SettingsTab = 'projects' | 'tools' | 'github';

interface ToolStatus {
  label: string;
  installed: boolean;
  configFile: string;
  hooksExist: boolean;
  cliInstalled: boolean;
  cliPath: string | null;
  npmPkg: string | null;
  authCmd: string | null;
}

export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('projects');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedDirs, setSavedDirs] = useState<string[]>([]);
  const [toolsStatus, setToolsStatus] = useState<Record<string, ToolStatus>>({});
  const [toolsBusy, setToolsBusy] = useState<Set<string>>(new Set());
  const [toolsMsg, setToolsMsg] = useState<Record<string, { type: 'ok' | 'err'; text: string }>>({});
  const [ghAccounts, setGhAccounts] = useState<{ login: string; active: boolean }[]>([]);
  const [ghBusy, setGhBusy] = useState('');
  const [ghMsg, setGhMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const browse = useCallback((dirPath?: string) => {
    setLoading(true);
    setBrowseError('');
    api.browseDir(dirPath)
      .then(({ current, parent, dirs }) => {
        setCurrentPath(current);
        setParentPath(parent);
        setDirs(dirs);
      })
      // Swallowing this is what made the bare-path bug invisible: the server answered 400
      // and the folder list simply never changed, with nothing on screen to explain why.
      .catch((err) => {
        setBrowseError(
          `Could not open that folder${err instanceof Error && err.message ? ` — ${err.message}` : ''}`,
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.getSettings().then((settings) => {
      const raw = settings.projects_dir || '';
      let parsedDirs: string[] = [];
      if (raw.startsWith('[')) {
        try { parsedDirs = JSON.parse(raw); } catch { /* ignore */ }
      } else if (raw) {
        parsedDirs = [raw];
      }
      setSavedDirs(parsedDirs);
      browse(parsedDirs[0] || undefined);
    }).catch(() => {
      browse();
    });
  }, [browse]);

  useEffect(() => {
    if (tab !== 'tools') return;
    api.getToolsStatus().then(setToolsStatus).catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== 'github') return;
    api.getGithubAccounts().then((r) => setGhAccounts(r.accounts)).catch(() => setGhAccounts([]));
  }, [tab]);

  const handleSwitchAccount = async (login: string) => {
    setGhBusy(login);
    setGhMsg(null);
    try {
      const res = await api.switchGithubAccount(login);
      setGhAccounts(res.accounts);
      setGhMsg({ type: 'ok', text: `Now using ${login} in new terminals & agents. Commit identity updated to match.` });
    } catch (err) {
      setGhMsg({ type: 'err', text: err instanceof Error ? err.message : 'Switch failed' });
    } finally {
      setGhBusy('');
    }
  };

  const handleAddDir = async () => {
    if (savedDirs.includes(currentPath)) return;
    setSaving(true);
    try {
      const next = [...savedDirs, currentPath];
      await api.updateSettings({ projects_dir: JSON.stringify(next) });
      setSavedDirs(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveDir = async (dirToRemove: string) => {
    const next = savedDirs.filter((d) => d !== dirToRemove);
    await api.updateSettings({ projects_dir: JSON.stringify(next) });
    setSavedDirs(next);
  };

  const handleInstallTool = async (tool: string) => {
    setToolsBusy((prev) => new Set(prev).add(tool));
    setToolsMsg((prev) => { const next = { ...prev }; delete next[tool]; return next; });
    try {
      const res = await api.installTool(tool);
      setToolsMsg((prev) => ({ ...prev, [tool]: { type: 'ok', text: res.note } }));
      setToolsStatus(await api.getToolsStatus());
    } catch (err) {
      setToolsMsg((prev) => ({
        ...prev,
        [tool]: { type: 'err', text: err instanceof Error ? err.message : 'Install failed' },
      }));
    } finally {
      setToolsBusy((prev) => { const next = new Set(prev); next.delete(tool); return next; });
    }
  };

  const handleUninstallTool = async (tool: string) => {
    setToolsBusy((prev) => new Set(prev).add(tool));
    setToolsMsg((prev) => { const next = { ...prev }; delete next[tool]; return next; });
    try {
      await api.uninstallTool(tool);
      setToolsMsg((prev) => ({ ...prev, [tool]: { type: 'ok', text: 'Hooks removed' } }));
      setToolsStatus(await api.getToolsStatus());
    } catch (err) {
      setToolsMsg((prev) => ({
        ...prev,
        [tool]: { type: 'err', text: err instanceof Error ? err.message : 'Uninstall failed' },
      }));
    } finally {
      setToolsBusy((prev) => { const next = new Set(prev); next.delete(tool); return next; });
    }
  };

  const tabClass = (target: SettingsTab) =>
    `px-3 py-1.5 text-xs font-medium transition-colors rounded-md ${
      tab === target ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
    }`;
  const isAlreadyAdded = savedDirs.includes(currentPath);

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
    >
      <div className="glass rounded-xl md:rounded-2xl w-full max-w-lg mx-2 md:mx-0 flex flex-col shadow-2xl max-h-[85vh] md:max-h-[75vh]">
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-white">Settings</h2>
            <div className="flex gap-1">
              <button onClick={() => setTab('projects')} className={tabClass('projects')}>Projects</button>
              <button onClick={() => setTab('tools')} className={tabClass('tools')}>Tools</button>
              <button onClick={() => setTab('github')} className={tabClass('github')}>GitHub</button>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {tab === 'projects' ? (
          <>
            {savedDirs.length > 0 && (
              <div className="px-4 py-2.5 md:px-6 border-b border-white/[0.06] space-y-1">
                <span className="text-[13px] text-gray-500 uppercase tracking-wider">Watched Directories</span>
                {savedDirs.map((dir) => (
                  <div key={dir} className="flex items-center gap-2 group">
                    <span className="text-sm text-gray-300 font-mono truncate flex-1">{dir}</span>
                    <button onClick={() => handleRemoveDir(dir)} className="text-xs text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="px-4 py-2.5 md:px-6 border-b border-white/[0.06] flex items-center gap-2 text-sm">
              <button onClick={() => parentPath && browse(parentPath)} disabled={!parentPath} className="text-gray-400 hover:text-white disabled:opacity-30">
                ..
              </button>
              <span className="text-gray-500 font-mono truncate">{currentPath}</span>
            </div>

            {browseError && (
              <div className="mx-4 mt-2 md:mx-6 rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
                {browseError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-2 py-2 md:px-4">
              {loading ? (
                <div className="text-sm text-gray-500 text-center py-8">Loading...</div>
              ) : (
                <div className="space-y-0.5">
                  {dirs.map((dir) => (
                    <button
                      key={dir}
                      // `dirs` are bare NAMES. The server resolves whatever it is given with
                      // path.resolve(), which is relative to the SERVER's cwd — so sending
                      // "Documents" asked for <repo>/server/Documents, 400'd, and the click
                      // did nothing. Always send the absolute child of the folder on screen,
                      // the same way NewRepoModal and GoalsPage already do.
                      onClick={() => browse(`${currentPath}/${dir}`)}
                      className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded-md font-mono truncate"
                    >
                      {dir.split('/').pop() || dir}
                    </button>
                  ))}
                  {dirs.length === 0 && <div className="text-sm text-gray-500 text-center py-8">No subdirectories</div>}
                </div>
              )}
            </div>

            <div className="px-4 py-3 md:px-6 md:py-4 border-t border-white/[0.06] flex items-center gap-3">
              <button
                onClick={handleAddDir}
                disabled={saving || !currentPath || isAlreadyAdded}
                className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-colors"
              >
                {saving ? 'Saving...' : isAlreadyAdded ? 'Already Added' : 'Add This Directory'}
              </button>
              {saved && <span className="text-xs text-green-400">Added</span>}
            </div>
          </>
        ) : tab === 'tools' ? (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 space-y-3">
              {Object.keys(toolsStatus).length === 0 ? (
                <div className="text-sm text-gray-500 text-center py-6">Loading tool status...</div>
              ) : (
                TOOL_ORDER.map((key) => {
                  const info = toolsStatus[key];
                  if (!info) return null;
                  const busy = toolsBusy.has(key);
                  const msg = toolsMsg[key];
                  const { color, badge } = TOOL_META[key] ?? { color: 'blue', badge: key };
                  return (
                    <div key={key} className="glass-light rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`text-[11px] px-1.5 py-0.5 rounded ${BADGE_STYLES[color]}`}>{badge}</span>
                            <span className="text-sm font-medium text-gray-200">{info.label}</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            CLI {info.cliInstalled ? 'installed' : 'missing'} · hooks {info.hooksExist ? 'installed' : 'not installed'}
                          </div>
                          {info.cliPath && <div className="text-[11px] text-gray-600 font-mono truncate max-w-[320px]">{info.cliPath}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                          {info.hooksExist && (
                            <button onClick={() => handleUninstallTool(key)} disabled={busy} className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40">
                              Remove Hooks
                            </button>
                          )}
                          <button onClick={() => handleInstallTool(key)} disabled={busy} className="text-xs px-2 py-1 rounded bg-white/10 text-gray-200 hover:bg-white/15 disabled:opacity-40">
                            {busy ? 'Working...' : info.hooksExist ? 'Repair' : 'Install'}
                          </button>
                        </div>
                      </div>
                      {msg && <div className={`text-xs ${msg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</div>}
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 space-y-3">
              <p className="text-xs text-gray-500 leading-relaxed">
                Choose which GitHub account new terminals and launched agents use. NeonCore switches the
                active <span className="font-mono text-gray-400">gh</span> account in the background and aligns your
                git commit identity to match.
              </p>
              {ghAccounts.length === 0 ? (
                <div className="text-sm text-gray-500 text-center py-6">
                  No connected accounts. Log in with <span className="font-mono text-gray-400">gh auth login</span>.
                </div>
              ) : (
                ghAccounts.map((a) => (
                  <div key={a.login} className="glass-light rounded-lg p-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-gray-200 font-mono truncate">{a.login}</span>
                      {a.active && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300">active</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleSwitchAccount(a.login)}
                      disabled={a.active || ghBusy === a.login}
                      className="text-xs px-2.5 py-1 rounded bg-white/10 text-gray-200 hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {ghBusy === a.login ? 'Switching…' : a.active ? 'In use' : 'Use'}
                    </button>
                  </div>
                ))
              )}
              {ghMsg && (
                <div className={`text-xs ${ghMsg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{ghMsg.text}</div>
              )}
              <p className="text-[11px] text-gray-600 leading-relaxed pt-1">
                Note: repos with SSH remotes authenticate via your SSH key, which this doesn't change — this
                affects gh commands, HTTPS pushes, and commit author.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
