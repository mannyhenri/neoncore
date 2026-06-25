import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';

interface Repo {
  name: string;
  path: string;
  source: string;
}

interface ToolInfo {
  label: string;
  installed: boolean;
  cliInstalled: boolean;
  hooksExist: boolean;
  configFile: string;
  cliPath: string | null;
  npmPkg: string | null;
  authCmd: string | null;
}

// Display config for each tool button
const TOOL_DISPLAY: Record<string, { label: string; color: string }> = {
  'claude-terminal': { label: 'Claude · Terminal', color: 'text-blue-400 hover:text-blue-300' },
  claude:  { label: 'Claude · VS Code', color: 'text-blue-400 hover:text-blue-300' },
  gridlight:{ label: 'Gridlight', color: 'text-gl-purple hover:text-purple-300' },
  gemini:  { label: 'Gemini',    color: 'text-teal-400 hover:text-teal-300' },
  amazonq: { label: 'Amazon Q',  color: 'text-orange-400 hover:text-orange-300' },
  codex:   { label: 'Codex',     color: 'text-green-400 hover:text-green-300' },
  cursor:  { label: 'Cursor',    color: 'text-violet-400 hover:text-violet-300' },
};

// Tools always shown regardless of install state
const ALWAYS_SHOW = new Set(['claude-terminal', 'claude', 'gridlight']);

// Preferred display order — terminal Claude first (no VS Code required)
const TOOL_ORDER = ['claude-terminal', 'gridlight', 'claude', 'gemini', 'amazonq', 'codex', 'cursor'];

export function RepoPicker() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [toolsStatus, setToolsStatus] = useState<Record<string, ToolInfo>>({});
  const [launchError, setLaunchError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSelectedRepo(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Fetch repos + tool status when dropdown opens
  useEffect(() => {
    if (!open) return;

    const fetchAll = () => {
      setLoading((prev) => repos.length === 0 ? true : prev);
      Promise.all([
        api.getRepos().then(({ repos }) => setRepos(repos)).catch(() => setRepos([])),
        api.getToolsStatus().then(setToolsStatus).catch(() => {}),
      ]).finally(() => setLoading(false));
    };

    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [open]);

  // Tools to show: always-shown + any tool with NeonCore hooks actually installed
  const visibleTools = TOOL_ORDER.filter((key) => {
    if (ALWAYS_SHOW.has(key)) return true;
    const info = toolsStatus[key];
    return info && info.installed;
  });

  const handleOpen = async (repoPath: string, agentType: string) => {
    setOpen(false);
    setSelectedRepo(null);
    setLaunchError(null);
    try {
      await api.openRepo(repoPath, agentType);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to launch';
      setLaunchError(msg);
      setTimeout(() => setLaunchError(null), 6000);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setSelectedRepo(null); }}
        className="text-sm text-gray-400 hover:text-white border border-white/10 hover:border-white/20 px-2.5 py-1 rounded-md transition-colors"
      >
        Cartridges
      </button>
      {launchError && (
        <div className="absolute right-0 top-full mt-1.5 z-50 bg-red-900/90 border border-red-700 text-red-300 text-xs rounded-lg px-3 py-2 max-w-xs">
          {launchError}
        </div>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 glass rounded-xl shadow-2xl py-1.5 min-w-[220px] max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="text-xs text-gray-500 px-3 py-2">Loading...</div>
          ) : repos.length === 0 ? (
            <div className="text-xs text-gray-500 px-3 py-2">
              No repos found. Set projects directory in Settings.
            </div>
          ) : (
            repos.map((repo) => (
              <div key={repo.path} className="relative">
                <button
                  onClick={() => setSelectedRepo(selectedRepo === repo.path ? null : repo.path)}
                  className="w-full text-left text-xs text-gray-300 hover:bg-white/5 hover:text-white px-3 py-1.5 transition-colors flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-gl-purple shrink-0" />
                  <span className="flex-1 truncate">{repo.name}</span>
                  <span className={`text-gray-600 text-[13px] transition-transform ${selectedRepo === repo.path ? 'rotate-90' : ''}`}>▶</span>
                </button>

                {selectedRepo === repo.path && (
                  <div className="flex flex-wrap gap-1 px-3 pb-1.5 pl-7">
                    {visibleTools.map((key) => {
                      const display = TOOL_DISPLAY[key];
                      if (!display) return null;
                      return (
                        <button
                          key={key}
                          onClick={() => handleOpen(repo.path, key)}
                          className={`text-[13px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors ${display.color}`}
                        >
                          {display.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
