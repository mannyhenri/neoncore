import { describe, it, expect } from 'vitest';
import type { Agent, Activity, PermissionRequest, StuckAlert, AgentType } from '../../types';
import { buildCrew, crewCounts, CREW_STATUSES, ATTENTION_ORDER, TASK_SOURCES, ENGINE_COLOURS, ENGINES } from '../crew';

/**
 * THE SCENE MUST SHOW EVERY CARTRIDGE THE GRID SHOWED.
 *
 * The Agents screen used to be a grid of cards; in V3 it is a scene of crew members. The
 * failure this file exists to prevent is the partial one: a scene that draws the working
 * agents and silently drops the idle ones, or the ones that need an approval. So every test
 * here iterates a registry (statuses, attention kinds, engines, task sources) rather than
 * checking a couple of hand-picked examples.
 */

const NOW = Date.parse('2026-11-18T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: over.id, machine: 'm1', repoPath: `/r/${over.id}`, repoName: over.id, branch: 'main',
    currentTask: '', status: 'idle', trustMode: false, plansIncluded: false, mode: 'manual',
    agentType: 'claude', lastSeen: iso(0), sessionId: `s-${over.id}`, lastMessage: '',
    pendingQuestion: '', recoveryStatus: '', interruptedAt: '', activeObjective: '',
    ...over,
  } as Agent;
}
const act = (agentId: string, msAgo: number, toolName = 'Edit'): Activity =>
  ({ id: `${agentId}-${msAgo}`, agentId, eventType: 'tool', toolName, toolInput: '', toolResult: '', timestamp: iso(msAgo) });
const perm = (agentId: string, toolName = 'Bash'): PermissionRequest =>
  ({ id: `p-${agentId}`, agentId, toolName, toolInput: '', description: `run ${toolName}`, status: 'pending', createdAt: iso(1000), decidedAt: null, response: '' });
const stuck = (agentId: string): StuckAlert =>
  ({ agentId, pattern: 'loop', severity: 'high', suggestion: 'nudge', detectedAt: iso(1000) });

describe('buildCrew — who is on site', () => {
  it('one crew member per cartridge for every non-offline status', () => {
    const agents = CREW_STATUSES.map((s) => agent({ id: `a-${s}`, status: s }));
    const crew = buildCrew({ agents, activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW });
    expect(crew.map((c) => c.status).sort()).toEqual([...CREW_STATUSES].sort());
    expect(crew).toHaveLength(CREW_STATUSES.length);
    const counts = crewCounts(crew);
    for (const s of CREW_STATUSES) expect(counts[s], s).toBe(1);
    expect(counts.all).toBe(CREW_STATUSES.length);
  });

  it('offline and dismissed agents are not on site; a quiet-but-recent offline one still is', () => {
    const agents = [
      agent({ id: 'off', status: 'offline' }),
      agent({ id: 'off-recent', status: 'offline' }),
      agent({ id: 'gone', status: 'working', dismissedAt: iso(5000) } as Partial<Agent> & { id: string }),
      agent({ id: 'here', status: 'idle' }),
    ];
    const crew = buildCrew({
      agents, activitiesByAgent: { 'off-recent': [act('off-recent', 10_000)] },
      pendingPermissions: [], stuckAlerts: [], now: NOW,
    });
    expect(crew.map((c) => c.key).sort()).toEqual(['m1:here', 'm1:off-recent']);
    expect(crew.find((c) => c.key === 'm1:off-recent')!.status).toBe('working');
  });

  it('agents in the same repo on the same machine are ONE crew member, best status leading', () => {
    const agents = [
      agent({ id: 'x1', repoName: 'shared', status: 'idle' }),
      agent({ id: 'x2', repoName: 'shared', status: 'working', agentType: 'codex' }),
      agent({ id: 'y1', repoName: 'shared', machine: 'm2', status: 'idle' }),
    ];
    const crew = buildCrew({ agents, activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW });
    expect(crew).toHaveLength(2);
    const shared = crew.find((c) => c.key === 'm1:shared')!;
    expect(shared.agent.id).toBe('x2');
    expect(shared.agentIds.sort()).toEqual(['x1', 'x2']);
    expect(shared.status).toBe('working');
  });

  it('every attention kind is raised, and the order decides when several apply', () => {
    const cases: Record<(typeof ATTENTION_ORDER)[number], Parameters<typeof buildCrew>[0]> = {
      approval: { agents: [agent({ id: 'a' })], activitiesByAgent: {}, pendingPermissions: [perm('a', 'Bash')], stuckAlerts: [], now: NOW },
      question: { agents: [agent({ id: 'a', pendingQuestion: 'Which db?' })], activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW },
      stuck: { agents: [agent({ id: 'a' })], activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [stuck('a')], now: NOW },
      review: { agents: [agent({ id: 'a', standardState: 'needs_review' })], activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW },
    };
    for (const kind of ATTENTION_ORDER) {
      const [m] = buildCrew(cases[kind]);
      expect(m.attention, kind).toBe(kind);
      expect(m.attentionText.length, `${kind} has words`).toBeGreaterThan(0);
    }
    expect(Object.keys(cases).sort()).toEqual([...ATTENTION_ORDER].sort());

    // Everything at once: the first in ATTENTION_ORDER wins.
    const [all] = buildCrew({
      agents: [agent({ id: 'a', pendingQuestion: 'q?', standardState: 'needs_review' })],
      activitiesByAgent: {}, pendingPermissions: [perm('a')], stuckAlerts: [stuck('a')], now: NOW,
    });
    expect(all.attention).toBe(ATTENTION_ORDER[0]);
    // A sibling's approval belongs to the crew member too.
    const [sib] = buildCrew({
      agents: [agent({ id: 'p', repoName: 'r' }), agent({ id: 'q', repoName: 'r' })],
      activitiesByAgent: {}, pendingPermissions: [perm('q')], stuckAlerts: [], now: NOW,
    });
    expect(sib.attention).toBe('approval');
    expect(sib.approvals).toHaveLength(1);
  });

  it('AskUserQuestion is a question, not an approval', () => {
    const [m] = buildCrew({ agents: [agent({ id: 'a' })], activitiesByAgent: {}, pendingPermissions: [perm('a', 'AskUserQuestion')], stuckAlerts: [], now: NOW });
    expect(m.attention).toBe('question');
  });

  it('the overhead panel names the work from every source, most specific first', () => {
    const fixtures: Record<(typeof TASK_SOURCES)[number], { a: Agent; acts: Activity[]; text: string }> = {
      objective: { a: agent({ id: 'a', activeObjective: 'Ship rate limits', currentTask: 'older' }), acts: [act('a', 1000)], text: 'Ship rate limits' },
      task: { a: agent({ id: 'a', currentTask: 'Fix sync bug' }), acts: [act('a', 1000)], text: 'Fix sync bug' },
      activity: { a: agent({ id: 'a' }), acts: [act('a', 5000, 'Read'), act('a', 1000, 'Bash')], text: 'Bash' },
      none: { a: agent({ id: 'a' }), acts: [], text: '' },
    };
    for (const source of TASK_SOURCES) {
      const f = fixtures[source];
      const [m] = buildCrew({ agents: [f.a], activitiesByAgent: { a: f.acts }, pendingPermissions: [], stuckAlerts: [], now: NOW });
      expect(m.taskSource, source).toBe(source);
      if (source === 'none') expect(m.task).toBe('');
      else expect(m.task, source).toContain(f.text);
    }
    expect(Object.keys(fixtures).sort()).toEqual([...TASK_SOURCES].sort());
  });

  it('every engine has a suit colour, and a crew member carries its engine', () => {
    const engines: AgentType[] = ['claude', 'gridlight', 'codex'];
    expect([...ENGINES].sort()).toEqual([...engines].sort());
    for (const e of ENGINES) {
      expect(ENGINE_COLOURS[e].suit, e).toMatch(/^#[0-9A-F]{6}$/i);
      expect(ENGINE_COLOURS[e].shade, e).toMatch(/^#[0-9A-F]{6}$/i);
      const [m] = buildCrew({ agents: [agent({ id: 'a', agentType: e })], activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW });
      expect(m.engine).toBe(e);
    }
    expect(new Set(ENGINES.map((e) => ENGINE_COLOURS[e].suit)).size).toBe(ENGINES.length);
  });

  it('is sorted by name so the site an agent stands at does not shuffle between renders', () => {
    const agents = ['zeta', 'alpha', 'mid'].map((id) => agent({ id }));
    const a = buildCrew({ agents, activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW }).map((c) => c.name);
    const b = buildCrew({ agents: [...agents].reverse(), activitiesByAgent: {}, pendingPermissions: [], stuckAlerts: [], now: NOW }).map((c) => c.name);
    expect(a).toEqual(['alpha', 'mid', 'zeta']);
    expect(b).toEqual(a);
  });
});
