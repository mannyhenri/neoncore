import { useState, useRef, useEffect, useCallback } from 'react';
import { focusIfIdle } from '../lib/focus';
import type { PermissionRequest, StuckAlert, Agent, WorkflowNotification, NeedsYouItem } from '../types';
import { projectHash, UNFILED } from '../lib/projectSelection';

interface Props {
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  workflowNotifications: WorkflowNotification[];
  /**
   * Everything waiting on the person right now, from the server's state (GET /needs-you) — not
   * events. It stays until the thing is done, whether or not the bell saw it happen.
   */
  needsYou?: NeedsYouItem[];
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
    <div className={`p-3.5 rounded-xl border space-y-2.5 ${isPlan ? 'bg-amber-400/[0.06] border-amber-400/35' : 'bg-neon-500/[0.07] border-neon-500/35'}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
              isQuestion ? 'bg-neon-500/20 text-neon-200' :
              isPlan    ? 'bg-amber-400/20 text-amber-200' :
                          'bg-gl-pink/20 text-gl-pink'
            }`}>
              {isQuestion ? 'Question' : isPlan ? 'Plan Ready' : perm.toolName}
            </span>
            <span className="text-[13px] font-mono text-gray-300 truncate">{label}</span>
          </div>
          {perm.description && (
            <p className="text-sm text-gray-100 mt-1.5 leading-snug line-clamp-3">{perm.description}</p>
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
          className="w-full h-10 text-[13px] glass-input text-gray-100 rounded-[9px] px-3 focus:outline-none placeholder-gray-500"
        />
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleAllow}
          disabled={isQuestion && !response.trim()}
          className="flex-1 h-10 text-[13px] font-semibold px-3 rounded-[9px] bg-emerald-400/[0.12] text-emerald-200 hover:bg-emerald-400/20 border border-emerald-400/55 disabled:opacity-40 transition-colors"
        >
          {isQuestion ? 'Send' : isPlan ? 'Approve' : 'Allow'}
        </button>
        <button
          onClick={handleDeny}
          className="flex-1 h-10 text-[13px] font-semibold px-3 rounded-[9px] bg-transparent text-red-300 hover:bg-red-500/10 border border-red-400/45 transition-colors"
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
      className="p-3.5 rounded-xl bg-gl-code border border-amber-400/30 space-y-2 cursor-pointer hover:bg-amber-400/[0.06] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-amber-400/20 text-amber-200">
              Stuck
            </span>
            <span className="text-[13px] font-mono text-gray-300 truncate">{label}</span>
          </div>
          <p className="text-[13px] text-gray-300 mt-1.5 leading-snug line-clamp-2">{alert.pattern}</p>
          {alert.suggestion && (
            <p className="text-[11px] text-gray-500 mt-1 leading-snug line-clamp-2">{alert.suggestion}</p>
          )}
        </div>
      </div>
      <div className="text-[11px] text-gray-500">Click to dismiss</div>
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
      className="p-3.5 rounded-xl bg-gl-code border border-emerald-400/30 space-y-2 cursor-pointer hover:bg-emerald-400/[0.06] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-emerald-400/20 text-emerald-200">
              Workflow Done
            </span>
            {n.projects.map((p) => (
              <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400">
                {p}
              </span>
            ))}
          </div>
          <p className="text-[13px] text-gray-100 mt-1.5 font-semibold leading-snug">{n.title}</p>
          {n.body && n.body !== n.title && (
            <p className="text-[11px] text-gray-500 mt-0.5 leading-snug line-clamp-2">{n.body}</p>
          )}
        </div>
      </div>
      <div className="text-[11px] text-gray-500">Click to dismiss</div>
    </div>
  );
}

const NEEDS_YOU_LABEL: Record<NeedsYouItem['kind'], string> = {
  questions: 'Questions', plan: 'Plan', start: 'Start', tests: 'Tests', checklist: 'Checklist', cartridge: 'Cartridge',
  stopped: 'Stopped', run: 'Waiting', 'mark-done': 'Done?', 'merge-blocked': 'Merge', 'merge-yourself': 'Merge',
};

function NeedsYouRow({ item, onOpen }: { item: NeedsYouItem; onOpen: () => void }) {
  const link = !!item.goalId;
  return (
    <button type="button" onClick={onOpen} disabled={!link} data-testid="needs-you-item"
      className="w-full text-left p-3.5 rounded-xl border bg-ember-500/[0.07] border-ember-500/35 hover:bg-ember-500/[0.12] disabled:cursor-default">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-ember-500/20 text-ember-200">{NEEDS_YOU_LABEL[item.kind]}</span>
        <span className="text-[13px] text-gray-100 font-semibold truncate">{item.title}</span>
      </div>
      <p className="text-[12px] text-gray-300 mt-1.5 leading-snug line-clamp-4">{item.what}</p>
    </button>
  );
}

/** Open the feature the item is about. A run that is no feature's says what to do in its line. */
function openNeedsYou(item: NeedsYouItem): void {
  if (item.goalId) window.location.hash = projectHash(item.projectId || UNFILED, item.goalId);
}

export function NotificationCenter({ pendingPermissions, stuckAlerts, workflowNotifications, needsYou = [], agents, onDecide, onDismissStuck, onDismissWorkflow }: Props) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const total = needsYou.length + pendingPermissions.length + stuckAlerts.length + workflowNotifications.length;

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
        className={`relative w-10 h-10 flex items-center justify-center rounded-[10px] border transition-colors ${
          total > 0
            ? 'border-ember-500/50 bg-ember-500/10 text-ember-300 hover:bg-ember-500/20'
            : 'border-white/[0.12] text-gray-400 hover:text-gray-100'
        }`}
        title="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>

        {/* Badge */}
        {total > 0 && (
          <span className="absolute -top-[5px] -right-[5px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-ember-500 text-[#1A0A00] text-[11px] font-bold px-1">
            {total}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-[380px] glass-dark rounded-[20px] border-ember-500/40 shadow-[0_30px_80px_rgba(0,0,0,0.55)] z-50 flex flex-col max-h-[70vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
            <span className="font-display text-lg font-semibold text-gray-100">
              Notifications
              {total > 0 && (
                <span className="ml-2 text-[11px] font-sans bg-ember-500/20 text-ember-300 px-2 py-0.5 rounded-full">{total}</span>
              )}
            </span>
            <button onClick={() => setOpen(false)} className="w-9 h-9 text-gray-300 hover:text-white text-lg leading-none" aria-label="Close">&times;</button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2.5">
            {total === 0 && (
              <div className="text-center py-8 text-gray-600 text-xs">
                No pending notifications
              </div>
            )}

            {/* Waiting on you — from state, so it is here whether or not the bell saw it happen */}
            {needsYou.length > 0 && (
              <div className="space-y-2" data-testid="needs-you">
                <div className="text-[11px] uppercase tracking-wider text-ember-300 px-1">Needs you · {needsYou.length}</div>
                {needsYou.map((item) => <NeedsYouRow key={item.key} item={item} onOpen={() => { openNeedsYou(item); setOpen(false); }} />)}
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
