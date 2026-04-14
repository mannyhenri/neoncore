import { useState } from 'react';
import { api } from '../lib/api';

interface Props {
  onClose: () => void;
  onCreated: (workflowId: string) => void;
}

export function WorkflowGeneratorModal({ onClose, onCreated }: Props) {
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const handleGenerate = async () => {
    if (!description.trim()) return;
    setGenerating(true);
    setError('');
    try {
      const { id } = await api.generateWorkflow(description.trim());
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
      setGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleGenerate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="glass-dark rounded-xl border border-white/10 w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div>
            <h3 className="text-sm font-medium text-gray-200">AI Workflow Generator</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Describe what you want to accomplish — the AI will build a workflow graph.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Review the codebase for security issues, fix them, run tests, then notify me"
            rows={5}
            disabled={generating}
            className="w-full glass-input text-sm text-gray-200 rounded-md px-3 py-2.5 focus:outline-none placeholder-gray-600 resize-none disabled:opacity-50"
            autoFocus
          />

          {error && (
            <div className="text-xs text-red-400 bg-red-950/30 rounded px-3 py-2">{error}</div>
          )}

          <p className="text-[11px] text-gray-600">
            Requires Anthropic or OpenAI API key in Settings → Notifications / API Keys.
            Press <span className="font-mono">⌘↵</span> to generate.
          </p>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/[0.06] flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={generating}
            className="text-xs px-3 py-1.5 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || !description.trim()}
            className="text-xs px-4 py-1.5 rounded-md bg-gl-purple/20 text-gl-purple hover:bg-gl-purple/30 border border-gl-purple/30 disabled:opacity-40 flex items-center gap-2"
          >
            {generating ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Generating…
              </>
            ) : (
              'Generate Workflow'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
