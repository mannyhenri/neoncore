import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { DatePicker } from '../DatePicker';

describe('DatePicker', () => {
  it('opens on the chosen month, picks a day, and hands back YYYY-MM-DD', () => {
    const onChange = vi.fn();
    const view = render(<DatePicker value="2027-03-10" onChange={onChange} />);
    expect(view.getByText('Wed 10 Mar 2027')).toBeTruthy();
    fireEvent.click(view.getByText('Wed 10 Mar 2027'));
    expect(view.getByText('March 2027')).toBeTruthy();
    fireEvent.click(view.getByLabelText('Next month'));
    expect(view.getByText('April 2027')).toBeTruthy();
    fireEvent.click(view.getByLabelText('Fri 16 Apr 2027'));
    expect(onChange).toHaveBeenCalledWith('2027-04-16');
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('keyboard: arrows move across the month boundary, Enter on a day picks it, Escape closes', () => {
    const onChange = vi.fn();
    const view = render(<DatePicker value="2027-03-31" onChange={onChange} />);
    fireEvent.click(view.getByRole('button', { name: /Wed 31 Mar 2027/ }));
    const grid = view.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(view.getByText('April 2027')).toBeTruthy();
    fireEvent.click(view.getByLabelText('Thu 1 Apr 2027'));
    expect(onChange).toHaveBeenCalledWith('2027-04-01');
    fireEvent.click(view.getByRole('button', { name: /Wed 31 Mar 2027/ }));
    fireEvent.keyDown(view.getByRole('grid'), { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('unset shows the placeholder; Clear unsets', () => {
    const onChange = vi.fn();
    const view = render(<DatePicker value="" onChange={onChange} placeholder="No target date" />);
    expect(view.getByText('No target date')).toBeTruthy();
    const set = render(<DatePicker value="2027-03-10" onChange={onChange} />);
    fireEvent.click(set.getByText('Wed 10 Mar 2027'));
    fireEvent.click(set.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
