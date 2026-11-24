import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Agent } from '../../types';
import { RunBackgroundWork } from '../BackgroundWork';
import { AGENT_STATUSES } from '../../lib/agentStatus';

/**
 * THE RUN CARD SAYS WHEN ITS STEP'S AGENT IS RUNNING SOMETHING IN THE BACKGROUND — the last
 * surface of plan part 6 (deferred by the dashboard track: the run's stepSummary did not name the
 * agent; it now carries `runningAgentIds`, server/src/lib/step-summary.ts).
 * SET: every agent status × {running a step of this run, not running one} → shown only for a
 * `background` agent that is running one of this run's steps.
 */
const agent = (id: string, status: Agent['status']): Agent => ({
  id, name: id, status,
  background: [{ taskId: `${id}-t`, kind: 'shell', description: `suite of ${id}`, startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), deadlineAt: new Date(Date.now() + 18 * 60_000).toISOString() }],
} as unknown as Agent);

describe('RunBackgroundWork', () => {
  for (const status of AGENT_STATUSES) {
    for (const running of [true, false]) {
      it(`${status} agent, ${running ? 'running a step' : 'not running a step'}`, () => {
        const a = agent(`a-${status}`, status);
        const { container } = render(
          <RunBackgroundWork runningAgentIds={running ? [a.id] : []} agents={[a, agent('other', 'background')]} />,
        );
        const lines = container.querySelectorAll('[data-background-work]');
        if (status === 'background' && running) {
          expect(lines).toHaveLength(1);
          expect(lines[0].textContent).toContain(`suite of ${a.id}`);
        } else {
          expect(lines).toHaveLength(0);
        }
      });
    }
  }

  it('renders nothing without a summary or agents', () => {
    const { container } = render(<RunBackgroundWork runningAgentIds={undefined} agents={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('both run-card layouts (compact and full) render it', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/WorkflowPanel.tsx'), 'utf8');
    const card = src.slice(src.indexOf('function WorkflowRunCard'));
    const compact = card.slice(card.indexOf('if (compact) {'), card.indexOf('if (isTemplate) {'));
    const full = card.slice(card.indexOf('<RunProgressStrip'));
    expect(compact).toContain('<RunBackgroundWork');
    expect(full.slice(0, 600)).toContain('<RunBackgroundWork');
  });
});
