/**
 * THE DESIGN SYSTEM, STEP 2 — the direction that was selected, finalized into a whole system, and
 * that system put into every repo of the project.
 *
 * Two things are shown here, both made by the server (lib/design-system-build.ts, -publish.ts):
 *   · THE SYSTEM — its visuals (the same reference page that lands in each repo, drawn in a frame
 *     that can run nothing), its version, and the files it is made of.
 *   · THE REPOS — every repo of the project, what each one has, and one button that writes the
 *     files there, commits only them, and pushes. Each repo answers for itself.
 *
 * Nothing is committed until the button is pressed: selecting a direction finalizes; it never
 * publishes on its own.
 */
import type { DesignFinalSystem, DesignPublished, DesignRepoResult } from '../types';

const btn = 'h-9 px-3.5 rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const stepLabel = 'text-[11px] font-bold tracking-[0.14em] uppercase text-neon-300';
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const repoName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };

/** What each file is for — said next to it, so the list reads as a kit and not as a dump. */
const FILE_PURPOSE: Record<string, string> = {
  'tokens.json': 'Every value, for tools and scripts',
  'tokens.css': 'The same values as CSS variables',
  'components.css': 'Buttons, inputs, cards, badges, tables, navigation',
  'index.html': 'The reference page: open it to see the system',
  'DESIGN-SYSTEM.md': 'The rules, for people and for agents',
};
export const RESULT_SAYS: Record<DesignRepoResult['status'], { label: string; tone: string }> = {
  pushed: { label: 'Committed and pushed', tone: 'text-emerald-300' },
  committed: { label: 'Committed here, not pushed', tone: 'text-amber-300' },
  unchanged: { label: 'Already up to date', tone: 'text-gray-300' },
  failed: { label: 'Not published', tone: 'text-ember-300' },
};

export function DesignSystemFinal({ projectName, system, published, repos, pending, needsServer, working, onPublish }: {
  projectName: string;
  system: DesignFinalSystem | null;
  published: DesignPublished | null;
  repos: string[];
  /** A direction is selected and the system for it is not made yet (or is being made). */
  pending: boolean;
  /** The server does not have step 2: nothing here can be done until it is rebuilt and restarted. */
  needsServer: boolean;
  working: '' | 'finalizing' | 'publishing';
  onPublish: () => void;
}) {
  if (needsServer) {
    return (
      <section data-final-system data-needs-server className="rounded-[16px] border border-white/[0.1] bg-gl-surface/40 p-5">
        <p className={stepLabel}>Step 2 · The design system</p>
        <p className="text-[14px] text-gray-300 mt-1.5 max-w-[760px] leading-relaxed">
          Finalizing the system and putting it in the repos is done by the server, and this server does not have it yet. Rebuild and restart it; your selection is kept.
        </p>
      </section>
    );
  }
  if (!system) {
    if (!pending) return null;
    return (
      <section data-final-system data-finalizing className="rounded-[16px] border border-white/[0.1] bg-gl-surface/40 p-5">
        <p className={stepLabel}>Step 2 · The design system</p>
        <p className="text-[14px] text-gray-300 mt-1.5">{working === 'finalizing' ? 'Finalizing the system from your direction…' : 'Not finalized yet.'}</p>
      </section>
    );
  }

  const results = new Map((published?.repos ?? []).map((r) => [r.repoPath, r]));
  const behind = !!published && published.version !== system.version;
  const reached = published && !behind ? published.repos.filter((r) => r.status === 'pushed' || r.status === 'unchanged').length : 0;
  const publishing = working === 'publishing';
  const count = `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;

  return (
    <section data-final-system data-version={system.version} className="rounded-[16px] border border-neon-500/40 bg-gl-surface/40 p-5 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className={stepLabel}>Step 2 · The design system</p>
          <h3 className="font-display text-[22px] font-semibold text-gray-100 mt-1">
            <span data-system-name>{system.name}</span> <span data-system-version className="text-neon-300">v{system.version}</span>
          </h3>
          <p className="text-[13px] text-gray-400 mt-1 max-w-[760px] leading-relaxed">
            The direction, worked out in full: colour scales, type, spacing, radius, shadow and the components built from them. This is what {projectName} is built with from here on.
            {working === 'finalizing' && <span data-refinalizing className="text-amber-300"> Finalizing your new direction…</span>}
          </p>
        </div>
        <p className="text-[12px] text-gray-500">Finalized {day(system.finalizedAt)}</p>
      </div>

      {/* the visuals: the reference page itself, exactly as it lands in each repo */}
      <div className="rounded-[12px] overflow-hidden border border-white/[0.12] bg-white">
        <iframe data-system-preview title={`${system.name} design system, version ${system.version}`} srcDoc={system.html} sandbox="" className="block w-full h-[640px] border-0" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-5">
        {/* the files */}
        <div data-system-files className="rounded-[12px] border border-white/[0.1] p-4">
          <p className="text-[12px] font-bold tracking-[0.1em] uppercase text-gray-300">What goes in each repo</p>
          <ul className="mt-2.5 space-y-2">
            {system.files.map((f) => {
              const name = f.path.split('/').pop() ?? f.path;
              return (
                <li key={f.path} data-system-file={f.path} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <code className="text-[13px] text-gray-100">{f.path}</code>
                    <span className="block text-[12px] text-gray-400">{FILE_PURPOSE[name] ?? ''}</span>
                  </span>
                  <span className="text-[12px] text-gray-500 shrink-0">{kb(f.bytes)}</span>
                </li>
              );
            })}
            <li className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <code className="text-[13px] text-gray-100">CLAUDE.md</code>
                <span className="block text-[12px] text-gray-400">A short block that tells agents to build with the system. Also in AGENTS.md where a repo has one. Nothing else in those files is touched.</span>
              </span>
            </li>
          </ul>
        </div>

        {/* the repos */}
        <div data-publish className="rounded-[12px] border border-white/[0.1] p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-[12px] font-bold tracking-[0.1em] uppercase text-gray-300">The project’s repos</p>
              <p data-publish-state className="text-[13px] text-gray-300 mt-1">
                {repos.length === 0 ? 'This project has no repos yet. Add one under Repos, then come back.'
                  : !published ? `Not in any repo yet.`
                    : behind ? `The repos have v${published.version}. v${system.version} is ready to go out.`
                      : `v${published.version} is in ${reached} of ${published.repos.length} ${published.repos.length === 1 ? 'repo' : 'repos'} · ${day(published.at)}`}
              </p>
            </div>
            <button data-publish-button onClick={onPublish} disabled={repos.length === 0 || working !== ''} className={`${btn} btn-primary h-11 px-5 text-[14px]`}>
              {publishing ? 'Committing and pushing…' : published && !behind ? `Publish again to ${count}` : `Commit & push v${system.version} to ${count}`}
            </button>
          </div>
          <ul className="mt-3 divide-y divide-white/[0.06]">
            {repos.map((p) => {
              const r = behind ? undefined : results.get(p);
              const says = r ? RESULT_SAYS[r.status] : null;
              return (
                <li key={p} data-repo={p} data-status={r?.status ?? 'none'} className="py-2.5 flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[14px] font-semibold text-gray-100">{repoName(p)}</span>
                    <span className="block text-[12px] text-gray-500 truncate" title={p}>{p}</span>
                    {r && r.status !== 'pushed' && r.detail && <span data-repo-detail className="block text-[12px] text-gray-300 mt-0.5">{r.detail}</span>}
                  </span>
                  <span className="text-right shrink-0">
                    <span className={`block text-[13px] font-semibold ${says?.tone ?? 'text-gray-500'}`}>{says?.label ?? (published ? `Has v${published.version}` : 'Not yet')}</span>
                    {r && (r.commit || r.branch) && <span className="block text-[12px] text-gray-500">{[r.branch, r.commit].filter(Boolean).join(' · ')}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] text-gray-400 mt-3 leading-relaxed">
            One commit per repo, of the design system files only: your other changes there stay as they are, uncommitted. It pushes to the branch each repo is on, and never forces. A repo that cannot push keeps the commit and says why.
          </p>
        </div>
      </div>
    </section>
  );
}
