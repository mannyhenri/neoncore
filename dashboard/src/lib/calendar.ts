/**
 * Calendar maths for the date picker — pure, so it is tested without rendering.
 *
 * Dates are CALENDAR dates ('YYYY-MM-DD'), built from local year/month/day and never through a
 * UTC timestamp: `new Date('2027-03-01')` is midnight UTC, which is still February in the
 * Americas, and a target date that shifts a day depending on who opened the form is a bug.
 */

export interface CalendarDay { iso: string; day: number; inMonth: boolean }

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** 'YYYY-MM-DD' → { year, month (0-based), day }, or null for anything that is not a real date. */
export function parseISODate(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]) - 1; const day = Number(m[3]);
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;   // 2027-02-30
  return { year, month, day };
}

export function todayISO(now = new Date()): string {
  return toISODate(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A month shifted by `delta`, wrapping the year. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** The date `delta` days away — for arrow-key movement across month boundaries. */
export function addDays(iso: string, delta: number): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  const d = new Date(p.year, p.month, p.day + delta);
  return toISODate(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Six weeks — always 42 days, so the popover never changes height between months — starting on
 * Monday, padded with the neighbouring months' days.
 */
export function monthGrid(year: number, month: number): CalendarDay[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;           // Monday-first
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - lead + i);
    days.push({ iso: toISODate(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return days;
}

export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`;
}

/** "Mon 1 Mar 2027" — unambiguous whatever the reader's locale conventions. */
export function displayDate(iso: string): string {
  const p = parseISODate(iso);
  if (!p) return '';
  const d = new Date(p.year, p.month, p.day);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${p.day} ${MONTHS[p.month].slice(0, 3)} ${p.year}`;
}
