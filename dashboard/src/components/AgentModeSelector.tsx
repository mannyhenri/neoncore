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
  plan: 'bg-indigo-700 text-indigo-200',
  manual: 'bg-gray-700 text-gray-200',
  trust: 'bg-neon-700 text-neon-200',
};

export function AgentModeSelector({ mode, onSetMode }: Props) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-700">
      {MODE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onSetMode(opt.value)}
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            mode === opt.value
              ? ACTIVE_STYLES[opt.value]
              : 'bg-gray-800/50 text-gray-500 hover:text-gray-300'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
