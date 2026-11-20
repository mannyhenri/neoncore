/**
 * WHO IS ON SITE — the scene's roster, derived from the same records the cartridge list uses.
 *
 * One crew member per cartridge (machine + repo), exactly as the list groups them, so the
 * scene never shows more or fewer agents than the list would. Pure and clock-injected so it
 * can be tested as a set (see __tests__/crew.test.ts).
 */
import type { Agent, Activity, AgentType, PermissionRequest, StuckAlert } from '../types';
import { effectiveAgentStatus } from '../lib/agentStatus';

/** The statuses a crew member on site can have. Offline agents are not on site. */
export const CREW_STATUSES = ['working', 'waiting', 'idle'] as const;
export type CrewStatus = (typeof CREW_STATUSES)[number];

/** Why a crew member needs the user, most urgent first. The first that applies wins. */
export const ATTENTION_ORDER = ['approval', 'question', 'stuck', 'review'] as const;
export type CrewAttention = (typeof ATTENTION_ORDER)[number];

/** Where the overhead panel's task line comes from, most specific first. */
export const TASK_SOURCES = ['objective', 'task', 'activity', 'none'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const ENGINES = ['claude', 'codex'] as const satisfies readonly AgentType[];

/** Suit colours — the engine colours from docs/DESIGN.md, with a darker shade for shading. */
export const ENGINE_COLOURS: Record<AgentType, { suit: string; shade: string; label: string }> = {
  claude: { suit: '#7CC4FF', shade: '#4A8FD0', label: 'Claude' },
  codex: { suit: '#2EE6D6', shade: '#17A89C', label: 'Codex' },
};

export interface CrewMember {
  /** `machine:repoName` — the cartridge, stable across which agent is currently primary. */
  key: string;
  /** The agent with the best status in the group. */
  agent: Agent;
  /** Every agent in this cartridge, primary first. */
  agentIds: string[];
  name: string;
  engine: AgentType;
  status: CrewStatus;
  attention: CrewAttention | null;
  /** Words for the attention badge's tooltip; '' when attention is null. */
  attentionText: string;
  approvals: PermissionRequest[];
  /** What the crew member is working on; '' when nothing is known. */
  task: string;
  taskSource: TaskSource;
  /** The last thing the cartridge said, and the session it said it in. */
  lastMessage: string;
  sessionId: string;
}

const STATUS_PRIORITY: Record<string, number> = { working: 0, waiting: 1, idle: 2, offline: 3 };

export interface CrewInput {
  agents: Agent[];
  activitiesByAgent: Record<string, Activity[]>;
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  now: number;
}

export function buildCrew({ agents, activitiesByAgent, pendingPermissions, stuckAlerts, now }: CrewInput): CrewMember[] {
  const status = new Map<string, Agent['status']>();
  for (const a of agents) status.set(a.id, effectiveAgentStatus(a, activitiesByAgent[a.id] || [], now));

  // On site = alive and not put away — the same two checks the list makes.
  const groups = new Map<string, Agent[]>();
  for (const a of agents) {
    if (status.get(a.id) === 'offline' || a.dismissedAt) continue;
    const key = `${a.machine}:${a.repoName}`;
    groups.set(key, [...(groups.get(key) || []), a]);
  }

  const stuckIds = new Set(stuckAlerts.map((s) => s.agentId));
  const crew: CrewMember[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort(
      (a, b) => (STATUS_PRIORITY[status.get(a.id) || 'offline'] ?? 3) - (STATUS_PRIORITY[status.get(b.id) || 'offline'] ?? 3),
    );
    const primary = ordered[0];
    const ids = ordered.map((a) => a.id);
    const approvals = pendingPermissions.filter((p) => p.status === 'pending' && ids.includes(p.agentId));
    const realApprovals = approvals.filter((p) => p.toolName !== 'AskUserQuestion');
    const asked = approvals.find((p) => p.toolName === 'AskUserQuestion');
    const question = ordered.map((a) => a.pendingQuestion).find(Boolean) || '';
    const stuck = stuckAlerts.find((s) => ids.includes(s.agentId));

    let attention: CrewAttention | null = null;
    let attentionText = '';
    if (realApprovals.length > 0) {
      attention = 'approval';
      attentionText = realApprovals[0].description || `Wants to run ${realApprovals[0].toolName}`;
    } else if (asked || question) {
      attention = 'question';
      attentionText = question || asked?.description || 'Has a question for you';
    } else if (stuck && stuckIds.has(stuck.agentId)) {
      attention = 'stuck';
      attentionText = stuck.suggestion || stuck.pattern || 'Looks stuck';
    } else if (ordered.some((a) => a.standardState === 'needs_review')) {
      attention = 'review';
      attentionText = 'Stopped without a completion report';
    }

    const { task, taskSource } = currentWork(ordered, activitiesByAgent);
    crew.push({
      key,
      agent: primary,
      agentIds: ids,
      name: primary.repoName || primary.name,
      engine: primary.agentType || 'claude',
      status: (status.get(primary.id) as CrewStatus) ?? 'idle',
      attention,
      attentionText,
      approvals,
      task,
      taskSource,
      lastMessage: ordered.map((a) => a.lastMessage).find(Boolean) || '',
      sessionId: primary.sessionId || '',
    });
  }
  return crew.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

function currentWork(group: Agent[], activitiesByAgent: Record<string, Activity[]>): { task: string; taskSource: TaskSource } {
  const objective = group.map((a) => a.activeObjective).find(Boolean);
  if (objective) return { task: oneLine(objective), taskSource: 'objective' };
  const task = group.map((a) => a.currentTask).find(Boolean);
  if (task) return { task: oneLine(task), taskSource: 'task' };
  const latest = group
    .flatMap((a) => activitiesByAgent[a.id] || [])
    .filter((x) => x.toolName)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  if (latest) return { task: `Using ${latest.toolName}`, taskSource: 'activity' };
  return { task: '', taskSource: 'none' };
}

/** A panel line: the first line of the text, whitespace collapsed. CSS truncates the rest. */
function oneLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '';
}

export type CrewCounts = Record<'all' | CrewStatus, number>;

export function crewCounts(crew: CrewMember[]): CrewCounts {
  const counts: CrewCounts = { all: crew.length, working: 0, waiting: 0, idle: 0 };
  for (const m of crew) counts[m.status] += 1;
  return counts;
}
