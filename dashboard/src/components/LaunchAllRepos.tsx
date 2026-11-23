import { useState, useMemo } from 'react';
import { SELECTABLE_ENGINES, ENGINE_NAME, planProjectLaunch, sameRepoPath } from '@neoncore/client';
import { useFleetMachines } from '../hooks/useFleetMachines';
import type { Agent, ServerEntry } from '../types';

type RowResult = { kind: 'ok' | 'err'; msg: string };

/**
 * Launch a cartridge in every repo the project owns — the same launch "+ Launch" makes, once per
 * repo, in order: same machine allowlist, same server routing, resume-by-default. Nothing here is
 * a batch endpoint, so a launch from this panel and a launch from the menu can never differ.
 *
 * A repo that already has a live cartridge starts UNticked: launching one by one you would skip
 * it, and a second cartridge in the same folder is two agents editing the same files.
 */
export function LaunchAllRepos({ repos, agents, servers, onClose }: {
  repos: string[];
  agents: Agent[];
  servers: ServerEntry[];
  onClose: () => void;
}) {
  const { machines, loading, clientFor } = useFleetMachines(servers, true);
  const plan = useMemo(() => planProjectLaunch(repos, machines), [repos, machines]);
  const live = (repo: string) => agents.some((a) => a.status !== 'offline' && sameRepoPath(a.repoPath, repo));

  const [engine, setEngine] = useState<string>(SELECTABLE_ENGINES[0]);
  const [fresh, setFresh] = useState(false);
  // Per-repo overrides only; anything untouched follows the defaults, which stay right as
  // machines come online mid-way through the panel being open.
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [machineFor, setMachineFor] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [running, setRunning] = useState(false);

  const isPicked = (repo: string, launchable: boolean) => launchable && (picked[repo] ?? !live(repo));
  const targetFor = (p: (typeof plan)[number]) =>
    p.targets.find((t) => t.machine.id === machineFor[p.repoPath]) ?? p.targets[0];
  const chosen = plan.filter((p) => isPicked(p.repoPath, p.targets.length > 0));

  async function launchAll() {
    setRunning(true);
    setResults({});
    // Sequential on purpose: "as if one by one". A burst of parallel dispatches opens every
    // terminal at once on the target machine and makes a failure harder to pin to its repo.
    for (const p of chosen) {
      const t = targetFor(p);
      try {
        const r = await clientFor(t.machine.origin)
          .launchOnMachine(t.machine.id, t.path, engine, undefined, fresh ? { fresh: true } : undefined);
        const how = r?.resumed ? `resuming ${String(r.resumed).slice(0, 8)}…` : 'fresh session';
        setResults((prev) => ({ ...prev, [p.repoPath]: { kind: 'ok', msg: `on ${t.machine.hostname} — ${how}` } }));
      } catch (e) {
        setResults((prev) => ({ ...prev, [p.repoPath]: { kind: 'err', msg: e instanceof Error ? e.message : 'Launch failed' } }));
      }
    }
    setRunning(false);
  }

  const finished = !running && Object.keys(results).length > 0;

  return (
    <div className="space-y-3" data-launch-all>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-gray-500 uppercase tracking-[0.12em]">Engine</span>
        {SELECTABLE_ENGINES.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setEngine(key)}
            className={`text-[12px] px-2.5 py-1 rounded-full border transition-colors ${
              engine === key ? 'border-neon-500/60 bg-neon-500/[0.12] text-neon-200' : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
            }`}
          >{ENGINE_NAME[key]}</button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
          Start fresh (don't resume)
        </label>
      </div>

      {loading && machines.length === 0 ? (
        <p className="text-[13px] text-gray-500">Looking for machines…</p>
      ) : (
        <div className="space-y-1.5">
          {plan.map((p) => {
            const launchable = p.targets.length > 0;
            const on = isPicked(p.repoPath, launchable);
            const res = results[p.repoPath];
            return (
              <div key={p.repoPath} data-repo={p.repoPath}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${launchable ? 'border-white/[0.08]' : 'border-white/[0.04] opacity-60'}`}>
                <input
                  type="checkbox"
                  aria-label={`Launch ${p.name}`}
                  checked={on}
                  disabled={!launchable || running}
                  onChange={(e) => setPicked((prev) => ({ ...prev, [p.repoPath]: e.target.checked }))}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-mono text-gray-200 truncate" title={p.repoPath}>
                    {p.name}
                    {live(p.repoPath) && <span className="ml-2 text-[11px] font-sans text-emerald-300">already running</span>}
                  </div>
                  {res ? (
                    <div className={`text-[12px] ${res.kind === 'ok' ? 'text-emerald-300' : 'text-red-400'}`}>{res.msg}</div>
                  ) : !launchable ? (
                    <div className="text-[12px] text-gray-500">Not exposed on any online machine — add it in + Launch › Edit folders.</div>
                  ) : null}
                </div>
                {launchable && p.targets.length === 1 && (
                  <span className="text-[12px] text-gray-500 shrink-0">{p.targets[0].machine.hostname}</span>
                )}
                {p.targets.length > 1 && (
                  <select
                    aria-label={`Machine for ${p.name}`}
                    value={targetFor(p).machine.id}
                    disabled={running}
                    onChange={(e) => setMachineFor((prev) => ({ ...prev, [p.repoPath]: e.target.value }))}
                    className="glass-input rounded-[8px] px-2 py-1 text-[12px] text-gray-200 focus:outline-none shrink-0"
                  >
                    {p.targets.map((t) => <option key={t.machine.id} value={t.machine.id}>{t.machine.hostname}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {finished ? (
          <button onClick={onClose} className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold">Done</button>
        ) : (
          <button
            onClick={() => void launchAll()}
            disabled={chosen.length === 0 || running}
            className="h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running ? 'Launching…' : `Launch ${chosen.length} repo${chosen.length === 1 ? '' : 's'}`}
          </button>
        )}
        {!finished && (
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
        )}
      </div>
    </div>
  );
}
