import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import type { Agent } from '../types';

interface Props {
  /** Pre-filled text content to send */
  initialText: string;
  /** Label shown in the header (e.g. "Activity Log", "Session Summary") */
  sourceLabel?: string;
  /** Agent ID to exclude from the target dropdown (the source cartridge) */
  excludeAgentId?: string;
  /** All agents for the dropdown */
  agents: Agent[];
  onClose: () => void;
}

export default function SendToCartridgeModal({
  initialText,
  sourceLabel,
  excludeAgentId,
  agents,
  onClose,
}: Props) {
  const [text, setText] = useState(initialText);
  const [targetAgentId, setTargetAgentId] = useState('');
  const [includeMemory, setIncludeMemory] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onlineAgents = agents.filter(
    (a) => a.status !== 'offline' && a.id !== excludeAgentId,
  );

  // Auto-select first available agent
  useEffect(() => {
    if (!targetAgentId && onlineAgents.length > 0) {
      setTargetAgentId(onlineAgents[0].id);
    }
  }, [onlineAgents, targetAgentId]);

  // ESC to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSend = async () => {
    if (!targetAgentId || !text.trim()) return;
    setSending(true);
    try {
      await api.sendCommand(targetAgentId, text.trim(), includeMemory);
      setSent(true);
      setTimeout(onClose, 1200);
    } catch {
      setSending(false);
    }
  };

  const selectedAgent = agents.find((a) => a.id === targetAgentId);

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Send to Cartridge</h2>
            {sourceLabel && (
              <p className="text-[13px] text-gray-500 mt-0.5">From: {sourceLabel}</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Target cartridge */}
          <div className="space-y-1.5">
            <label className="text-[13px] text-gray-500 uppercase tracking-wider">Target Cartridge</label>
            {onlineAgents.length === 0 ? (
              <p className="text-xs text-gray-500">No other cartridges online</p>
            ) : (
              <select
                value={targetAgentId}
                onChange={(e) => setTargetAgentId(e.target.value)}
                className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
              >
                {onlineAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.repoName || a.name}
                    {a.agentType === 'gridlight' ? ' (Gridlight)' : ' (Claude CC)'}
                    {a.branch ? ` — ${a.branch}` : ''}
                  </option>
                ))}
              </select>
            )}
            {selectedAgent && (
              <div className="flex items-center gap-2 text-[13px]">
                <span className={`px-1.5 py-0.5 rounded font-medium ${
                  selectedAgent.agentType === 'gridlight'
                    ? 'bg-pink-900/60 text-pink-300'
                    : 'bg-blue-900/60 text-blue-300'
                }`}>
                  {selectedAgent.agentType === 'gridlight' ? 'GL' : 'CC'}
                </span>
                <span className="text-gray-500">{selectedAgent.machine?.replace(/\.local$/, '')}</span>
              </div>
            )}
          </div>

          {/* Editable content */}
          <div className="space-y-1.5">
            <label className="text-[13px] text-gray-500 uppercase tracking-wider">Content</label>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono"
              placeholder="Enter content to send..."
            />
            <p className="text-[13px] text-gray-600">{text.length} chars — edit to add extra context before sending</p>
          </div>

          {/* Include memory toggle */}
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeMemory}
              onChange={() => setIncludeMemory(!includeMemory)}
              className="accent-purple-500 w-3 h-3"
            />
            Include agent memory
          </label>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/[0.06] flex items-center gap-3">
          {sent ? (
            <span className="text-sm text-emerald-400 font-medium">Sent!</span>
          ) : (
            <button
              onClick={handleSend}
              disabled={sending || !targetAgentId || !text.trim()}
              className="text-sm px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md disabled:opacity-30 transition-colors"
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
          )}
          <button onClick={onClose} className="text-sm px-3 py-2 text-gray-500 hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
