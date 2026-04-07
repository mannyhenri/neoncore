import { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Activity, Agent } from '../types';
import SendToCartridgeModal from './SendToCartridgeModal';

const proseClass = `prose prose-invert prose-sm max-w-none
  prose-p:my-1 prose-p:text-gray-300 prose-p:leading-relaxed
  prose-headings:text-gray-200 prose-headings:mt-2 prose-headings:mb-1
  prose-code:text-gl-pink prose-code:bg-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
  prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:text-xs
  prose-li:text-gray-300 prose-li:my-0.5
  prose-strong:text-gray-200
  prose-a:text-gl-purple
  prose-table:border-collapse
  prose-th:border prose-th:border-gray-700 prose-th:bg-gray-800/60 prose-th:px-3 prose-th:py-1.5 prose-th:text-gray-300 prose-th:text-left prose-th:text-xs prose-th:font-semibold
  prose-td:border prose-td:border-gray-700 prose-td:px-3 prose-td:py-1.5 prose-td:text-gray-400 prose-td:text-xs`;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ActivityDetailModalProps {
  activity: Activity;
  agent?: Agent;
  agents?: Agent[];
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Tool color mapping
// ---------------------------------------------------------------------------

const TOOL_COLORS: Record<string, string> = {
  Read: 'bg-blue-900/50 text-blue-400',
  Edit: 'bg-yellow-900/50 text-yellow-400',
  Write: 'bg-green-900/50 text-green-400',
  Bash: 'bg-red-900/50 text-red-400',
  Grep: 'bg-cyan-900/50 text-cyan-400',
  Glob: 'bg-purple-900/50 text-purple-400',
  Task: 'bg-pink-900/50 text-pink-400',
  WebFetch: 'bg-orange-900/50 text-orange-400',
  AskUserQuestion: 'bg-yellow-900/50 text-yellow-300',
  ExitPlanMode: 'bg-violet-900/50 text-violet-400',
};

const DEFAULT_TOOL_COLOR = 'bg-gray-800 text-gray-400';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(raw: string): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Build a human-readable summary line for common tool inputs. */
function humanSummary(toolName: string, parsed: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Read': {
      const fp = parsed.file_path as string | undefined;
      return fp ? `Reading ${fp}` : null;
    }
    case 'Edit': {
      const fp = parsed.file_path as string | undefined;
      return fp ? `Editing ${fp}` : null;
    }
    case 'Write': {
      const fp = parsed.file_path as string | undefined;
      return fp ? `Writing ${fp}` : null;
    }
    case 'Bash': {
      const cmd = parsed.command as string | undefined;
      return cmd ? `Running: ${cmd}` : null;
    }
    case 'Grep': {
      const pat = parsed.pattern as string | undefined;
      return pat ? `Searching for ${pat}` : null;
    }
    case 'Glob': {
      const pat = parsed.pattern as string | undefined;
      return pat ? `Finding files: ${pat}` : null;
    }
    default:
      return null;
  }
}

/** Check if a string looks like a file path. */
function isFilePath(value: string): boolean {
  return /^[\/~.][\w\-\/.\s]+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
      {children}
    </h3>
  );
}

function CodeBlock({ content }: { content: string }) {
  return (
    <pre className="text-xs text-gray-300 bg-black/40 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[50vh] overflow-y-auto">
      {content}
    </pre>
  );
}

/** Render a labeled field row */
function FieldRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[13px] text-gray-500 uppercase tracking-wide shrink-0 pt-0.5 min-w-[60px]">{label}</span>
      <span className={`text-xs text-gray-300 break-all ${mono ? 'font-mono bg-white/[0.04] px-1.5 py-0.5 rounded' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/** Extract displayable fields from tool input object, skipping huge content */
function extractFields(obj: Record<string, unknown>): { label: string; value: string; mono?: boolean }[] {
  const fields: { label: string; value: string; mono?: boolean }[] = [];
  const SKIP_KEYS = new Set(['old_string', 'new_string', 'content']);
  const LARGE_LIMIT = 300;

  for (const [key, val] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    if (val === undefined || val === null || val === '') continue;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    if (str.length > LARGE_LIMIT) continue;
    const label = key.replace(/_/g, ' ');
    const isMono = key.includes('path') || key.includes('command') || key.includes('pattern') || key.includes('glob');
    fields.push({ label, value: str, mono: isMono });
  }
  return fields;
}

/** Try to extract readable text from a result (unwrap JSON wrappers) */
function unwrapResultText(raw: string): { text: string; isPlainText: boolean } {
  const parsed = safeParseJson(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    // Common patterns: { content: "..." }, { output: "..." }, { result: "..." }, { planContent: "..." }
    for (const key of ['content', 'output', 'result', 'text', 'message', 'planContent']) {
      if (typeof obj[key] === 'string' && (obj[key] as string).length > 20) {
        return { text: obj[key] as string, isPlainText: true };
      }
    }
  }
  // Not JSON or no extractable field
  const isPlainText = !raw.startsWith('{') && !raw.startsWith('[');
  return { text: raw, isPlainText };
}

function ToolInputSection({ toolName, rawInput }: { toolName: string; rawInput: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = safeParseJson(rawInput);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const summary = humanSummary(toolName, obj);
    const fields = extractFields(obj);

    return (
      <div className="space-y-2">
        <SectionHeading>Tool Input</SectionHeading>

        {summary && (
          <div className="text-sm text-gray-200 bg-white/[0.04] rounded-lg px-3 py-2 font-medium">
            {summary}
          </div>
        )}

        {/* Diff preview for Edit tool */}
        {toolName === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string' && (
          <div className="space-y-1">
            <div className="text-[13px] text-gray-500 uppercase tracking-wide">Diff Preview</div>
            <div className="bg-black/40 rounded-lg p-3 overflow-x-auto text-xs font-mono leading-relaxed space-y-2">
              <div>
                <span className="text-red-400 select-none">- </span>
                <span className="text-red-300/80 whitespace-pre-wrap">{String(obj.old_string)}</span>
              </div>
              <div>
                <span className="text-green-400 select-none">+ </span>
                <span className="text-green-300/80 whitespace-pre-wrap">{String(obj.new_string)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Key fields as labeled rows */}
        {fields.length > 0 && !summary && (
          <div className="space-y-1.5 bg-black/20 rounded-lg px-3 py-2">
            {fields.map((f, i) => (
              <FieldRow key={i} label={f.label} value={f.value} mono={f.mono} />
            ))}
          </div>
        )}

        {/* Collapsible raw JSON */}
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-[13px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          {showRaw ? 'Hide raw' : 'Show raw'}
        </button>
        {showRaw && <CodeBlock content={JSON.stringify(parsed, null, 2)} />}
      </div>
    );
  }

  // Raw string fallback
  const displayText = rawInput || '(empty)';
  return (
    <div className="space-y-2">
      <SectionHeading>Tool Input</SectionHeading>
      {isFilePath(displayText) ? (
        <span className="text-xs text-blue-400 font-mono bg-blue-900/20 px-2 py-0.5 rounded inline-block">
          {displayText}
        </span>
      ) : (
        <CodeBlock content={displayText} />
      )}
    </div>
  );
}

function ToolResultSection({ rawResult, renderMarkdown }: { rawResult: string; renderMarkdown?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const TRUNCATE_LIMIT = 2000;

  if (!rawResult) {
    return (
      <div className="space-y-2">
        <SectionHeading>Tool Result</SectionHeading>
        <p className="text-xs text-gray-600 italic">(no result)</p>
      </div>
    );
  }

  const { text: displayContent, isPlainText } = unwrapResultText(rawResult);
  const hasJsonWrapper = displayContent !== rawResult; // was unwrapped

  const isTruncated = !expanded && displayContent.length > TRUNCATE_LIMIT;
  const visibleContent = isTruncated
    ? displayContent.slice(0, TRUNCATE_LIMIT)
    : displayContent;

  return (
    <div className="space-y-2">
      <SectionHeading>Tool Result</SectionHeading>
      {renderMarkdown ? (
        <div className={`bg-black/40 rounded-lg p-3 overflow-x-auto max-h-[50vh] overflow-y-auto ${proseClass}`}>
          <Markdown remarkPlugins={[remarkGfm]}>{visibleContent}</Markdown>
        </div>
      ) : isPlainText ? (
        <div className="text-sm text-gray-300 bg-black/40 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-y-auto">
          {visibleContent}
        </div>
      ) : (
        <CodeBlock content={visibleContent} />
      )}
      {isTruncated && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-gl-purple hover:text-gl-pink transition-colors font-medium"
        >
          Show more ({(displayContent.length - TRUNCATE_LIMIT).toLocaleString()} chars remaining)
        </button>
      )}
      {expanded && displayContent.length > TRUNCATE_LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Show less
        </button>
      )}
      {hasJsonWrapper && (
        <>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-[13px] text-gray-600 hover:text-gray-400 transition-colors"
          >
            {showRaw ? 'Hide raw' : 'Show raw'}
          </button>
          {showRaw && <CodeBlock content={rawResult} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityDetailModal
// ---------------------------------------------------------------------------

export function ActivityDetailModal({ activity, agent, agents, onClose }: ActivityDetailModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [sendModalOpen, setSendModalOpen] = useState(false);

  // ESC key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const toolColor = TOOL_COLORS[activity.toolName] || DEFAULT_TOOL_COLOR;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="glass rounded-xl md:rounded-2xl w-full max-w-2xl mx-2 md:mx-0 max-h-[90vh] flex flex-col shadow-2xl">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* Tool name badge */}
            <span className={`text-sm font-semibold px-2.5 py-1 rounded-md shrink-0 ${toolColor}`}>
              {activity.toolName || activity.eventType}
            </span>

            {/* Event type badge */}
            {activity.toolName && activity.eventType && (
              <span className="text-[13px] px-2 py-0.5 rounded bg-white/[0.06] text-gray-400 shrink-0">
                {activity.eventType}
              </span>
            )}

            {/* Timestamp */}
            <span className="text-xs text-gray-500 truncate ml-auto mr-3">
              {formatTimestamp(activity.timestamp)}
            </span>
          </div>

          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-xl leading-none shrink-0 transition-colors"
          >
            &times;
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 space-y-5">
          {/* Agent info */}
          {agent && (
            <div className="space-y-2">
              <SectionHeading>Agent</SectionHeading>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide ${
                  agent.agentType === 'gridlight'
                    ? 'bg-pink-900/60 text-pink-300'
                    : 'bg-blue-900/60 text-blue-300'
                }`}>
                  {agent.agentType === 'gridlight' ? 'Gridlight' : 'Claude CC'}
                </span>
                <span className="text-sm text-gray-200 font-medium">{agent.name}</span>
                {agent.repoName && (
                  <span className="text-xs text-gray-400 font-mono bg-white/[0.04] px-2 py-0.5 rounded">
                    {agent.repoName}
                  </span>
                )}
                {agent.machine && (
                  <span className="text-xs text-gray-500 font-mono">
                    {agent.machine.replace(/\.local$/, '')}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Tool Input */}
          {activity.eventType === 'assistant_message' ? (
            <div className="space-y-2">
              <SectionHeading>Message</SectionHeading>
              <div className={`bg-black/40 rounded-lg p-3 overflow-x-auto max-h-[50vh] overflow-y-auto ${proseClass}`}>
                <Markdown remarkPlugins={[remarkGfm]}>{activity.toolInput}</Markdown>
              </div>
            </div>
          ) : (
            <ToolInputSection toolName={activity.toolName} rawInput={activity.toolInput} />
          )}

          {/* Tool Result */}
          <ToolResultSection
            rawResult={activity.toolResult}
            renderMarkdown={activity.toolName === 'ExitPlanMode' || activity.eventType === 'plan_mode'}
          />
        </div>

        {/* ── Footer ── */}
        <div className="px-4 py-3 md:px-6 md:py-3 border-t border-white/[0.06] flex items-center justify-between">
          <span className="text-[13px] text-gray-600 font-mono">
            ID: {activity.id}
          </span>
          <div className="flex items-center gap-2">
            {agents && agents.length > 0 && (
              <button
                onClick={() => setSendModalOpen(true)}
                className="text-xs px-3 py-1.5 text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-md transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
                Send to Cartridge
              </button>
            )}
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 text-gray-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] rounded-md transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {sendModalOpen && agents && (
        <SendToCartridgeModal
          initialText={buildSendText(activity)}
          sourceLabel={`${activity.toolName || activity.eventType} — ${agent?.repoName || 'unknown'}`}
          excludeAgentId={activity.agentId}
          agents={agents}
          onClose={() => setSendModalOpen(false)}
        />
      )}
    </div>
  );
}

function buildSendText(activity: Activity): string {
  const parts: string[] = [];
  if (activity.eventType === 'assistant_message') {
    parts.push(activity.toolInput || '');
  } else {
    if (activity.toolName) parts.push(`[${activity.toolName}]`);
    if (activity.toolInput) {
      const input = typeof activity.toolInput === 'string' ? activity.toolInput : JSON.stringify(activity.toolInput, null, 2);
      parts.push(input);
    }
    if (activity.toolResult && activity.toolResult !== '{}') {
      const result = typeof activity.toolResult === 'string' ? activity.toolResult : JSON.stringify(activity.toolResult, null, 2);
      parts.push('\n--- Result ---\n' + result);
    }
  }
  return parts.join('\n').trim();
}
