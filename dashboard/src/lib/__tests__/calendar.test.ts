import { describe, it, expect } from 'vitest';
import { monthGrid, parseISODate, toISODate, addDays, addMonths, displayDate, todayISO, WEEKDAYS } from '../calendar';

describe('calendar maths', () => {
  it('every month of two years (one leap): 42 days, Monday-first, each day of the month exactly once and in order', () => {
    for (const year of [2027, 2028]) {
      for (let month = 0; month < 12; month++) {
        const grid = monthGrid(year, month);
        expect(grid).toHaveLength(42);
        const firstWeekday = new Date(Number(grid[0].iso.slice(0, 4)), Number(grid[0].iso.slice(5, 7)) - 1, grid[0].day).getDay();
        expect(firstWeekday, `${year}-${month + 1} starts on a Monday`).toBe(1);
        const inMonth = grid.filter((d) => d.inMonth).map((d) => d.day);
        const length = new Date(year, month + 1, 0).getDate();
        expect(inMonth).toEqual(Array.from({ length }, (_, i) => i + 1));
        // consecutive calendar days, no gaps or repeats across the padding
        for (let i = 1; i < grid.length; i++) expect(addDays(grid[i - 1].iso, 1)).toBe(grid[i].iso);
      }
    }
    expect(monthGrid(2028, 1).filter((d) => d.inMonth)).toHaveLength(29);
    expect(WEEKDAYS[0]).toBe('Mo');
  });

  it('only real dates parse', () => {
    expect(parseISODate('2027-03-01')).toEqual({ year: 2027, month: 2, day: 1 });
    for (const bad of ['', '2027-02-30', '2027-13-01', '03/01/2027', '2027-3-1', 'soon']) expect(parseISODate(bad), bad).toBeNull();
  });

  it('moves across month and year boundaries', () => {
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addMonths(2027, 11, 1)).toEqual({ year: 2028, month: 0 });
    expect(addMonths(2027, 0, -1)).toEqual({ year: 2026, month: 11 });
  });

  it('a calendar date never goes through a UTC timestamp', () => {
    // Local constructors only: the value a person picks is the value stored, in every timezone.
    expect(toISODate(2027, 2, 1)).toBe('2027-03-01');
    expect(todayISO(new Date(2027, 2, 1, 23, 59))).toBe('2027-03-01');
    expect(displayDate('2027-03-01')).toBe('Mon 1 Mar 2027');
    expect(displayDate('nope')).toBe('');
  });
});
