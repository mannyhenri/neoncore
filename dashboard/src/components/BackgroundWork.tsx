import type { Agent } from '../types';
import { backgroundLines } from '../lib/agentStatus';

/**
 * What a cartridge is still running after its turn ended — so a 10-minute suite reads as work
 * in progress, not as an agent that stopped. Renders nothing unless the agent is `background`.
 */
export function BackgroundWork({ agent, now = Date.now(), className = '' }: {
  agent: Pick<Agent, 'status' | 'background'> | undefined | null;
  now?: number;
  className?: string;
}) {
  const lines = agent ? backgroundLines(agent, now) : [];
  if (lines.length === 0) return null;
  return (
    <div data-background-work className={`flex flex-col gap-0.5 text-[12px] text-neon-200 ${className}`}>
      {lines.map((l, i) => (
        <span key={i} className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-neon-400/80 animate-pulse shrink-0" />
          <span className="truncate">Running in background: {l}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A run card's line for its running steps: the background work of each agent running one of the
 * run's steps (`stepSummary.runningAgentIds`, server lib/step-summary.ts). Nothing unless one of
 * them is `background` — so a run whose agent is waiting on its suite reads as progressing.
 */
export function RunBackgroundWork({ runningAgentIds, agents, now, className = '' }: {
  runningAgentIds: string[] | undefined;
  agents: Pick<Agent, 'id' | 'status' | 'background'>[] | undefined;
  now?: number;
  className?: string;
}) {
  if (!runningAgentIds?.length || !agents?.length) return null;
  const running = agents.filter((a) => runningAgentIds.includes(a.id) && a.status === 'background');
  if (running.length === 0) return null;
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      {running.map((a) => <BackgroundWork key={a.id} agent={a} now={now} />)}
    </div>
  );
}
