import type { AgentMode } from '../types';

interface Props {
  mode: AgentMode;
  onSetMode: (mode: AgentMode) => void;
}

const MODE_OPTIONS: { value: AgentMode; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'manual', label: 'Manual' },
  { value: 'trust', label: 'Trust' },
];

export function AgentModeSelector({ mode, onSetMode }: Props) {
  return (
    <div role="radiogroup" aria-label="Mode" className="flex gap-1 p-1 rounded-[10px] bg-[#050913]/80 border border-white/[0.1]">
      {MODE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={mode === opt.value}
          onClick={() => onSetMode(opt.value)}
          className={`h-8 px-3.5 rounded-[7px] text-[13px] font-semibold transition-colors ${
            mode === opt.value
              ? 'bg-neon-500/25 text-gray-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.55)]'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
