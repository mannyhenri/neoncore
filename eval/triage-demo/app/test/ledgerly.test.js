import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, formatMoney } from '../src/money.js';
import { lineTotal, subtotal, total } from '../src/invoice.js';
import { daysBetween } from '../src/dates.js';
import { totalHours, validateWeek, weeklyPay } from '../src/timesheet.js';
import { createSession, endSession, userFor } from '../src/auth/session.js';
import { invoicePage, PAGE_SIZE } from '../src/server.js';

test('money rounds to the cent and formats with separators', () => {
  assert.equal(cents(10.006), 10.01);
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(0), '$0.00');
});

test('an invoice adds up its lines', () => {
  const inv = { lines: [{ quantity: 2, unitPrice: 50 }, { quantity: 1, unitPrice: 25 }], discountPct: 0, taxPct: 0 };
  assert.equal(lineTotal(inv.lines[0]), 100);
  assert.equal(subtotal(inv), 125);
  assert.equal(total(inv), 125);
});

test('tax is added to the total', () => {
  assert.equal(total({ lines: [{ quantity: 1, unitPrice: 200 }], discountPct: 0, taxPct: 10 }), 220);
});

test('days between two dates', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
});

test('a full week of 40 hours is paid at the plain rate', () => {
  assert.deepEqual(weeklyPay([8, 8, 8, 8, 8, 0, 0], 20), { regular: 40, overtime: 0, pay: 800 });
});

test('hours above 40 are paid at 1.5x', () => {
  assert.deepEqual(weeklyPay([9, 9, 9, 9, 9, 0, 0], 20), { regular: 40, overtime: 5, pay: 950 });
});

test('an entry longer than 24 hours is rejected, on purpose', () => {
  assert.throws(() => validateWeek([25, 0, 0, 0, 0, 0, 0]), /cannot be longer than 24 hours/);
  assert.equal(totalHours([1, 2, 3, 0, 0, 0, 0]), 6);
});

test('a new session signs the user in, and ending it signs them out', () => {
  const s = createSession('ana');
  assert.equal(userFor(s.id), 'ana');
  endSession(s.id);
  assert.equal(userFor(s.id), null);
  assert.equal(userFor('nope'), null);
});

test('the invoice list reports its page size and the total count', () => {
  const p = invoicePage(1);
  assert.equal(p.page, 1);
  assert.equal(p.pageSize, PAGE_SIZE);
  assert.equal(p.total, 12);
});
