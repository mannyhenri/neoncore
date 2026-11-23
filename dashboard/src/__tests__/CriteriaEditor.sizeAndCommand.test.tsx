import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { GoalPilotMeta } from '../types';
import { CriteriaEditor } from '../components/AcceptanceContractPanel';
import { criteriaProblems, type DraftCriterion } from '../lib/goalPilot';

/**
 * REQUESTED: acceptance criteria were "too verbose and way too complex … for simple tasks like just
 * setting up a project with its dependencies". The plan step shows the feature's size and its budget,
 * and offers every verify method the server has — including a COMMAND (exit 0 passes), which is what
 * setup work needs instead of a written test.
 */
const meta = {
  limits: { maxCriteria: 12 },
  verifyMethods: [
    { value: 'test', label: 'Automated test', hint: '' },
    { value: 'command', label: 'Command', hint: '' },
    { value: 'checklist', label: 'Checklist', hint: '' },
  ],
  featureSizes: [
    { value: 'small', label: 'Small', hint: '', maxCriteria: 3 },
    { value: 'medium', label: 'Medium', hint: '', maxCriteria: 6 },
    { value: 'large', label: 'Large', hint: '', maxCriteria: 12 },
  ],
} as unknown as GoalPilotMeta;

function Harness({ start, onChange }: { start: DraftCriterion[]; onChange: (c: DraftCriterion[]) => void }) {
  const [c, setC] = useState(start);
  return <CriteriaEditor criteria={c} onChange={(n) => { setC(n); onChange(n); }} meta={meta} defaultVerify="test" size="small" />;
}

describe('the criteria editor — size and command', () => {
  it('shows the budget of the size, and flags going over it', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ text: `c${i}`, expect: 'x', verify: 'test' as const }));
    render(<Harness start={four} onChange={() => {}} />);
    const budget = screen.getByTestId('criteria-budget');
    expect(budget.textContent).toMatch(/Small feature · 4\/3/);
    expect(budget.className).toMatch(/amber/);
  });

  it('every verify method is offered; picking Command asks for the command, and none is a problem', () => {
    const onChange = vi.fn();
    render(<Harness start={[{ text: 'The workspace builds', expect: '', verify: 'test' }]} onChange={onChange} />);
    for (const m of meta.verifyMethods) expect(screen.getByRole('button', { name: new RegExp(m.label) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Command/ }));
    const box = screen.getByLabelText('AC-1 command');
    expect(criteriaProblems(onChange.mock.lastCall![0])).toEqual(['AC-1 is checked by a command but has none.']);
    fireEvent.change(box, { target: { value: 'cargo build && cargo test' } });
    const last = onChange.mock.lastCall![0] as DraftCriterion[];
    expect(last[0]).toMatchObject({ verify: 'command', command: 'cargo build && cargo test' });
    expect(criteriaProblems(last)).toEqual([]);
  });
});
