import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { undeliveredNotice, type SendOutcome, type UndeliveredNotice } from '../lib/deliveryNotice';
import type { CartridgeProgress } from '../lib/cartridgeProgress';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, CommandAttachmentInput } from '../types';
import { AgentModeSelector } from './AgentModeSelector';
import { CommandInput } from './CommandInput';
import { GitPanel } from './GitPanel';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import SendContextModal from './SendContextModal';
import { FinalAnswerModal } from './FinalAnswerModal';
import { api } from '../lib/api';
import { BackgroundWork } from './BackgroundWork';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CartridgeCardProps {
  agent: Agent;
  /** The confer or run this cartridge is part of, as a real done/total — null draws no meter. */
  progress?: CartridgeProgress | null;
  siblingAgents?: Agent[];
  allAgents?: Agent[];
  activities: Activity[];
  permissions: PermissionRequest[];
  stuckAlert?: StuckAlert;
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean, attachments?: CommandAttachmentInput[]) => void | Promise<SendOutcome | null | void>;
  onDelete: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Night Glass status colours: blue = working, ember = needs you, grey = idle, red = offline.
const STATUS_CONFIG = {
  working: { dot: '#5AAEFF', pill: 'bg-neon-500/[0.18] text-neon-200', label: 'Working' },
  // Its turn ended but work it started is still running: active, in a calmer blue than working.
  background: { dot: '#7FB8E8', pill: 'bg-neon-500/[0.10] text-neon-200', label: 'Running in background' },
  idle: { dot: '#8A97B8', pill: 'bg-white/[0.07] text-gray-300', label: 'Idle' },
  waiting: { dot: '#FF8A3D', pill: 'bg-[#FF8A3D]/[0.14] text-ember-300', label: 'Waiting' },
  offline: { dot: '#FF6B6B', pill: 'bg-red-500/[0.12] text-red-300', label: 'Offline' },
} as const;

// The card's frame per state: working glows blue, waiting glows ember, everything else is quiet.
const CARD_FRAME = {
  working: 'border-[#5AAEFF]/[0.34] shadow-[0_0_26px_rgba(90,174,255,0.13)]',
  background: 'border-[#5AAEFF]/[0.22] shadow-[0_0_20px_rgba(90,174,255,0.08)]',
  waiting: 'border-[#FF8A3D]/[0.55] shadow-[0_0_26px_rgba(255,138,61,0.16)]',
  idle: 'border-[rgba(120,150,255,0.14)]',
  offline: 'border-[rgba(120,150,255,0.10)]',
} as const;

const SEG_CELLS = 24;

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
// `color` is the engine colour (Claude blue, Codex teal): an outlined pill on the
// card and the [engine] tag colour in the live log.
type ToolMeta = { label: string; short: string; badge: string; color: string };
function toolMeta(agentType: string): ToolMeta {
  switch (agentType) {
    case 'codex':     return { label: 'Codex CLI', short: 'Codex', badge: 'border border-[#2EE6D6]/60 text-[#2EE6D6]', color: '#2EE6D6' };
    default:          return { label: 'Claude CC', short: 'Claude', badge: 'border border-[#7CC4FF]/60 text-[#7CC4FF]', color: '#7CC4FF' };
  }
}

function launchTypeFor(agentType: string): string {
  switch (agentType) {
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
      <div className="rounded-xl border border-[#FF8A3D]/[0.35] bg-[#FF8A3D]/[0.08] px-3.5 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full bg-[#FF8A3D] shadow-[0_0_8px_#FF8A3D] animate-pulse" />
          <span className="text-ember-300 text-[12px] font-semibold uppercase tracking-[0.12em]">Question from Agent</span>
        </div>
        <p className="text-[14px] text-gray-200">{permission.description}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#FF8A3D]/[0.35] bg-[#FF8A3D]/[0.08] px-3.5 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[#FF8A3D] shadow-[0_0_8px_#FF8A3D] animate-pulse" />
        <span className="text-ember-300 text-[12px] font-semibold uppercase tracking-[0.12em]">Question from Agent</span>
      </div>
      {questions.map((q, qi) => {
        const key = questionKey(q, qi);
        const sel = selections[key];
        return (
          <div key={qi}>
            {q.header && <div className="text-[11px] text-gray-500 uppercase tracking-[0.12em] mb-0.5">{q.header}</div>}
            <p className="text-[14px] font-semibold text-gray-100 mb-2">{q.question}</p>
            {q.options && q.options.length > 0 && !showCustom[key] && (
              <div className="flex flex-col gap-1.5">
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
                      className={`min-h-[40px] px-3 text-left text-[14px] rounded-[10px] transition-colors border bg-[#04081A]/80 ${
                        isSelected
                          ? 'text-gray-50 border-[#FF8A3D]/70 shadow-[0_0_12px_rgba(255,138,61,0.2)]'
                          : 'text-gray-200 border-white/[0.14] hover:border-[#FF8A3D]/50'
                      }`}
                      title={opt.description || ''}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: true }))}
                  className="min-h-[40px] px-3 text-left text-[14px] rounded-[10px] transition-colors border border-dashed border-white/[0.18] text-gray-400 hover:text-gray-200"
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
                  className="flex-1 glass-input text-gray-100 text-[14px] rounded-[10px] h-10 px-3 focus:outline-none"
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
          className="w-full h-10 rounded-[10px] border border-[#FF8A3D]/70 bg-[#FF8A3D]/[0.18] hover:bg-[#FF8A3D]/[0.26] text-[#FFE2CC] text-[14px] font-semibold transition-colors"
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
    <div className="rounded-xl border border-[#FFC44D]/50 bg-[#FFC44D]/[0.06] px-3.5 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-[#FFC44D] shadow-[0_0_8px_#FFC44D] animate-pulse" />
        <span className="text-[#FFD27A] text-[12px] font-semibold uppercase tracking-[0.12em]">Plan Ready for Review</span>
      </div>
      {allowedPrompts.length > 0 && (
        <div className="mb-2 space-y-0.5">
          <span className="text-[13px] text-gray-400">Requested permissions:</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="text-[12px] text-gray-300 font-mono pl-2 border-l border-[#FFC44D]/40">
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
            className="w-full glass-input text-gray-100 text-[14px] rounded-[10px] px-3 py-2 resize-none h-16 focus:outline-none"
            autoFocus
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                onDecide(permission.id, 'denied', feedback.trim() ? { feedback: feedback.trim() } : undefined);
              }}
              className="h-10 px-4 rounded-[10px] border border-red-400/50 bg-red-500/10 hover:bg-red-500/20 text-red-200 text-[13px] font-semibold transition-colors"
            >
              Confirm Reject
            </button>
            <button
              onClick={() => setShowReject(false)}
              className="h-10 px-3 text-gray-400 hover:text-gray-200 text-[13px]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDecide(permission.id, 'allowed')}
            className="flex-1 h-10 rounded-[10px] border border-green-400/60 bg-green-400/[0.14] hover:bg-green-400/[0.22] text-[#C8F7D8] text-[13px] font-semibold transition-colors"
          >
            Approve Plan
          </button>
          <button
            onClick={() => setShowReject(true)}
            className="flex-1 h-10 rounded-[10px] border border-red-400/45 hover:bg-red-500/10 text-red-200 text-[13px] font-semibold transition-colors"
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
    <div className="flex items-center justify-between rounded-xl bg-[#050913] border border-white/[0.14] px-3.5 py-2.5 gap-2">
      <div className="flex-1 min-w-0">
        <span className="text-[#FF9ACB] text-[13px] font-mono">{permission.toolName}</span>
        <p className="text-gray-300 text-[13px] truncate" title={permission.description}>
          {permission.description}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onAllow}
          className="h-9 px-3 rounded-[9px] border border-green-400/60 bg-green-400/[0.12] hover:bg-green-400/[0.2] text-[#C8F7D8] text-[13px] font-semibold transition-colors"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="h-9 px-3 rounded-[9px] border border-red-400/45 hover:bg-red-500/10 text-red-200 text-[13px] font-semibold transition-colors"
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
  progress = null,
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
  // Prompts the server stored with no session listening (transport "no-channel") — shown, not swallowed.
  const [undelivered, setUndelivered] = useState<UndeliveredNotice[]>([]);
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

  // The tools available in this cartridge (primary first, then siblings) — same
  // order as the badge row. Each is a separate agent with its own agentType.
  const tools = useMemo(
    () => [agent, ...(siblingAgents || [])],
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

  const [gitOpen, setGitOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
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

  // The card's frame: a stuck cartridge reads as needing you, like a waiting one.
  const frame = stuckAlert ? CARD_FRAME.waiting : CARD_FRAME[effectiveStatus];
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

  // The meter shows the PROGRESS of the work this cartridge is part of (a confer's milestones, a
  // run's steps) — never activity. No work with a done/total, no meter.
  const litCells = progress && progress.total > 0
    ? Math.round((SEG_CELLS * Math.min(progress.done, progress.total)) / progress.total)
    : 0;
  const segColor = effectiveStatus === 'waiting' || stuckAlert ? '#FF8A3D' : effectiveStatus === 'working' || effectiveStatus === 'background' ? '#5AAEFF' : '#8A97B8';

  const iconBtn = 'w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/[0.06] transition-colors';
  const costLabel = costUsd !== null && costUsd > 0 ? (costUsd >= 1 ? `$${costUsd.toFixed(2)}` : `$${costUsd.toFixed(3)}`) : '';
  const tokLabel = tokenTotal !== null && tokenTotal > 0 ? `~${tokenTotal >= 1000 ? `${(tokenTotal / 1000).toFixed(1)}k` : tokenTotal} tok` : '';

  return (
    <div className="relative flex flex-col">
      <div
        className={`rounded-[18px] border bg-[rgba(12,18,34,0.72)] p-[18px] flex flex-col gap-3 transition-colors ${frame}`}
      >
        {/* ── Header: repo, branch · machine, and the card's tools ── */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex flex-col gap-1">
            <h3 className="font-mono text-base font-semibold text-gray-100 truncate">
              {agent.repoName || 'UNKNOWN'}
            </h3>
            <span className="text-[12px] text-gray-500 truncate" title={`Branch: ${agent.branch || 'n/a'}`}>
              {agent.branch || 'n/a'} · {shortMachine(agent.machine)}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setAnswerOpen(true)}
              className={iconBtn}
              title="Read the agent's full final answer"
              aria-label="Final answer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" />
              </svg>
            </button>
            <button
              onClick={() => setJournalOpen(true)}
              className={iconBtn}
              title="Project journal & session memory"
              aria-label="Project memory"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h11" />
              </svg>
            </button>
            <button
              onClick={() => setGitOpen(true)}
              className={iconBtn}
              title="Git worktrees & status"
              aria-label="Git"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 8v8M18 11c0 4-6 3-10 6" />
              </svg>
            </button>
            <button
              onClick={() => setContextOpen(true)}
              className={iconBtn}
              title="Send project context to agent"
              aria-label="Send context"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2-7z" />
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
              className={`${iconBtn} hover:!text-red-300`}
              title="Delete cartridge and all its history (permanent)"
              aria-label="Delete cartridge"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
            {/* Dismiss — "I'm done with this one for now." Does NOT stop the agent or end the
                session; it just puts the card away. It reappears the moment the agent does
                anything, or you send it a command / launch a workflow. */}
            <button
              onClick={() => onDismiss(agent.id)}
              className={`${iconBtn} text-base`}
              title="Put away — reappears as soon as this agent is used again"
              aria-label="Put away"
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Pills: status, engine(s), origin; then age · cost ── */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full ${status.pill}`}>
            <span
              className={`w-[7px] h-[7px] rounded-full ${effectiveStatus === 'working' || effectiveStatus === 'waiting' || effectiveStatus === 'background' ? 'animate-pulse' : ''}`}
              style={{ background: status.dot, boxShadow: `0 0 8px ${status.dot}` }}
            />
            {status.label}
          </span>
          {/* Tool badges — primary first, then others. When more than one tool is running in
              this repo, the badges are a multi-select send target: all start selected, so a
              prompt fans out to every engine; tap one to exclude it (tap again to re-include).
              With a single tool they're plain labels. */}
          {tools.map((a) => {
            const meta = toolMeta(a.agentType);
            const isSelected = selectedToolIds.has(a.id);
            if (!multiTool) {
              return (
                <span key={a.id} className={`text-[12px] px-2.5 py-[3px] rounded-full font-semibold ${meta.badge}`}>
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
                className={`text-[12px] px-2.5 py-[3px] rounded-full font-semibold transition-all ${meta.badge} ${
                  isSelected ? 'opacity-100' : 'opacity-35 hover:opacity-70'
                }`}
                style={isSelected ? { background: `${meta.color}24` } : undefined}
              >
                {isSelected ? '✓ ' : ''}{meta.label}
              </button>
            );
          })}
          {/*
            Which SERVER this cartridge came from — shown only when it is not the local
            one. In a merged grid two machines can run the same repo on the same branch,
            and without this the two cards are indistinguishable.
          */}
          {originName && (
            <span
              className="text-[11px] text-neon-300 border border-neon-400/30 bg-neon-500/10 px-2 py-0.5 rounded-full truncate max-w-[10rem]"
              title={`Served by ${originName}`}
            >
              {originName}
            </span>
          )}
          <span className="text-[12px] text-gray-500 truncate" title="Total tokens consumed (input + output); cost includes cache">
            {timeAgo(agent.lastSeen)}
            {costLabel && <> · <span className="text-gray-400">{costLabel}</span></>}
            {tokLabel && <> · {tokLabel}</>}
          </span>
        </div>

        {/* What it is working on — the objective, when the cartridge has one. */}
        {selectedAgent.activeObjective && !shouldOfferSessionRecovery && selectedAgent.standardState !== 'needs_review' && (
          <p className="text-[14px] leading-relaxed text-gray-300 line-clamp-2">{selectedAgent.activeObjective}</p>
        )}

        {/* ── Progress of the work it is part of ── */}
        {progress && progress.total > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="text-gray-400 truncate">
                {progress.label}{progress.waitingOnOthers ? ' · done, waiting on the others' : ''}
              </span>
              <span className="font-mono text-gray-300 flex-shrink-0">{Math.min(progress.done, progress.total)}/{progress.total}</span>
            </div>
            <div
              className="flex gap-[3px]"
              role="img"
              aria-label={`${progress.label}: ${Math.min(progress.done, progress.total)} of ${progress.total} ${progress.kind === 'confer' ? 'milestones' : 'steps'} done`}
            >
              {Array.from({ length: SEG_CELLS }).map((_, i) => (
                <span
                  key={i}
                  className="flex-1 h-[5px] rounded-[2px]"
                  style={i < litCells
                    ? { background: segColor, boxShadow: `0 0 5px ${segColor}` }
                    : { background: 'rgba(120,150,255,0.12)' }}
                />
              ))}
            </div>
          </div>
        )}

        {/* A question the agent asked and is waiting on. Previously the web showed nothing
            at all for this — only mobile did — so a cartridge could sit blocked on a
            question you would never see unless you opened its terminal. */}
        {selectedAgent.status === 'waiting' && selectedAgent.pendingQuestion && (
          <div className="rounded-xl border border-[#FF8A3D]/[0.35] bg-[#FF8A3D]/[0.08] px-3.5 py-3">
            <div className="text-[14px] text-ember-300 font-semibold">Waiting on your answer</div>
            <div className="text-[13px] text-gray-200 mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {selectedAgent.pendingQuestion.slice(0, 400)}
            </div>
            <div className="text-[12px] text-gray-400 mt-1.5">Reply in the prompt box below.</div>
          </div>
        )}

        {selectedAgent.standardState === 'needs_review' && (
          <div className="rounded-xl border border-red-400/[0.35] bg-red-500/[0.08] px-3.5 py-3 flex flex-col gap-2">
            <div className="text-[14px] text-[#FFC9C9] font-semibold">
              Stopped without a completion report
            </div>
            <div className="text-[13px] text-gray-300 leading-relaxed">
              {selectedAgent.activeObjective || 'The task may be only partially done — check before trusting it.'}
            </div>
            <button
              onClick={handleClearStandardReview}
              className="self-start h-10 px-4 rounded-[10px] border border-red-400/55 hover:bg-red-500/10 text-[#FFC9C9] text-[13px] font-semibold transition-colors"
              title="Mark as reviewed — clears the flag"
            >
              Reviewed
            </button>
          </div>
        )}

        {shouldOfferSessionRecovery && (
          <div className="rounded-xl border border-neon-500/[0.35] bg-neon-600/[0.08] px-3.5 py-3 flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[14px] text-gray-100 font-semibold">
                  {selectedAgent.recoveryStatus === 'interrupted' || selectedAgent.recoveryStatus === 'recovery_failed'
                    ? 'Session interrupted'
                    : 'Last session available'}
                </div>
                {selectedAgent.activeObjective && (
                  <div className="text-[13px] text-gray-300 truncate mt-0.5">
                    {selectedAgent.activeObjective}
                  </div>
                )}
              </div>
              <button
                onClick={handleDismissRecovery}
                disabled={recoveringSession}
                className="w-8 h-8 shrink-0 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/[0.06] disabled:opacity-50 text-base leading-none transition-colors"
                title="Dismiss — this session doesn't need resuming"
                aria-label="Dismiss resume offer"
              >
                ×
              </button>
            </div>
            <button
              onClick={handleRecoverSession}
              disabled={recoveringSession || !selectedAgent.repoPath}
              className="btn-primary h-10 rounded-[10px] text-[14px] font-semibold disabled:opacity-50 transition-colors"
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
            {recoveryNotice && (
              <div className="text-[12px] text-gray-300">{recoveryNotice}</div>
            )}
          </div>
        )}

        {/* ── Stuck alert ── */}
        {stuckAlert && (
          <div className="rounded-xl border border-[#FFC44D]/[0.35] bg-[#FFC44D]/[0.08] px-3.5 py-3 flex items-center justify-between gap-2.5">
            <div className="min-w-0 flex flex-col gap-0.5">
              <span className="text-[14px] text-gray-100 font-semibold">
                {stuckAlert.severity === 'high' ? 'Stuck' : 'Possibly stuck'}
              </span>
              <p className="text-[13px] text-gray-300">{stuckAlert.pattern}</p>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <button
                onClick={() => onSendCommand(agent.id, stuckAlert.suggestion)}
                className="h-9 px-3 rounded-[10px] border border-[#FFC44D]/55 hover:bg-[#FFC44D]/10 text-[#FFE7B0] text-[13px] font-semibold transition-colors"
              >
                Send Hint
              </button>
              <button
                onClick={() => onDismissStuck(agent.id)}
                className="text-gray-500 hover:text-gray-300 text-[12px]"
              >
                dismiss
              </button>
            </div>
          </div>
        )}

        {/* ── Permission cards ── */}
        {permissions.length > 0 && (
          <div className="space-y-2">
            <div className="text-[12px] uppercase tracking-[0.12em] text-gray-400">
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

        <BackgroundWork agent={{ status: effectiveStatus, background: agent.background }} now={tick} />

        {/* ── Live log ── */}
        <div className="cartridge-terminal overflow-hidden">
          <div className="px-3 pt-2 pb-1 flex items-center gap-2">
            <span className="text-[11px] font-sans uppercase tracking-[0.14em] text-neon-300">Live Log</span>
            {effectiveStatus === 'working' && (
              <span className="inline-block w-[7px] h-[7px] rounded-full bg-neon-500 shadow-[0_0_8px_#5AAEFF] animate-pulse" />
            )}
            <span className="text-[11px] text-gray-500 ml-auto">{activities.length}</span>
          </div>
          <div
            ref={logScrollRef}
            className="overflow-y-auto pb-1.5"
            style={{ maxHeight: '132px' }}
            onMouseEnter={() => { logHoveredRef.current = true; }}
            onMouseLeave={() => {
              logHoveredRef.current = false;
              if (logScrollRef.current) logScrollRef.current.scrollTop = 0;
            }}
          >
            {activities.length === 0 ? (
              <div className="px-3 py-2.5 text-gray-500 text-[12px]">No activity yet</div>
            ) : (
              activities.map((act) => {
                // Every line is tagged with the engine that produced it (matched by agentId),
                // in that engine's colour — the merged feed of a multi-tool cartridge reads
                // the same way as a single one.
                const lineMeta = toolMeta((tools.find((t) => t.id === act.agentId) || agent).agentType);
                return (
                  <div
                    key={act.id}
                    onClick={() => onActivityClick?.(act)}
                    className="px-3 py-px hover:bg-white/[0.04] cursor-pointer truncate transition-colors text-gray-300"
                    title={`[${lineMeta.short}] ${act.toolName || act.eventType}: ${act.toolInput || ''}`}
                  >
                    <span className="text-gray-500 select-none">
                      {new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}{' '}
                    </span>
                    <span style={{ color: lineMeta.color }}>[{lineMeta.short.toLowerCase()}]</span>
                    {' '}
                    <span className="text-gray-100">{act.toolName || act.eventType}</span>
                    {' '}
                    <span className="text-gray-400">{briefSummary(act)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Command input ── */}
        <div>
          {multiTool && (
            <div className="mb-1.5 text-[12px] text-gray-500 flex items-center gap-1 flex-wrap">
              <span>Sending to</span>
              {sendTargets.map((t) => {
                const m = toolMeta(t.agentType);
                return <span key={t.id} className={`px-1.5 py-px rounded-full font-semibold ${m.badge}`}>{m.label}</span>;
              })}
              <span>— tap a tool above to include or exclude</span>
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
                // The server's answer says whether any session took it; "no-channel" means
                // none did, and the card says so instead of looking sent.
                Promise.resolve(onSendCommand(t.id, text + planSuffix, true, attachments)).then((o) => {
                  const n = undeliveredNotice(t, o || null);
                  setUndelivered((prev) => n ? [...prev.filter((x) => x.agentId !== n.agentId), n] : prev.filter((x) => x.agentId !== t.id));
                }).catch(() => {});
              }
            }}
          />
          {undelivered.map((n) => (
            <div key={n.agentId} role="alert" className="mt-2 rounded-[12px] border border-ember-500/50 bg-ember-500/[0.08] px-3 py-2.5 text-[12px] text-ember-300">
              <div className="flex items-start justify-between gap-2">
                <p>
                  <span className="font-semibold">Not delivered</span> — {n.who} isn&rsquo;t listening for prompts. It was started
                  without the NeonCore relay, so the prompt is stored and nothing reads it.
                  {n.relaunch ? ' Quit that session and relaunch it from its terminal:' : ' Relaunch it under the relay to receive prompts.'}
                </p>
                <button type="button" onClick={() => setUndelivered((prev) => prev.filter((x) => x.agentId !== n.agentId))}
                  className="text-gray-400 hover:text-gray-200 font-semibold">Dismiss</button>
              </div>
              {n.relaunch && (
                <code className="mt-1.5 block select-all break-all rounded-[8px] bg-ink/80 border border-white/[0.08] px-2 py-1.5 font-mono text-[11px] text-gray-200">{n.relaunch}</code>
              )}
            </div>
          ))}
        </div>

        {/* ── Mode selector + Plans toggle — apply to EVERY selected engine, not just the
             focused one, so you can flip Plan/Manual/Trust across a multi-engine selection in
             one click. The buttons reflect the focused engine's current mode. ── */}
        <div className="flex items-center justify-between gap-2">
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
              aria-pressed={!!selectedAgent.plansIncluded}
              className={`flex items-center gap-1.5 h-8 px-3 rounded-[9px] text-[12px] font-semibold border transition-colors ${
                selectedAgent.plansIncluded
                  ? 'border-neon-500/60 bg-neon-500/15 text-neon-200'
                  : 'border-white/[0.14] text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>{selectedAgent.plansIncluded ? '✓' : '○'}</span>
              <span>Plans</span>
            </button>
          )}
        </div>
        {multiTool && sendTargets.length > 1 && (
          <div className="-mt-1.5 text-[12px] text-gray-500">
            Mode applies to all {sendTargets.length} selected engines.
          </div>
        )}
      </div>

      {/* The agent's full final answer */}
      {answerOpen && <FinalAnswerModal agentId={agent.id} name={agent.repoName || agent.name} onClose={() => setAnswerOpen(false)} />}

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
