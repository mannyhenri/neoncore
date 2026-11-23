import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationCenter } from '../NotificationCenter';
import type { NeedsYouItem } from '../../types';

/**
 * "Sometimes I need to be notified to act on something and have no warnings." The bell's events
 * can be missed; the list of what waits on you comes from the server's state and stays until it
 * is done. It leads the panel, counts on the badge, and opens the feature it is about.
 */
const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  key: 'k1', kind: 'run', title: 'Sharding a model in between all resources',
  what: 'Stage 2: 3 of 10 tasks are still open. The agent asks: Person: lock the v2 prompts.',
  since: '2026-11-23T12:00:00Z', projectId: 'proj-gl', goalId: 'goal-shard', pilotId: 'p1', workflowId: 'wf1', ...over,
});
const noop = () => {};
const mount = (needsYou: NeedsYouItem[]) => render(
  <NotificationCenter pendingPermissions={[]} stuckAlerts={[]} workflowNotifications={[]} needsYou={needsYou}
    agents={[]} onDecide={noop} onDismissStuck={noop} onDismissWorkflow={noop} />);

describe('NotificationCenter — needs you, from state', () => {
  it('counts what waits on you on the badge, lists it first with the agent\'s ask, and opens the feature', () => {
    mount([item({}), item({ key: 'k2', kind: 'mark-done', title: 'Core data types', what: 'Read the feature report, then mark the feature done.', goalId: 'goal-core', projectId: 'proj-facet' })]);
    const bell = screen.getByTitle('Notifications');
    expect(bell.textContent).toContain('2');
    fireEvent.click(bell);
    const rows = screen.getAllByTestId('needs-you-item');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('The agent asks: Person: lock the v2 prompts.');
    fireEvent.click(rows[1]);
    expect(window.location.hash).toContain('goal-core');
  });

  it('nothing waiting: no list', () => {
    mount([]);
    fireEvent.click(screen.getByTitle('Notifications'));
    expect(screen.queryByTestId('needs-you')).toBeNull();
  });
});
