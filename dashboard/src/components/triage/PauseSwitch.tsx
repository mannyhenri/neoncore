/**
 * THE ONE SWITCH THAT STOPS EVERYTHING (the scope's guardrail 6). Always visible at the top of the
 * section: paused, no request goes to any cartridge, for any issue, until it is switched back.
 * Beside it, the daily cap and how much of it today has used.
 */
import type { TriageSettings } from './types';

export function PauseSwitch({ settings, busy, onToggle }: {
  settings: TriageSettings | undefined;
  busy: boolean;
  onToggle: (paused: boolean) => void;
}) {
  const paused = settings?.paused === true;
  return (
    <div data-triage-pause={paused ? 'paused' : 'running'}
      className={`flex items-center gap-4 rounded-[18px] border px-4 py-3 ${paused ? 'border-ember-400/60 bg-ember-500/10' : 'border-white/[0.08] bg-gl-surface'}`}>
      <button
        role="switch"
        aria-checked={paused}
        aria-label={paused ? 'Resume bug triage' : 'Pause all bug triage'}
        disabled={busy || settings === undefined}
        onClick={() => onToggle(!paused)}
        className={`relative h-9 w-[68px] shrink-0 rounded-full border transition-colors disabled:opacity-50 ${paused ? 'bg-ember-500/80 border-ember-300' : 'bg-emerald-500/30 border-emerald-400/60'}`}
      >
        <span className={`absolute top-1 h-[26px] w-[26px] rounded-full bg-gray-50 shadow transition-all ${paused ? 'left-[36px]' : 'left-1'}`} />
      </button>
      <div className="min-w-0">
        <div className={`text-[15px] font-semibold ${paused ? 'text-ember-200' : 'text-gray-100'}`}>
          {paused ? 'Triage is PAUSED' : 'Triage is running'}
        </div>
        <div className="text-[12px] text-gray-400">
          {paused ? 'Nothing is sent to any cartridge until you resume.' : 'One switch stops every request to every cartridge at once.'}
        </div>
      </div>
      <span className="flex-1" />
      {settings && settings.dailyDispatchCap > 0 && (
        <div data-triage-cap className="text-right">
          <div className="text-[12px] text-gray-400">Today</div>
          <div className="font-mono text-[14px] text-gray-100">{settings.dispatchesToday} / {settings.dailyDispatchCap}</div>
        </div>
      )}
    </div>
  );
}
