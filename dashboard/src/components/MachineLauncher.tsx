import { SELECTABLE_ENGINES, ENGINE_NAME } from '@neoncore/client';
import { useState, useEffect, useRef, useMemo } from 'react';
import type { ServerEntry } from '../types';
import { filterMachinesByRepo, countRepos } from '@neoncore/client';
import { useFleetMachines, type FleetMachine } from '../hooks/useFleetMachines';

interface Props {
  /** The fleet roster. Empty/omitted = just the server that served this page. */
  servers?: ServerEntry[];
}

// Agent types the remote runner can launch (it spawns the relay, which defaults to claude):
// the selectable engines (SELECTABLE_ENGINES).
const ENGINE_COLOR: Record<string, string> = {
  claude: 'border border-[#7CC4FF] bg-[#7CC4FF]/[0.14] text-[#DCEFFF]',
  codex: 'border border-gl-teal bg-gl-teal/[0.12] text-[#C9FBF6]',
};
const AGENT_TYPES: { key: string; label: string; color: string }[] = SELECTABLE_ENGINES.map((key) => ({
  key, label: ENGINE_NAME[key], color: ENGINE_COLOR[key],
}));

const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * Launch a cartridge on any registered machine (local host or remote) running the runner
 * daemon. Repos come from each machine's allowlist and the launch is dispatched to that
 * machine's runner. Also supports editing a machine's exposed folders inline.
 */
export function MachineLauncher({ servers = [] }: Props) {
  const [open, setOpen] = useState(false);
  // Polled only while the menu is open; launches go back to the server that owns the machine.
  const { machines, loading, clientFor } = useFleetMachines(servers, open);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null); // `${machineId}:${path}`
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const onlineCount = machines.filter((m) => m.status === 'online').length;

  // The rows to render. Narrowed by repo/path/hostname; never flattened, so every hit still
  // arrives under the machine it lives on — which is the choice the user is actually making.
  const visible = useMemo(() => filterMachinesByRepo(machines, query), [machines, query]);
  const shownRepos = countRepos(visible);
  const totalRepos = countRepos(machines);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedRepo(null);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Resume is the default: clicking an engine picks up that repo's last real session. This is
  // the opt-out, and it is per-expanded-repo rather than global so choosing "fresh" for one
  // project cannot silently apply to the next one you open.
  const [freshRepo, setFreshRepo] = useState<string | null>(null);

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setNotice({ kind, msg });
    setTimeout(() => setNotice(null), 5000);
  };

  const launch = async (
    machine: FleetMachine, repoPath: string, repoName: string, agentType: string, fresh: boolean,
  ) => {
    setOpen(false);
    setExpandedRepo(null);
    try {
      const r = await clientFor(machine.origin)
        .launchOnMachine(machine.id, repoPath, agentType, undefined, fresh ? { fresh: true } : undefined);
      // SAY WHICH ONE. "Launching…" is ambiguous once resume is the default, and finding out
      // your context did not come with you by reading the terminal is the wrong way to learn it.
      const how = r?.resumed ? `resuming session ${String(r.resumed).slice(0, 8)}…` : 'fresh session';
      flash('ok', `Launching ${agentType} in ${repoName} on ${machine.hostname} — ${how}`);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Launch failed');
    }
  };

  // Push a new folder list to the machine's runner. It validates against its own disk, so
  // an added path that doesn't exist there is silently dropped; the list refreshes via the
  // machine_updated socket event.
  const setRepos = async (m: FleetMachine, repos: { path: string; name?: string }[]) => {
    try {
      await clientFor(m.origin).setMachineRepos(m.id, repos);
      flash('ok', 'Updated exposed folders');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Update failed');
    }
  };
  const removeRepo = (m: FleetMachine, path: string) =>
    setRepos(m, m.repos.filter((r) => r.path !== path).map((r) => ({ path: r.path, name: r.name })));
  const addRepo = (m: FleetMachine) => {
    const p = newPath.trim();
    if (!p) return;
    setNewPath('');
    setRepos(m, [...m.repos.map((r) => ({ path: r.path, name: r.name })), { path: p }]);
  };
  // Treat the input as a parent folder: the runner adds every git repo under it (on its disk).
  const scanFolder = async (m: FleetMachine) => {
    const root = newPath.trim();
    if (!root) return;
    setNewPath('');
    try {
      await clientFor(m.origin).scanMachineFolder(m.id, root);
      flash('ok', `Scanning ${root} on ${m.hostname}…`);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Scan failed');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setExpandedRepo(null); setQuery(''); }}
        className="btn-primary h-10 px-4 rounded-[10px] text-sm font-semibold transition-colors flex items-center gap-2 whitespace-nowrap"
        title="Launch a cartridge on a registered machine"
      >
        + Launch
        {onlineCount > 0 && (
          <span className="text-[11px] px-1.5 rounded-full bg-neon-500 text-ink">{onlineCount}</span>
        )}
      </button>

      {/* `break-words` below is load-bearing, not cosmetic. `max-w-xs` caps the BOX and the
          background is painted on the box, so any token too wide to wrap overflows the content
          area and the text paints OUTSIDE its own bubble — reported as "the green background is
          smaller than the message".
          Measured in-browser across all six messages flash() produces, because the trigger is
          narrower than it looks: the hostname is fine (hyphens break) and so is a short path
          (Chrome breaks after "/"). What overflows is a LONG path — `Scanning
          /Users/…/Git/neoncore/server/node_modules on <host>…` ran 91px past its background —
          and a raw API error carrying an unbroken path, which ran 243px past. */}
      {notice && (
        <div className={`absolute right-0 top-full mt-1.5 z-50 text-xs rounded-lg px-3 py-2 max-w-xs break-words border ${
          notice.kind === 'ok'
            ? 'bg-emerald-900/90 border-emerald-700 text-emerald-200'
            : 'bg-red-900/90 border-red-700 text-red-300'
        }`}>
          {notice.msg}
        </div>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 glass-dark border-neon-500/35 rounded-[20px] shadow-[0_30px_80px_rgba(0,0,0,0.55)] py-3 w-[380px] max-h-[520px] overflow-y-auto">
          {/* Only when there is nothing to show. A refresh must never replace live content
              with a spinner — TokensPage's `loading && !points.length` is the same rule. */}
          {loading && machines.length === 0 ? (
            <div className="text-xs text-gray-500 px-3 py-2">Loading…</div>
          ) : machines.length === 0 ? (
            <div className="text-xs text-gray-500 px-3 py-2 leading-relaxed">
              No machines registered. Run the <span className="text-gray-300">runner</span> daemon
              on a computer (see <span className="text-gray-300">agent/runner</span>) to launch there.
            </div>
          ) : (
            <>
              {/* Search stays above the list and out of the scroll, so it is still reachable
                  after scrolling a long fleet. It narrows folders, never machines-as-headings:
                  a hit is only useful with the box it is on attached. */}
              <div className="px-4 pb-2.5 pt-1 sticky top-0 z-10 bg-[#0A1020]">
                <div className="flex items-center gap-1.5">
                  <input
                    data-testid="repo-search"
                    value={query}
                    autoFocus
                    onChange={(e) => { setQuery(e.target.value); setExpandedRepo(null); }}
                    onKeyDown={(e) => {
                      // The dropdown listens for keys outside; a search box that closes the
                      // panel on Escape mid-word would be unusable.
                      e.stopPropagation();
                      if (e.key === 'Escape') setQuery('');
                    }}
                    placeholder="Search repos or machines…"
                    className="flex-1 h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 placeholder-gray-500 focus:outline-none"
                  />
                  {query && (
                    <button
                      onClick={() => { setQuery(''); setExpandedRepo(null); }}
                      className="text-[11px] text-gray-500 hover:text-gray-300 px-1 transition-colors"
                      title="Clear search"
                    >×</button>
                  )}
                </div>
                {query && (
                  <div className="text-xs text-gray-500 pt-1.5">
                    {shownRepos} of {totalRepos} folder{totalRepos === 1 ? '' : 's'}
                  </div>
                )}
              </div>

              {visible.length === 0 ? (
                /* A blank panel reads as "the launcher broke". Name the query back. */
                <div className="text-xs text-gray-500 px-3 py-2 leading-relaxed">
                  No repos match “<span className="text-gray-300">{query}</span>”.
                  <div className="text-gray-600 text-[11px] pt-0.5">
                    Search covers folder names, their paths, and machine names.
                  </div>
                </div>
              ) : (
              visible.map((m) => {
              const editing = editingId === m.id;
              // Administration must never see a filtered list. "Edit folders" on a searched
              // machine has to show everything it holds, or removing one folder while the
              // others are hidden reads as "the rest are gone" — and the offline row's folder
              // count has to be what is REGISTERED, not what happens to match.
              const full = machines.find((x) => x.origin === m.origin && x.id === m.id) || m;
              return (
              <div key={`${m.origin}:${m.id}`} className="px-1 pb-2 mb-1 last:mb-0 last:pb-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.status === 'online' ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                  <span className="text-xs uppercase tracking-[1.2px] text-gray-400 font-medium flex-1 truncate">{m.hostname || m.id.slice(0, 8)}</span>
                  {m.status === 'online' && (
                    <button
                      onClick={() => { setEditingId(editing ? null : m.id); setExpandedRepo(null); setNewPath(''); }}
                      className="text-[10px] text-gray-500 hover:text-violet-300 transition-colors"
                    >
                      {editing ? 'Done' : 'Edit folders'}
                    </button>
                  )}
                  <span className="text-[10px] text-gray-500">{OS_LABEL[m.platform] || m.platform}</span>
                </div>

                {m.status !== 'online' ? (
                  /*
                   * An offline machine used to render the bare word "Offline" and nothing
                   * else — no folder count, no cause, no remedy. That is how a perfectly
                   * good install reads as a broken one: the folders ARE registered and
                   * safe, but with the row silent about them they look lost, and the only
                   * conclusion available is "my repos are gone".
                   *
                   * A runner that is merely disconnected is recoverable, so say that, say
                   * what is still being held, and say how to get it back.
                   */
                  <div className="text-[11px] px-3 pb-1.5 pl-7 space-y-0.5">
                    <div className="text-gray-500">
                      Runner not connected
                      {full.repos.length > 0 && (
                        <> — {full.repos.length} folder{full.repos.length === 1 ? '' : 's'} still registered</>
                      )}
                    </div>
                    {/* While searching, NAME the folders that matched. The count alone answers
                        "something here matched" and withholds which — and the whole point of the
                        search is to find where a repo lives. They stay plain text, not buttons:
                        the runner is down, so there is nothing to launch yet. */}
                    {query && (
                      <div className="pt-0.5 space-y-0.5">
                        {m.repos.map((repo) => (
                          <div key={repo.path} className="text-gray-400 truncate" title={repo.path}>
                            {repo.name}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="text-gray-600">
                      Start the runner on {m.hostname || 'that machine'} to launch here.
                    </div>
                  </div>
                ) : editing ? (
                  <div className="px-3 pb-2 pl-7 space-y-1">
                    {full.repos.length === 0 && <div className="text-[11px] text-gray-600">No folders yet — add one below.</div>}
                    {full.repos.map((repo) => (
                      <div key={repo.path} className="flex items-center gap-2 text-xs text-gray-300">
                        <span className="flex-1 truncate" title={repo.path}>{repo.name}</span>
                        <button
                          onClick={() => removeRepo(m, repo.path)}
                          className="text-gray-600 hover:text-red-400 transition-colors px-1"
                          title={`Remove ${repo.path}`}
                        >×</button>
                      </div>
                    ))}
                    <div className="flex items-center gap-1 pt-1">
                      <input
                        value={newPath}
                        onChange={(e) => setNewPath(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addRepo(m); }}
                        placeholder={m.platform === 'win32' ? 'C:\\code\\project' : '/path/to/project'}
                        className="flex-1 h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 placeholder-gray-500 focus:outline-none"
                      />
                      <button
                        onClick={() => addRepo(m)}
                        className="btn-primary text-xs px-3 h-9 rounded-[9px] font-semibold transition-colors"
                        title="Add this exact folder"
                      >Add</button>
                      <button
                        onClick={() => scanFolder(m)}
                        className="btn-ghost text-xs px-3 h-9 rounded-[9px] font-semibold transition-colors"
                        title="Add every git repo under this folder"
                      >Scan</button>
                    </div>
                    <div className="text-[10px] text-gray-600 pt-0.5">
                      <b>Add</b> = this exact folder. <b>Scan</b> = every git repo under it. Paths are on that machine; missing ones are ignored.
                    </div>
                  </div>
                ) : m.repos.length === 0 ? (
                  <div className="text-[11px] text-gray-600 px-3 pb-1 pl-7">No folders — click “Edit folders”.</div>
                ) : (
                  m.repos.map((repo) => {
                    const rid = `${m.id}:${repo.path}`;
                    return (
                      <div key={rid}>
                        <button
                          onClick={() => setExpandedRepo(expandedRepo === rid ? null : rid)}
                          className="w-full text-left text-sm font-mono text-gray-300 hover:bg-white/[0.04] hover:text-white px-3 py-2.5 rounded-[10px] transition-colors flex items-center gap-2"
                        >
                          <span className="flex-1 truncate">{repo.name}</span>
                          <span className={`text-gray-600 text-[13px] transition-transform ${expandedRepo === rid ? 'rotate-90' : ''}`}>▶</span>
                        </button>
                        {expandedRepo === rid && (
                          <div className="mx-1 mb-2 p-3 rounded-xl bg-neon-500/[0.08] border border-neon-500/35">
                            <div className="flex gap-1.5">
                              {AGENT_TYPES.map((t) => (
                                <button
                                  key={t.key}
                                  onClick={() => launch(m, repo.path, repo.name, t.key, freshRepo === rid)}
                                  className={`flex-1 h-10 text-[13px] font-semibold px-2 rounded-[9px] hover:brightness-125 transition ${t.color}`}
                                >
                                  {t.label}
                                </button>
                              ))}
                            </div>
                            <label className="mt-2.5 flex items-center gap-2 text-[13px] text-gray-300 hover:text-gray-100 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={freshRepo === rid}
                                onChange={(e) => setFreshRepo(e.target.checked ? rid : null)}
                                className="accent-[#5AAEFF]"
                              />
                              Start fresh session (don&apos;t resume)
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              );
            })
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
