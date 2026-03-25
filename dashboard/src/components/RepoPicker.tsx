import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { AgentType } from '../types';

interface Repo {
  name: string;
  path: string;
  source: string;
}

export function RepoPicker() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
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

  // Fetch repos when dropdown opens + auto-refresh every 30s while open
  useEffect(() => {
    if (!open) return;
    const fetch = () => {
      setLoading((prev) => repos.length === 0 ? true : prev);
      api.getRepos()
        .then(({ repos }) => setRepos(repos))
        .catch(() => setRepos([]))
        .finally(() => setLoading(false));
    };
    fetch();
    const interval = setInterval(fetch, 30000);
    return () => clearInterval(interval);
  }, [open]);

  const handleOpen = async (repoPath: string, agentType: AgentType) => {
    setOpen(false);
    setSelectedRepo(null);
    try {
      await api.openRepo(repoPath, agentType);
    } catch {
      // ignore
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
                  <span className={`text-gray-600 text-[10px] transition-transform ${selectedRepo === repo.path ? 'rotate-90' : ''}`}>▶</span>
                </button>
                {selectedRepo === repo.path && (
                  <div className="flex gap-1 px-3 pb-1.5 pl-7">
                    <button
                      onClick={() => handleOpen(repo.path, 'gridlight')}
                      className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-gl-purple hover:text-purple-300 transition-colors"
                    >
                      Gridlight
                    </button>
                    <button
                      onClick={() => handleOpen(repo.path, 'claude')}
                      className="text-[10px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Claude
                    </button>
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
