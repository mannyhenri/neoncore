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
  // Two big selectable cards per question, each carrying its own hint — the choice and its
  // consequence read together instead of the hint living under a row of pills.
  const card = (on: boolean) =>
    `flex flex-col gap-1 text-left px-3.5 py-3 min-h-[64px] rounded-xl border transition-colors ${
      on
        ? 'bg-neon-600/15 border-neon-500 shadow-[0_0_16px_rgba(90,174,255,0.3)] text-gray-100'
        : 'bg-[rgba(4,8,20,0.7)] border-white/[0.14] text-gray-200 hover:border-white/30'
    }`;
  return (
    <div className="mt-3 space-y-2">
      <span className="text-sm font-semibold text-gray-100 block">How should they work?</span>
      <div className="grid grid-cols-2 gap-2.5">
        {CONFER_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value === m}
            onClick={() => onChange(m)}
            title={CONFER_MODE_LABEL[m].hint}
            className={card(value === m)}
          >
            <span className="text-sm font-semibold">{CONFER_MODE_LABEL[m].title}</span>
            <span className="text-[12px] text-gray-400 leading-snug">{CONFER_MODE_LABEL[m].hint}</span>
          </button>
        ))}
      </div>

      {isolationOffered && (
        <>
          <span className="text-sm font-semibold text-gray-100 block pt-1">Where do they work?</span>
          <div className="grid grid-cols-2 gap-2.5">
            {CONFER_ISOLATIONS.map((i) => (
              <button
                key={i}
                type="button"
                aria-pressed={effectiveIsolation === i}
                onClick={() => onIsolationChange?.(i)}
                title={CONFER_ISOLATION_LABEL[i].hint}
                className={card(effectiveIsolation === i)}
              >
                <span className="text-sm font-semibold">{CONFER_ISOLATION_LABEL[i].title}</span>
                <span className="text-[12px] text-gray-400 leading-snug">{CONFER_ISOLATION_LABEL[i].hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
