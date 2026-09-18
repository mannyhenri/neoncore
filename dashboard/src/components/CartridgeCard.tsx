import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, CommandAttachmentInput } from '../types';
import { AgentModeSelector } from './AgentModeSelector';
import { CommandInput } from './CommandInput';
import { GitPanel } from './GitPanel';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import SendContextModal from './SendContextModal';
import { api } from '../lib/api';
import { generatePixelSprites } from '../lib/sprites';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CartridgeCardProps {
  agent: Agent;
  siblingAgents?: Agent[];
  allAgents?: Agent[];
  activities: Activity[];
  permissions: PermissionRequest[];
  stuckAlert?: StuckAlert;
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean, attachments?: CommandAttachmentInput[]) => void;
  onDelete: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG = {
  working: { color: 'bg-green-500', label: 'Working' },
  idle: { color: 'bg-gray-500', label: 'Idle' },
  waiting: { color: 'bg-yellow-500', label: 'Waiting' },
  offline: { color: 'bg-red-500', label: 'Offline' },
} as const;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function shortMachine(machine: string): string {
  return machine.replace(/\.local$/, '');
}

// Presentation for each tool (agentType). `label` is the full badge/selector text,
// `short` the compact form used to tag Live Log lines, `badge` the Tailwind classes.
type ToolMeta = { label: string; short: string; badge: string };
function toolMeta(agentType: string): ToolMeta {
  switch (agentType) {
    case 'gridlight': return { label: 'Gridlight', short: 'Gridlight', badge: 'bg-pink-900/60 text-pink-300' };
    case 'codex':     return { label: 'Codex CLI', short: 'Codex', badge: 'bg-green-900/60 text-green-300' };
    default:          return { label: 'Claude CC', short: 'Claude', badge: 'bg-blue-900/60 text-blue-300' };
  }
}

function launchTypeFor(agentType: string): string {
  switch (agentType) {
    case 'gridlight': return 'gridlight-cli';
    case 'codex': return 'codex-cli';
    default: return 'claude-cli';
  }
}

/** Truncate a tool input/result to a brief description for the terminal view. */
function briefSummary(activity: Activity): string {
  const { toolName, toolInput } = activity;
  if (!toolInput) return toolName || activity.eventType;

  try {
    const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;

    // Common tool patterns
    if (parsed.file_path) {
      const file = String(parsed.file_path).split('/').pop();
      return file || toolName;
    }
    if (parsed.command) {
      const cmd = String(parsed.command);
      return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
    }
    if (parsed.pattern) return String(parsed.pattern);
    if (parsed.query) return String(parsed.query).slice(0, 40);
    if (parsed.url) return String(parsed.url).slice(0, 40);
  } catch {
    // Not JSON — use raw
    const raw = String(toolInput);
    return raw.length > 40 ? raw.slice(0, 37) + '...' : raw;
  }

  return toolName || activity.eventType;
}

// ---------------------------------------------------------------------------
// QuestionAnswerCard — for AskUserQuestion permissions
// ---------------------------------------------------------------------------

function QuestionAnswerCard({ permission, onDecide }: {
  permission: PermissionRequest;
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
}) {
  type QuestionOption = { label: string; description?: string } | string;
  type Question = { id?: string; question: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean };

  function normalizeQuestion(raw: unknown): Question | null {
    if (!raw || typeof raw !== 'object') return null;
    const q = raw as Record<string, unknown>;
    const questionText = typeof q.question === 'string'
      ? q.question.trim()
      : typeof q.prompt === 'string'
        ? q.prompt.trim()
        : '';
    if (!questionText) return null;
    return {
      id: typeof q.id === 'string' ? q.id : undefined,
      question: questionText,
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options) ? q.options as QuestionOption[] : undefined,
      multiSelect: Boolean(q.multiSelect),
    };
  }

  function parseQuestions(toolInput: PermissionRequest['toolInput']): Question[] {
    try {
      const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
      if (!input || typeof input !== 'object') return [];
      const parsed = input as Record<string, unknown>;
      if (Array.isArray(parsed.questions)) {
        return parsed.questions.map(normalizeQuestion).filter((q): q is Question => q !== null);
      }
      const single = normalizeQuestion(parsed);
      return single ? [single] : [];
    } catch {
      return [];
    }
  }

  function questionKey(question: Question, index: number): string {
    const id = question.id?.trim();
    if (id) return id;
    const text = question.question.trim();
    if (text) return text;
    return String(index);
  }

  function normalizeOption(option: QuestionOption): { label: string; description?: string } {
    if (typeof option === 'string') return { label: option };
    return { label: option.label || '', description: option.description };
  }

  const questions = parseQuestions(permission.toolInput);
  const isMulti = questions.length > 1 || questions.some((q) => q.multiSelect);

  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  const handleSelect = (qi: number, label: string) => {
    const q = questions[qi];
    if (!q) return;
    const key = questionKey(q, qi);

    if (q.multiSelect) {
      setSelections((prev) => {
        const existing = (prev[key] as string[]) || [];
        return { ...prev, [key]: existing.includes(label) ? existing.filter((l) => l !== label) : [...existing, label] };
      });
    } else if (isMulti) {
      setSelections((prev) => ({ ...prev, [key]: label }));
    } else {
      onDecide(permission.id, 'allowed', { answers: { [key]: label } });
    }
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const key = questionKey(q, qi);
      if (showCustom[key] && customTexts[key]?.trim()) {
        answers[key] = customTexts[key].trim();
      } else {
        const sel = selections[key];
        answers[key] = Array.isArray(sel) ? sel.join(', ') : (sel as string) || '';
      }
    });
    onDecide(permission.id, 'allowed', { answers });
  };

  if (questions.length === 0) {
    return (
      <div className="bg-yellow-950/40 border border-yellow-700 rounded px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 bg-yellow-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
          <span className="text-yellow-300 text-xs font-semibold">Question from Agent</span>
        </div>
        <p className="text-xs text-gray-400">{permission.description}</p>
      </div>
    );
  }

  return (
    <div className="bg-yellow-950/40 border border-yellow-700 rounded px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 bg-yellow-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
        <span className="text-yellow-300 text-xs font-semibold">Question from Agent</span>
      </div>
      {questions.map((q, qi) => {
        const key = questionKey(q, qi);
        const sel = selections[key];
        return (
          <div key={qi}>
            {q.header && <div className="text-[13px] text-gray-500 uppercase mb-0.5">{q.header}</div>}
            <p className="text-xs text-gray-300 mb-1.5">{q.question}</p>
            {q.options && q.options.length > 0 && !showCustom[key] && (
              <div className="flex flex-wrap gap-1">
                {q.options.map((rawOpt, oi) => {
                  const opt = normalizeOption(rawOpt);
                  if (!opt.label) return null;
                  const isSelected = q.multiSelect
                    ? ((sel as string[]) || []).includes(opt.label)
                    : sel === opt.label;
                  return (
                    <button
                      key={oi}
                      onClick={() => handleSelect(qi, opt.label)}
                      className={`px-2 py-1 text-xs rounded transition-colors border ${
                        isSelected
                          ? 'bg-yellow-700/80 text-yellow-100 border-yellow-600'
                          : 'bg-yellow-900/60 hover:bg-yellow-800/80 text-yellow-200 border-yellow-700/50'
                      }`}
                      title={opt.description || ''}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: true }))}
                  className="px-2 py-1 text-xs rounded transition-colors border bg-gray-800/60 hover:bg-gray-700/60 text-gray-400 border-gray-700/50"
                >
                  Other...
                </button>
              </div>
            )}
            {showCustom[key] && (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={customTexts[key] || ''}
                  onChange={(e) => setCustomTexts((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder="Type your answer..."
                  className="flex-1 glass-input text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isMulti) handleSubmit(); }}
                  autoFocus
                />
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: false }))}
                  className="text-gray-500 hover:text-gray-300 text-[13px] px-1.5"
                >
                  Back
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isMulti && (
        <button
          onClick={handleSubmit}
          className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-xs rounded transition-colors font-medium"
        >
          Submit Answers
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanApprovalCard — for ExitPlanMode permissions
// ---------------------------------------------------------------------------

function PlanApprovalCard({ permission, onDecide }: {
  permission: PermissionRequest;
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');

  let allowedPrompts: { tool: string; prompt: string }[] = [];
  try {
    const input = typeof permission.toolInput === 'string' ? JSON.parse(permission.toolInput) : permission.toolInput;
    allowedPrompts = input?.allowedPrompts || [];
  } catch { /* ignore */ }

  return (
    <div className="bg-violet-950/40 border border-violet-700 rounded px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-2 h-2 bg-violet-400 animate-pulse" style={{ imageRendering: 'pixelated' }} />
        <span className="text-violet-300 text-xs font-semibold">Plan Ready for Review</span>
      </div>
      {allowedPrompts.length > 0 && (
        <div className="mb-2 space-y-0.5">
          <span className="text-[13px] text-gray-500 uppercase tracking-wide">Requested permissions:</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="text-xs text-gray-400 font-mono pl-2 border-l border-violet-800">
              {p.tool}: {p.prompt}
            </div>
          ))}
        </div>
      )}
      {showReject ? (
        <div className="space-y-1.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should be changed? (optional)"
            className="w-full glass-input text-gray-300 text-xs rounded px-2 py-1.5 resize-none h-14 focus:outline-none"
            autoFocus
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                onDecide(permission.id, 'denied', feedback.trim() ? { feedback: feedback.trim() } : undefined);
              }}
              className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
            >
              Confirm Reject
            </button>
            <button
              onClick={() => setShowReject(false)}
              className="px-2.5 py-1 text-gray-500 hover:text-gray-300 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onDecide(permission.id, 'allowed')}
            className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded transition-colors font-medium"
          >
            Approve Plan
          </button>
          <button
            onClick={() => setShowReject(true)}
            className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
          >
            Reject Plan
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlinePermission — generic Allow/Deny for regular tool permissions
// ---------------------------------------------------------------------------

function InlinePermission({ permission, onAllow, onDeny }: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 gap-2">
      <div className="flex-1 min-w-0">
        <span className="text-yellow-400 text-xs font-mono">{permission.toolName}</span>
        <p className="text-gray-400 text-xs font-mono truncate" title={permission.description}>
          {permission.description}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onAllow}
          className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded transition-colors font-medium"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded transition-colors font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CartridgeCard
// ---------------------------------------------------------------------------

export function CartridgeCard({
  agent,
  siblingAgents,
  allAgents,
  activities,
  permissions,
  stuckAlert,
  onDecidePermission,
  onSetMode,
  onSendCommand,
  onDelete,
  onDismiss,
  onDismissStuck,
  onActivityClick,
}: CartridgeCardProps) {
  // Only label cartridges from OTHER servers. Badging every card with "this machine"
  // would be noise on the single-server setup that most sessions still are.
  const originName = agent.origin ? agent.originName || agent.origin : '';
  // ---------------------------------------------------------------------------
  // Client-side status: "working" if ANY activity in the feed is < 120s old.
  // This overrides the server status so the dashboard always reflects reality.
  // ---------------------------------------------------------------------------
  const ACTIVE_WINDOW_MS = 120_000; // 2 minutes
  const [tick, setTick] = useState(Date.now());

  // Re-evaluate every 15s so status transitions even when no new events arrive
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const effectiveStatus = useMemo(() => {
    // Always respect waiting (pending question) and offline
    if (agent.status === 'waiting') return 'waiting' as const;
    if (agent.status === 'offline') {
      // Even offline can be overridden if we actually have fresh activity
      const hasRecent = activities.some(
        (a) => tick - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
      );
      if (hasRecent) return 'working' as const;
      return 'offline' as const;
    }

    const hasRecentActivity = activities.some(
      (a) => tick - new Date(a.timestamp).getTime() < ACTIVE_WINDOW_MS,
    );
    if (hasRecentActivity) return 'working' as const;
    return agent.status;
  }, [agent.status, activities, tick, ACTIVE_WINDOW_MS]);

  const status = STATUS_CONFIG[effectiveStatus];

  // The tools available in this cartridge (primary + siblings), Gridlight first — same
  // order as the badge row. Each is a separate agent with its own agentType.
  const tools = useMemo(
    () =>
      [agent, ...(siblingAgents || [])].sort(
        (a, b) => (a.agentType === 'gridlight' ? -1 : 1) - (b.agentType === 'gridlight' ? -1 : 1),
      ),
    [agent, siblingAgents],
  );
  const multiTool = tools.length > 1;

  // Which tools a sent prompt goes to. Multi-select, all-on by default: a prompt fans out to
  // every selected engine, and you deselect a badge to leave one out. (It used to be single-
  // select — one engine at a time.) Always keeps at least one target.
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(() => new Set(tools.map((t) => t.id)));
  // Reconcile the selection as engines come and go WITHOUT clobbering explicit deselections:
  // a newly-appeared engine defaults on, a vanished one drops out, and an engine the user
  // turned off stays off. knownToolIdsRef is how we tell "brand new" from "deselected".
  const knownToolIdsRef = useRef<Set<string>>(new Set(tools.map((t) => t.id)));
  useEffect(() => {
    const current = new Set(tools.map((t) => t.id));
    setSelectedToolIds((prev) => {
      const next = new Set<string>();
      for (const id of current) {
        if (!knownToolIdsRef.current.has(id)) next.add(id); // brand new → default on
        else if (prev.has(id)) next.add(id);                // still selected → keep
        // known but not selected → stays off
      }
      if (next.size === 0 && current.size > 0) next.add(agent.id); // never target nothing
      const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
      return unchanged ? prev : next;
    });
    knownToolIdsRef.current = current;
  }, [tools, agent.id]);

  const toggleTool = useCallback((id: string) => {
    setSelectedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev; // keep at least one send target
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // The single "focused" tool that the mode selector, plans toggle, recovery banner, and
  // command history follow — the first selected engine (usually the primary). When exactly
  // one engine is selected this is just that engine, matching the old single-select behavior.
  const selectedAgent = tools.find((t) => selectedToolIds.has(t.id)) || agent;
  const sendTargets = tools.filter((t) => selectedToolIds.has(t.id));
  const sendLabel = sendTargets.length === 0 || sendTargets.length === tools.length
    ? 'all tools'
    : sendTargets.map((t) => toolMeta(t.agentType).label).join(' + ');
  const [recoveringSession, setRecoveringSession] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [resumeAfterRelaunchId, setResumeAfterRelaunchId] = useState('');

  const [frame1, frame2, animSpeed] = useMemo(() => generatePixelSprites(agent.id), [agent.id]);
  const [spriteFrame, setSpriteFrame] = useState(0);

  // 2-frame retro sprite animation (like Space Invaders)
  useEffect(() => {
    const id = setInterval(() => setSpriteFrame((f) => (f === 0 ? 1 : 0)), animSpeed);
    return () => clearInterval(id);
  }, [animSpeed]);

  const pixelBg = spriteFrame === 0 ? frame1 : frame2;
  const [gitOpen, setGitOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  // Token usage + USD cost — fetched from server, refreshed when agent status changes
  const [tokenTotal, setTokenTotal] = useState<number | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  useEffect(() => {
    api.getAgentTokenUsage(agent.id).then((u) => { setTokenTotal(u.total); setCostUsd(u.costUsd); }).catch(() => {});
  }, [agent.id, effectiveStatus]);

  async function handleRecoverSession() {
    setRecoveringSession(true);
    setRecoveryNotice('');
    try {
      if (selectedAgent.status === 'offline') {
        await api.openRepo(selectedAgent.repoPath, launchTypeFor(selectedAgent.agentType));
        setResumeAfterRelaunchId(selectedAgent.id);
        setRecoveryNotice('Relaunched. When the cartridge reconnects, click Resume session.');
        return;
      }
      const result = await api.recoverAgentSession(selectedAgent.id);
      setResumeAfterRelaunchId('');
      setRecoveryNotice(`Recovery dispatched (${Math.round(result.promptChars / 1000)}k chars).`);
    } catch (err) {
      setRecoveryNotice(err instanceof Error ? err.message : 'Recovery failed');
    } finally {
      setRecoveringSession(false);
    }
  }

  // "This one doesn't need resuming" — hide the Resume banner without replaying. The server
  // marks it dismissed and broadcasts, which drops the banner everywhere; clearing the local
  // relaunch flag covers the post-Relaunch case that isn't backed by recoveryStatus.
  async function handleDismissRecovery() {
    setResumeAfterRelaunchId('');
    setRecoveryNotice('');
    try {
      await api.dismissAgentRecovery(selectedAgent.id);
    } catch (err) {
      setRecoveryNotice(err instanceof Error ? err.message : 'Could not dismiss');
    }
  }

  // The work-standard gate let this cartridge stop without a completion report. The flag is
  // the whole point of the gate's fallback path — it converts a silently half-finished task
  // into something visible, so it needs a human acknowledgement to clear, not a timer.
  async function handleClearStandardReview() {
    try {
      await api.clearStandardReview(selectedAgent.id);
    } catch {
      // Non-critical: the banner stays until the next successful clear.
    }
  }

  // Terminal tab state
  const logScrollRef = useRef<HTMLDivElement>(null);
  const logHoveredRef = useRef(false);

  // Auto-scroll live log to top when new activities arrive (newest is at top)
  useEffect(() => {
    if (!logHoveredRef.current && logScrollRef.current) {
      logScrollRef.current.scrollTop = 0;
    }
  }, [activities]);

  // Cartridge border highlight for special states
  const borderHighlight = stuckAlert
    ? 'border-amber-600/70'
    : effectiveStatus === 'waiting'
      ? 'border-yellow-700/60'
      : 'border-white/[0.08]';
  // 'dismissed' is the user saying "don't offer to resume this one" — it suppresses every
  // trigger below, including the plain offline-with-a-session case. A new command or a fresh
  // interruption resets recovery_status server-side, so the offer comes back when it matters.
  const shouldOfferSessionRecovery =
    selectedAgent.recoveryStatus !== 'dismissed'
    && (
      selectedAgent.recoveryStatus === 'interrupted'
      || selectedAgent.recoveryStatus === 'recovery_failed'
      || (selectedAgent.status === 'offline' && !!selectedAgent.sessionId)
      || resumeAfterRelaunchId === selectedAgent.id
    );

  return (
    <div className="relative flex flex-col">
      {/* ── Contact strip (top connector) ── */}
      <div
        className="mx-auto w-[60%] h-4 rounded-t-sm relative"
        style={{
          background: 'linear-gradient(180deg, #2a2a3e 0%, #1a1a2e 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Contact lines */}
        <div className="absolute inset-x-2 top-1 bottom-0 flex justify-between">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="w-[2px] h-full"
              style={{ background: 'rgba(168,85,247,0.25)' }}
            />
          ))}
        </div>
      </div>

      {/* ── Main cartridge body ── */}
      <div
        className={`glass rounded-lg border ${borderHighlight} flex flex-col transition-colors`}
        style={{
          borderTopLeftRadius: '2px',
          borderTopRightRadius: '2px',
        }}
      >
        {/* ── Sticker area ── */}
        <div
          className="mx-3 mt-3 mb-2 rounded p-3 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.25) 0%, rgba(236,72,153,0.2) 50%, rgba(59,130,246,0.15) 100%)',
            boxShadow: '0 0 0 2px #a855f7, 4px 4px 0 0 rgba(0,0,0,0.3)',
            imageRendering: 'pixelated',
          }}
        >
          {/* Pixel art background */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `url("${pixelBg}")`,
              backgroundSize: 'contain',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              imageRendering: 'pixelated',
              opacity: 0.12,
            }}
          />
          {/* Top row: repo name + controls */}
          <div className="flex items-start justify-between mb-1.5">
            <h3 className="font-pixel text-xs text-white leading-relaxed tracking-wide truncate flex-1 mr-2">
              {agent.repoName || 'UNKNOWN'}
            </h3>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setJournalOpen(true)}
                className="text-gray-400 hover:text-cyan-400 transition-colors"
                title="Project journal & session memory"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                </svg>
              </button>
              <button
                onClick={() => setGitOpen(true)}
                className="text-gray-400 hover:text-gl-purple transition-colors"
                title="Git worktrees & status"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9h6" />
                </svg>
              </button>
              <button
                onClick={() => setContextOpen(true)}
                className="text-gray-400 hover:text-gl-purple transition-colors"
                title="Send project context to agent"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              </button>
              {/* Delete — destructive, cascades. Given its own icon and a confirm so it can
                  never be mistaken for the ✕ beside it, which merely puts the card away. */}
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete the "${agent.repoName || agent.name}" cartridge and all its history?\n\n` +
                        `This cannot be undone. To just hide it, use ✕ — it comes back on its own the next time the agent does anything.`,
                    )
                  ) {
                    onDelete(agent.id);
                  }
                }}
                className="text-gray-400 hover:text-red-400 transition-colors"
                title="Delete cartridge and all its history (permanent)"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
              {/* Dismiss — "I'm done with this one for now." Does NOT stop the agent or end the
                  session; it just puts the card away. It reappears the moment the agent does
                  anything, or you send it a command / launch a workflow. */}
              <button
                onClick={() => onDismiss(agent.id)}
                className="text-gray-400 hover:text-white transition-colors"
                title="Put away — reappears as soon as this agent is used again"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Branch */}
          <div className="text-[13px] text-gray-300 mb-1 font-mono">
            Branch: {agent.branch || 'n/a'}
          </div>

          {/* Status row */}
          <div className="flex items-center gap-2 mb-1">
            {/* Pixel status dot (square) */}
            <div
              className={`w-2 h-2 ${status.color} ${effectiveStatus === 'working' || effectiveStatus === 'waiting' ? 'animate-pulse' : ''}`}
              style={{ imageRendering: 'pixelated' }}
            />
            <span className="text-[13px] text-gray-200">{status.label}</span>
            <span className="text-[13px] text-gray-500">{timeAgo(agent.lastSeen)}</span>
            {tokenTotal !== null && tokenTotal > 0 && (
              <span className="text-[11px] text-gray-600 font-mono ml-auto flex items-center gap-1.5" title="Total tokens consumed (input + output); cost includes cache">
                {costUsd !== null && costUsd > 0 && (
                  <span className="text-emerald-500/80">{costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(3)}`}</span>
                )}
                <span>~{tokenTotal >= 1000 ? `${(tokenTotal / 1000).toFixed(1)}k` : tokenTotal} tok</span>
              </span>
            )}
          </div>

          {/* Tool badges + machine — Gridlight first, then others. When more than one tool is
              running in this repo, the badges are a multi-select send target: all start
              selected, so a prompt fans out to every engine; tap one to exclude it (tap again
              to re-include). With a single tool they're plain labels. */}
          <div className="flex items-center gap-2 flex-wrap">
            {tools.map((a) => {
              const meta = toolMeta(a.agentType);
              const isSelected = selectedToolIds.has(a.id);
              if (!multiTool) {
                return (
                  <span key={a.id} className={`text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide ${meta.badge}`}>
                    {meta.label}
                  </span>
                );
              }
              return (
                <button
                  key={a.id}
                  onClick={() => toggleTool(a.id)}
                  aria-pressed={isSelected}
                  title={isSelected ? `Sending to ${meta.label} — click to exclude` : `Excluded — click to also send to ${meta.label}`}
                  className={`text-[13px] px-1.5 py-0.5 rounded font-medium tracking-wide transition-all ${meta.badge} ${
                    isSelected ? 'opacity-100' : 'opacity-30 hover:opacity-70'
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
            <span className="text-[13px] text-gray-500 font-mono truncate">
              {shortMachine(agent.machine)}
            </span>
            {/*
              Which SERVER this cartridge came from — shown only when it is not the local
              one. In a merged grid two machines can run the same repo on the same branch,
              and without this the two cards are indistinguishable.
            */}
            {originName && (
              <span
                className="text-[11px] text-violet-300/80 border border-violet-400/25 bg-violet-500/10 px-1.5 py-px rounded-full truncate max-w-[10rem]"
                title={`Served by ${originName}`}
              >
                {originName}
              </span>
            )}
          </div>

          {/* A question the agent asked and is waiting on. Previously the web showed nothing
              at all for this — only mobile did — so a cartridge could sit blocked on a
              question you would never see unless you opened its terminal. */}
          {selectedAgent.status === 'waiting' && selectedAgent.pendingQuestion && (
            <div className="mt-2 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-2">
              <div className="text-[12px] text-amber-200 font-medium">Waiting on your answer</div>
              <div className="text-[11px] text-amber-100/70 mt-0.5 whitespace-pre-wrap break-words">
                {selectedAgent.pendingQuestion.slice(0, 400)}
              </div>
              <div className="text-[11px] text-amber-200/50 mt-1">Reply in the prompt box below.</div>
            </div>
          )}

          {selectedAgent.standardState === 'needs_review' && (
            <div className="mt-2 rounded border border-amber-500/30 bg-amber-950/30 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-amber-200 font-medium">
                    Stopped without a completion report
                  </div>
                  <div className="text-[11px] text-amber-200/60 truncate">
                    {selectedAgent.activeObjective || 'The task may be only partially done — check before trusting it.'}
                  </div>
                </div>
                <button
                  onClick={handleClearStandardReview}
                  className="px-2 py-1 rounded bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 text-[12px] font-medium transition-colors shrink-0"
                  title="Mark as reviewed — clears the flag"
                >
                  Reviewed
                </button>
              </div>
            </div>
          )}

          {shouldOfferSessionRecovery && (
            <div className="mt-2 rounded border border-red-500/30 bg-red-950/30 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-red-200 font-medium">
                    {selectedAgent.recoveryStatus === 'interrupted' || selectedAgent.recoveryStatus === 'recovery_failed'
                      ? 'Session interrupted'
                      : 'Last session available'}
                  </div>
                  {selectedAgent.activeObjective && (
                    <div className="text-[11px] text-red-200/60 truncate">
                      {selectedAgent.activeObjective}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={handleRecoverSession}
                    disabled={recoveringSession || !selectedAgent.repoPath}
                    className="px-2 py-1 rounded bg-red-500/20 text-red-200 hover:bg-red-500/30 disabled:opacity-50 text-[12px] font-medium transition-colors"
                    title={selectedAgent.status === 'offline' ? 'Relaunch this cartridge first' : 'Replay the stored transcript into this cartridge'}
                  >
                    {recoveringSession
                      ? 'Working...'
                      : selectedAgent.status === 'offline'
                        ? 'Relaunch'
                        : selectedAgent.recoveryStatus === 'recovery_failed'
                          ? 'Retry resume'
                          : 'Resume session'}
                  </button>
                  <button
                    onClick={handleDismissRecovery}
                    disabled={recoveringSession}
                    className="px-1.5 py-1 rounded text-red-200/60 hover:text-red-100 hover:bg-red-500/20 disabled:opacity-50 text-[13px] leading-none transition-colors"
                    title="Dismiss — this session doesn't need resuming"
                    aria-label="Dismiss resume offer"
                  >
                    ×
                  </button>
                </div>
              </div>
              {recoveryNotice && (
                <div className="mt-1 text-[11px] text-red-100/70">{recoveryNotice}</div>
              )}
            </div>
          )}
        </div>

        {/* ── Stuck alert ── */}
        {stuckAlert && (
          <div className="mx-3 mb-2 bg-amber-950/40 border border-amber-800 rounded px-3 py-2">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-amber-400 text-xs font-bold">!</span>
                <span className="text-amber-300 text-xs font-semibold">
                  {stuckAlert.severity === 'high' ? 'Stuck' : 'Possibly stuck'}
                </span>
              </div>
              <button
                onClick={() => onDismissStuck(agent.id)}
                className="text-gray-500 hover:text-gray-300 text-[13px]"
              >
                dismiss
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-1.5">{stuckAlert.pattern}</p>
            <button
              onClick={() => onSendCommand(agent.id, stuckAlert.suggestion)}
              className="px-2 py-0.5 bg-amber-800 hover:bg-amber-700 text-white text-[13px] rounded transition-colors"
            >
              Send Hint
            </button>
          </div>
        )}

        {/* ── Permission cards ── */}
        {permissions.length > 0 && (
          <div className="mx-3 mb-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-yellow-400">
              <div className="w-1.5 h-1.5 bg-yellow-500 animate-pulse" />
              Pending ({permissions.length})
            </div>
            {permissions.map((perm) => {
              if (perm.toolName === 'AskUserQuestion') {
                return <QuestionAnswerCard key={perm.id} permission={perm} onDecide={onDecidePermission} />;
              }
              if (perm.toolName === 'ExitPlanMode') {
                return <PlanApprovalCard key={perm.id} permission={perm} onDecide={onDecidePermission} />;
              }
              return (
                <InlinePermission
                  key={perm.id}
                  permission={perm}
                  onAllow={() => onDecidePermission(perm.id, 'allowed')}
                  onDeny={() => onDecidePermission(perm.id, 'denied')}
                />
              );
            })}
          </div>
        )}

        {/* ── Command input ── */}
        <div className="mx-3 mb-2">
          {multiTool && (
            <div className="mb-1 text-[11px] text-gray-500 flex items-center gap-1 flex-wrap">
              <span>Sending to</span>
              {sendTargets.map((t) => {
                const m = toolMeta(t.agentType);
                return <span key={t.id} className={`px-1 py-0.5 rounded font-medium ${m.badge}`}>{m.label}</span>;
              })}
              <span className="text-gray-600">— tap a tool above to include or exclude</span>
            </div>
          )}
          <CommandInput
            // Keyed on the cartridge (not the focused tool) so toggling send targets never
            // wipes what you're typing. History follows the focused tool via agentId.
            // Must be machine:repoName, not agent.id — `agent` is the primary, which changes
            // whenever a sibling's status outranks it (e.g. a live log line makes it 'working').
            key={`${agent.machine}:${agent.repoName}`}
            agentId={selectedAgent.id}
            mode={selectedAgent.mode}
            placeholder={effectiveStatus === 'waiting'
              ? 'Answer or instruct...'
              : effectiveStatus === 'offline'
                ? 'Offline - will queue...'
                : multiTool
                  ? `Send to ${sendLabel}...`
                  : 'Send prompt or /command...'}
            onSend={(text, attachments) => {
              // Fan out to every selected engine. Each gets its OWN plan-mode suffix based on
              // that engine's mode, so a mixed selection behaves correctly per-tool.
              const targets = sendTargets.length > 0 ? sendTargets : [agent];
              for (const t of targets) {
                const planSuffix = t.mode === 'plan'
                  ? '\n\nIMPORTANT: Enter plan mode first. Use the EnterPlanMode tool to create an implementation plan and get my approval before writing any code.'
                  : '';
                onSendCommand(t.id, text + planSuffix, true, attachments);
              }
            }}
          />
        </div>


        {/* ── Mode selector + Plans toggle — apply to EVERY selected engine, not just the
             focused one, so you can flip Plan/Manual/Trust across a multi-engine selection in
             one click. The buttons reflect the focused engine's current mode. ── */}
        <div className="mx-3 mb-2 flex items-center justify-between gap-2">
          <AgentModeSelector
            mode={selectedAgent.mode}
            onSetMode={(mode) => {
              const targets = sendTargets.length > 0 ? sendTargets : [selectedAgent];
              for (const t of targets) onSetMode(t.id, mode);
            }}
          />
          {selectedAgent.mode === 'trust' && (
            <button
              onClick={() => {
                const targets = sendTargets.length > 0 ? sendTargets : [selectedAgent];
                const next = !selectedAgent.plansIncluded;
                for (const t of targets) api.setPlansIncluded(t.id, next);
              }}
              title={selectedAgent.plansIncluded ? 'Plans auto-approved (click to require review)' : 'Plans require review (click to auto-approve)'}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
                selectedAgent.plansIncluded
                  ? 'bg-violet-900/60 border-violet-600/60 text-violet-300 hover:bg-violet-800/60'
                  : 'bg-gray-800/60 border-gray-600/40 text-gray-500 hover:bg-gray-700/60'
              }`}
            >
              <span>{selectedAgent.plansIncluded ? '✓' : '○'}</span>
              <span>Plans</span>
            </button>
          )}
        </div>
        {multiTool && sendTargets.length > 1 && (
          <div className="mx-3 -mt-1 mb-2 text-[11px] text-gray-600">
            Mode applies to all {sendTargets.length} selected engines.
          </div>
        )}

        {/* ── Terminal: recent activity + live log ── */}
        <div
          className="mx-3 mb-3 rounded overflow-hidden"
          style={{
            backgroundColor: '#0d0d14',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {/* Header */}
          <div className="px-2 py-1 flex items-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span className="text-[13px] font-mono text-green-400">Live Log</span>
            {effectiveStatus === 'working' && (
              <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            )}
            <span className="text-[13px] text-gray-700 font-mono ml-auto">{activities.length}</span>
          </div>

          <div
            ref={logScrollRef}
            className="overflow-y-auto font-mono text-[13px] leading-relaxed"
            style={{ maxHeight: '160px' }}
            onMouseEnter={() => { logHoveredRef.current = true; }}
            onMouseLeave={() => {
              logHoveredRef.current = false;
              if (logScrollRef.current) logScrollRef.current.scrollTop = 0;
            }}
          >
            {activities.length === 0 ? (
              <div className="px-2 py-3 text-gray-600 text-center text-[13px]">No activity yet</div>
            ) : (
              activities.map((act) => {
                // In a multi-tool cartridge the feed merges every tool's activity, so tag each
                // line with the tool that produced it (matched by agentId).
                const lineMeta = multiTool
                  ? toolMeta((tools.find((t) => t.id === act.agentId) || agent).agentType)
                  : null;
                return (
                  <div
                    key={act.id}
                    onClick={() => onActivityClick?.(act)}
                    className="px-2 py-0.5 hover:bg-white/[0.04] cursor-pointer truncate transition-colors"
                    title={`${lineMeta ? `[${lineMeta.short}] ` : ''}${act.toolName || act.eventType}: ${act.toolInput || ''}`}
                  >
                    <span className="text-gray-600 select-none text-[11px]">
                      {new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}{' '}
                    </span>
                    {lineMeta && (
                      <span className={`mr-1 px-1 rounded text-[10px] ${lineMeta.badge}`}>{lineMeta.short}</span>
                    )}
                    <span className="text-green-500">{act.toolName || act.eventType}</span>
                    {' '}
                    <span className="text-green-400/60">{briefSummary(act)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Git Panel Modal */}
      {gitOpen && <GitPanel agent={agent} onClose={() => setGitOpen(false)} />}

      {/* Journal / Session Memory Modal */}
      {journalOpen && agent.repoName && (
        <ProjectMemoryPanel project={agent.repoName} agents={allAgents} onClose={() => setJournalOpen(false)} />
      )}

      {/* Send Context Modal */}
      {contextOpen && agent.repoName && (
        <SendContextModal agentId={agent.id} project={agent.repoName} onClose={() => setContextOpen(false)} />
      )}
    </div>
  );
}
