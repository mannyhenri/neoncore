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

const ACTIVE_STYLES: Record<AgentMode, string> = {
  plan: 'bg-indigo-600/80 text-indigo-200',
  manual: 'bg-white/10 text-gray-200',
  trust: 'gl-gradient text-white',
};

export function AgentModeSelector({ mode, onSetMode }: Props) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/10">
      {MODE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onSetMode(opt.value)}
          className={`px-3.5 py-1.5 text-sm font-medium transition-colors ${
            mode === opt.value
              ? ACTIVE_STYLES[opt.value]
              : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 hover:bg-white/[0.08]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
