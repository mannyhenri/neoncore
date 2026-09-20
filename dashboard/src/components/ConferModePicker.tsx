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

export function ConferModePicker({ value, onChange }: {
  value: ConferMode;
  onChange: (m: ConferMode) => void;
}) {
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
    </div>
  );
}
