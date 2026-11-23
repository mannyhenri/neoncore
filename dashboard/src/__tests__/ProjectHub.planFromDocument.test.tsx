import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, Project, ProjectImport } from '../types';

/**
 * REQUESTED: "load a document with specs, epics and its own roadmap in a project, and through AI it
 * generates all the epics and roadmaps in the project for me".
 *
 * The Roadmap tab's "✦ Plan from a document": the document is uploaded (as base64, with its name) to
 * the cartridge picked; the plan comes back for review epic by epic — everything ticked — and Apply
 * sends exactly what is still ticked. Unticking a new epic or a feature another waits on is said beside
 * the feature, never silently.
 */
const mocks = vi.hoisted(() => ({ start: vi.fn(), apply: vi.fn() }));
vi.mock('../lib/api', () => {
  const client = { startProjectImport: mocks.start, applyProjectImport: mocks.apply };
  return { api: client, apiFor: () => client };
});

import { PlanFromDocument } from '../components/ProjectHub';

const project = { id: 'p', name: 'Ledgerly', cartridges: ['/repo'], primaryRepo: '/repo' } as unknown as Project;
const agents = [{ id: 'cart-1', name: 'box/ledgerly', repoName: 'ledgerly', repoPath: '/repo', agentType: 'claude', status: 'idle' }] as unknown as Agent[];

const ready: ProjectImport = {
  id: 'imp-1', projectId: 'p', agentId: 'cart-1', parts: ['plan'], status: 'ready', notes: ['"Q3" is not a calendar day — left empty'], error: '',
  applied: null, createdAt: '2026-11-22T10:00:00Z', dispatchedAt: '2026-11-22T10:00:00Z', completedAt: '2026-11-22T10:05:00Z',
  document: { name: 'plan-2027.docx', chars: 5000 },
  proposal: {
    message: 'Read the 2027 plan.', architecture: '', features: [], backlog: [], changelog: [],
    plan: {
      vision: 'Invoices paid in a click.',
      epics: [
        { name: 'Payments', outcome: 'Customers pay online', icon: '💳', existing: false },
        { name: 'Reporting', outcome: 'Owners see cash flow', icon: '📈', existing: true },
      ],
      features: [
        { name: 'Card checkout', description: 'Pay by card.', epic: 'Payments', area: '', startDate: '2027-07-01', targetDate: '2027-09-30', dependsOn: [],
          criteria: [{ text: 'When a valid card is entered, the system shall charge it.', expect: '' }] },
        { name: 'Refunds', description: '', epic: 'Payments', area: '', startDate: '', targetDate: '', dependsOn: ['Card checkout'], criteria: [] },
        { name: 'Cash-flow chart', description: '', epic: 'Reporting', area: '', startDate: '', targetDate: '', dependsOn: [], criteria: [] },
        { name: 'Dark mode', description: '', epic: '', area: '', startDate: '', targetDate: '', dependsOn: [], criteria: [] },
      ],
      project: { constraints: 'Rust stable only.', definitionOfDone: 'All gates pass.' },
      updates: [{ name: 'Sign in', description: '', epic: 'Payments', area: '', startDate: '', targetDate: '', dependsOn: [], criteria: [],
        scope: { successMetric: 'A user signs in with a passkey.', rabbitHoles: 'Session fixation.' } }],
      questions: [{ id: 'q1', text: 'Which payment provider?', why: 'Checkout and refunds both use it.', options: ['Stripe', 'Adyen'], suggested: 'Stripe', features: ['Card checkout', 'Refunds'] }],
    },
  },
};

describe('Plan from a document', () => {
  it('uploads the picked document to the picked cartridge as base64 with its name', async () => {
    mocks.start.mockResolvedValueOnce({ import: { ...ready, status: 'pending', proposal: null }, queued: false });
    const load = vi.fn();
    render(<PlanFromDocument project={project} agents={agents} imports={[]} load={load} onChanged={() => {}} />);
    const build = screen.getByRole('button', { name: /Build the roadmap/ });
    expect(build).toBeDisabled();
    const file = new File(['# Plan\n## Epic: Payments'], 'plan.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('Planning document'), { target: { files: [file] } });
    await screen.findByText(/📄 plan\.md/);
    fireEvent.click(build);
    await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    const [projectId, agentId, parts, doc] = mocks.start.mock.calls[0];
    expect([projectId, agentId, parts, doc.name]).toEqual(['p', 'cart-1', ['plan'], 'plan.md']);
    expect(atob(doc.data)).toBe('# Plan\n## Epic: Payments');
    expect(load).toHaveBeenCalled();
  });

  it('shows the plan epic by epic, says what an untick changes, and applies exactly what is ticked', async () => {
    mocks.apply.mockResolvedValueOnce({ imp: { ...ready, status: 'applied' }, created: { existing: [], planned: [], changelog: 0 } });
    render(<PlanFromDocument project={project} agents={agents} imports={[ready]} load={() => {}} onChanged={() => {}} />);
    expect(screen.getByText(/the plan from plan-2027\.docx/)).toBeInTheDocument();
    expect(screen.getByText(/"Q3" is not a calendar day/)).toBeInTheDocument();
    expect(screen.getByText(/already on the roadmap/)).toBeInTheDocument();
    expect(screen.getByText(/waits on Card checkout/)).toBeInTheDocument();
    expect(screen.getByText(/In no epic/)).toBeInTheDocument();
    expect(screen.getByLabelText('Keep epic Reporting')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Keep epic Payments'));
    expect(screen.getAllByText(/its epic is unticked — it lands in no epic/)).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Keep Card checkout'));
    expect(screen.getByText(/Card checkout is not kept — that wait is not recorded/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Vision'), { target: { value: 'Every invoice paid in one click.' } });

    // The whole project, the fill-ins and the questions are on the same screen, kept / answered by default.
    expect(screen.getByLabelText('Keep Rules and constraints')).toBeChecked();
    expect(screen.getByLabelText('Fill in Sign in')).toBeChecked();
    expect(screen.getByText(/2 scope fields/)).toBeInTheDocument();
    expect(screen.getByLabelText('Leave "Which payment provider?" to the agents')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Keep Definition of done'));
    fireEvent.click(screen.getByLabelText('Adyen'));

    fireEvent.click(screen.getByRole('button', { name: /^Keep the vision, 1 project field, 3 roadmap features, 1 fill-in, 1 answer$/ }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalled());
    const [id, data] = mocks.apply.mock.calls[0];
    expect(id).toBe('imp-1');
    expect(data).toMatchObject({ vision: 'Every invoice paid in one click.', epics: [], features: [], backlog: [], changelog: [],
      updates: ['Sign in'], project: ['constraints'], answers: { q1: { value: 'Adyen', delegated: false } } });
    expect([...data.plan].sort()).toEqual(['Cash-flow chart', 'Dark mode', 'Refunds']);
  });
});
