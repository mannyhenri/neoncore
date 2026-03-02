import { useRef, useEffect, useCallback } from 'react';
import type { WorkflowStepLog, StepLogType } from '../types';

const MAX_LOGS = 500;

const TYPE_COLORS: Record<StepLogType, string> = {
  info: 'text-gray-400',
  success: 'text-emerald-400',
  error: 'text-red-400',
  warn: 'text-amber-400',
  llm: 'text-cyan-400',
};

const TYPE_DOTS: Record<StepLogType, string> = {
  info: 'bg-gray-500',
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  warn: 'bg-amber-500',
  llm: 'bg-cyan-500',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface Props {
  logs: WorkflowStepLog[];
  collapsed: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function WorkflowExecutionLog({ logs, collapsed, onToggle, onClear }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="shrink-0 border-t border-white/[0.06]">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.02] transition-colors"
      >
        <svg
          className={`w-3 h-3 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
          Execution Log
        </span>
        {logs.length > 0 && (
          <span className="text-[10px] bg-white/5 text-gray-500 px-1.5 rounded-full">
            {logs.length}
          </span>
        )}
        <div className="flex-1" />
        {logs.length > 0 && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors cursor-pointer"
          >
            Clear
          </span>
        )}
      </button>

      {/* Log content */}
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-40 overflow-y-auto bg-[#0d0d14] px-3 py-2 font-mono text-[11px] leading-relaxed"
        >
          {logs.length === 0 ? (
            <div className="text-gray-600 text-center py-6">
              Run a workflow to see execution logs here.
            </div>
          ) : (
            logs.slice(-MAX_LOGS).map((log, i) => (
              <div key={i} className="flex items-start gap-2 py-px">
                <span className="text-gray-600 shrink-0">{formatTime(log.timestamp)}</span>
                <span className={`w-1.5 h-1.5 rounded-full mt-[5px] shrink-0 ${TYPE_DOTS[log.type]}`} />
                {log.stepName && (
                  <span className="text-gl-purple shrink-0 truncate max-w-[140px]">
                    {log.stepName}
                  </span>
                )}
                <span className={TYPE_COLORS[log.type]}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
