import { useState, useRef, useEffect, useCallback } from 'react';
import { focusIfIdle } from '../lib/focus';
import type { PermissionRequest, StuckAlert, Agent, WorkflowNotification } from '../types';

interface Props {
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  workflowNotifications: WorkflowNotification[];
  agents: Agent[];
  onDecide: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onDismissStuck: (agentId: string) => void;
  onDismissWorkflow: (id: string) => void;
}

function agentLabel(agentId: string, agents: Agent[]): string {
  const a = agents.find((ag) => ag.id === agentId);
  return a?.repoName || a?.name || agentId.slice(0, 8);
}

const isQuestionTool = (toolName: string) => toolName === 'AskUserQuestion';

function PermissionItem({
  perm,
  agents,
  onDecide,
}: {
  perm: PermissionRequest;
  agents: Agent[];
  onDecide: Props['onDecide'];
}) {
  const [response, setResponse] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Questions arrive on their own (and auto-open the panel) — don't steal the caret.
  useEffect(() => {
    if (isQuestionTool(perm.toolName)) focusIfIdle(inputRef.current);
  }, [perm.toolName]);
  const isQuestion = isQuestionTool(perm.toolName);
  const isPlan = perm.toolName === 'ExitPlanMode';
  const label = agentLabel(perm.agentId, agents);

  const handleAllow = useCallback(() => {
    onDecide(perm.id, 'allowed', isQuestion ? { response } : undefined);
  }, [perm.id, isQuestion, response, onDecide]);

  const handleDeny = useCallback(() => {
    onDecide(perm.id, 'denied');
  }, [perm.id, onDecide]);

  return (
    <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.07] space-y-2">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              isQuestion ? 'bg-blue-500/20 text-blue-400' :
              isPlan    ? 'bg-amber-500/20 text-amber-400' :
                          'bg-gl-pink/20 text-gl-pink'
            }`}>
              {isQuestion ? 'Question' : isPlan ? 'Plan Ready' : perm.toolName}
            </span>
            <span className="text-[11px] text-gray-500 truncate">{label}</span>
          </div>
          {perm.description && (
            <p className="text-xs text-gray-300 mt-1 leading-snug line-clamp-3">{perm.description}</p>
          )}
        </div>
      </div>

      {/* Response input for AskUserQuestion */}
      {isQuestion && (
        <input
          ref={inputRef}
          type="text"
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAllow(); }}
          placeholder="Type your answer…"
          className="w-full text-xs glass-input text-gray-200 rounded px-2.5 py-1.5 focus:outline-none placeholder-gray-600"
        />
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5">
        <button
          onClick={handleAllow}
          disabled={isQuestion && !response.trim()}
          className="flex-1 text-xs font-medium px-2.5 py-1.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/20 disabled:opacity-40 transition-colors"
        >
          {isQuestion ? 'Send' : isPlan ? 'Approve' : 'Allow'}
        </button>
        <button
          onClick={handleDeny}
          className="flex-1 text-xs font-medium px-2.5 py-1.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function StuckItem({
  alert,
  agents,
  onDismiss,
}: {
  alert: StuckAlert;
  agents: Agent[];
  onDismiss: (agentId: string) => void;
}) {
  const label = agentLabel(alert.agentId, agents);
  return (
    <div
      onClick={() => onDismiss(alert.agentId)}
      className="p-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/20 space-y-2 cursor-pointer hover:bg-amber-500/[0.12] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-500/20 text-amber-400">
              Stuck
            </span>
            <span className="text-[11px] text-gray-500 truncate">{label}</span>
          </div>
          <p className="text-xs text-gray-300 mt-1 leading-snug line-clamp-2">{alert.pattern}</p>
          {alert.suggestion && (
            <p className="text-[11px] text-gray-500 mt-1 leading-snug line-clamp-2">{alert.suggestion}</p>
          )}
        </div>
      </div>
      <div className="text-center text-[10px] text-gray-500/80">Click to dismiss</div>
    </div>
  );
}

function WorkflowNotificationItem({
  notification: n,
  onDismiss,
}: {
  notification: WorkflowNotification;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      onClick={() => onDismiss(n.id)}
      className="p-3 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20 space-y-2 cursor-pointer hover:bg-emerald-500/[0.12] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-500/20 text-emerald-400">
              Workflow Done
            </span>
            {n.projects.map((p) => (
              <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400">
                {p}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-300 mt-1 font-medium leading-snug">{n.title}</p>
          {n.body && n.body !== n.title && (
            <p className="text-[11px] text-gray-500 mt-0.5 leading-snug line-clamp-2">{n.body}</p>
          )}
        </div>
      </div>
      <div className="text-center text-[10px] text-gray-500/80">Click to dismiss</div>
    </div>
  );
}

export function NotificationCenter({ pendingPermissions, stuckAlerts, workflowNotifications, agents, onDecide, onDismissStuck, onDismissWorkflow }: Props) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const total = pendingPermissions.length + stuckAlerts.length + workflowNotifications.length;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Auto-open only for actionable items (permissions + stuck) — not passive workflow completions
  const actionableCount = pendingPermissions.length + stuckAlerts.length;
  useEffect(() => {
    if (actionableCount > 0) setOpen(true);
  }, [actionableCount]);

  // Auto-close when the last notification is cleared so the panel doesn't linger
  // empty. Only on the >0 → 0 transition, so the bell can still open an empty panel.
  const prevTotal = useRef(total);
  useEffect(() => {
    if (prevTotal.current > 0 && total === 0) setOpen(false);
    prevTotal.current = total;
  }, [total]);

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`relative p-1.5 rounded-md transition-colors ${
          total > 0
            ? 'text-gl-pink hover:text-white'
            : 'text-gray-500 hover:text-gray-300'
        }`}
        title="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>

        {/* Badge */}
        {total > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-gl-pink text-white text-[9px] font-bold px-1 animate-pulse">
            {total}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-80 glass-dark rounded-xl border border-white/10 shadow-2xl z-50 flex flex-col max-h-[70vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.06] shrink-0">
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
              Notifications
              {total > 0 && (
                <span className="ml-2 text-[10px] bg-gl-pink/20 text-gl-pink px-1.5 py-0.5 rounded-full">{total}</span>
              )}
            </span>
            <button onClick={() => setOpen(false)} className="text-gray-600 hover:text-white text-sm leading-none">&times;</button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {total === 0 && (
              <div className="text-center py-8 text-gray-600 text-xs">
                No pending notifications
              </div>
            )}

            {/* Stuck alerts — highest priority */}
            {stuckAlerts.map((alert) => (
              <StuckItem
                key={alert.agentId}
                alert={alert}
                agents={agents}
                onDismiss={onDismissStuck}
              />
            ))}

            {/* Pending permissions */}
            {pendingPermissions.map((perm) => (
              <PermissionItem
                key={perm.id}
                perm={perm}
                agents={agents}
                onDecide={onDecide}
              />
            ))}

            {/* Workflow completions */}
            {workflowNotifications.map((n) => (
              <WorkflowNotificationItem
                key={n.id}
                notification={n}
                onDismiss={onDismissWorkflow}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
