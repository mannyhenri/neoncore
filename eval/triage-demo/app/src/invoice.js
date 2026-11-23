/**
 * Invoices: lines, subtotal, discount, tax, total.
 *
 * An invoice: { id, customer, issued: Date, status, lines: [{ description, quantity, unitPrice }],
 *               discountPct (0-100), taxPct (0-100) }
 */
import { cents } from './money.js';
import { formatDate } from './dates.js';

export function lineTotal(line) {
  return line.quantity * line.unitPrice;
}

/** Sum of the line totals. */
export function subtotal(invoice) {
  return invoice.lines.reduce((sum, line) => sum + lineTotal(line), 0);
}

/**
 * The amount due. The discount applies to the subtotal, before tax (README: "Discounts").
 */
export function total(invoice) {
  const sub = subtotal(invoice);
  const discount = sub * (invoice.discountPct ?? 0) / 100;
  const tax = sub * (invoice.taxPct ?? 0) / 100;
  return sub - discount + tax;
}

/** What the API and the PDF show for an invoice. */
export function summary(invoice) {
  return {
    id: invoice.id,
    customer: invoice.customer,
    issued: formatDate(invoice.issued),
    status: invoice.status,
    subtotal: cents(subtotal(invoice)),
    total: total(invoice),
  };
}
