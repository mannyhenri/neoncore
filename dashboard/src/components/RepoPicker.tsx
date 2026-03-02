import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';

interface Repo {
  name: string;
  path: string;
}

export function RepoPicker() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Fetch repos when dropdown opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.getRepos()
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]))
      .finally(() => setLoading(false));
  }, [open]);

  const handleOpen = async (repoPath: string) => {
    setOpen(false);
    try {
      await api.openRepo(repoPath);
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
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
              <button
                key={repo.path}
                onClick={() => handleOpen(repo.path)}
                className="w-full text-left text-xs text-gray-300 hover:bg-white/5 hover:text-white px-3 py-1.5 transition-colors flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-gl-purple shrink-0" />
                {repo.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
