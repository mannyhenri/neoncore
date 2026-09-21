/**
 * Split the work, or work together.
 *
 * Both modes have always existed in the conductor with genuinely different milestone sets —
 * DIVIDE opens by agreeing who owns what so the peers do not collide; COLLABORATE has them
 * work the same thing and reconcile. What was lost when confer moved into workflows was the
 * CHOICE: run-level confer hardcoded divide, so a workflow confer silently split work that
 * sometimes needed doing together. Reported as "the old confer had two modes ... restore
 * these modes into the confer workflows, it's super important".
 *
 * ONE COMPONENT for all three launch surfaces. The confer launch GATE lived in three places
 * and was reported three separate times, each fix landing on whichever surface the reporter
 * happened to have open.
 */
export type ConferMode = 'divide' | 'collaborate';
export type ConferIsolation = 'shared' | 'worktree';

export const CONFER_MODE_LABEL: Record<ConferMode, { title: string; hint: string }> = {
  divide: {
    title: 'Split the work',
    hint: 'They agree who owns what first, then work separate areas so they do not collide.',
  },
  collaborate: {
    title: 'Work together',
    hint: 'Both work the same thing and reconcile, for work too entangled to divide.',
  },
};

export const CONFER_MODES: ConferMode[] = ['divide', 'collaborate'];

/**
 * How they share the repo while they work. Offered because it is a real choice with a real
 * cost either way, and because it was previously hardcoded to `shared` — the only way to get
 * a worktree each was to edit the run's rows by hand, which was done twice in one week.
 *
 * WORKTREE IS ONLY OFFERED UNDER `divide`. Under `collaborate` both cartridges work the same
 * thing, so separate trees would produce two divergent answers; the server refuses that
 * combination outright, and a control that offers an option the server rejects is a trap.
 */
export const CONFER_ISOLATIONS: ConferIsolation[] = ['shared', 'worktree'];

export const CONFER_ISOLATION_LABEL: Record<ConferIsolation, { title: string; hint: string }> = {
  shared: {
    title: 'Shared checkout',
    hint: 'Both work in the same tree. Simpler, but they share one git index and build lock.',
  },
  worktree: {
    title: 'A worktree each',
    hint: 'Each gets its own tree, so neither can disturb the other. Costs disk and a merge at the end.',
  },
};

export function ConferModePicker({ value, onChange, isolation, onIsolationChange }: {
  value: ConferMode;
  onChange: (m: ConferMode) => void;
  /** Omit both to hide the isolation row entirely (surfaces that do not offer it yet). */
  isolation?: ConferIsolation;
  onIsolationChange?: (i: ConferIsolation) => void;
}) {
  // Under collaborate a worktree each is refused by the server, so the choice is not offered
  // and any prior worktree pick is reflected back as shared rather than left looking selected.
  const isolationOffered = !!onIsolationChange && value === 'divide';
  const effectiveIsolation: ConferIsolation = value === 'divide' ? (isolation ?? 'shared') : 'shared';
  return (
    <div className="mt-2">
      <label className="text-[11px] text-gray-500 block mb-1">How should they work?</label>
      <div className="flex flex-wrap gap-1">
        {CONFER_MODES.map((m) => {
          const on = value === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              title={CONFER_MODE_LABEL[m].hint}
              className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                on
                  ? 'border-amber-400/40 bg-amber-500/10 text-amber-300'
                  : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
              }`}
            >
              {CONFER_MODE_LABEL[m].title}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{CONFER_MODE_LABEL[value].hint}</p>

      {isolationOffered && (
        <div className="mt-2">
          <label className="text-[11px] text-gray-500 block mb-1">Where do they work?</label>
          <div className="flex flex-wrap gap-1">
            {CONFER_ISOLATIONS.map((i) => {
              const on = effectiveIsolation === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onIsolationChange?.(i)}
                  title={CONFER_ISOLATION_LABEL[i].hint}
                  className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                    on
                      ? 'border-sky-400/40 bg-sky-500/10 text-sky-300'
                      : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {CONFER_ISOLATION_LABEL[i].title}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">{CONFER_ISOLATION_LABEL[effectiveIsolation].hint}</p>
        </div>
      )}
    </div>
  );
}
