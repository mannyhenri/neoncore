/** The demo's invoices: twelve, oldest first. */
const at = (iso) => new Date(`${iso}T09:00:00Z`);

export const INVOICES = [
  { id: 1001, customer: 'Harbour Cafe', issued: at('2026-01-15'), status: 'paid', discountPct: 0, taxPct: 0, lines: [{ description: 'Sample sachet', quantity: 1, unitPrice: 0.1 }, { description: 'Filter paper', quantity: 1, unitPrice: 0.2 }] },
  { id: 1002, customer: 'Lighthouse Books', issued: at('2026-02-03'), status: 'paid', discountPct: 0, taxPct: 10, lines: [{ description: 'Shelving', quantity: 2, unitPrice: 150 }] },
  { id: 1003, customer: 'Northwind Bikes', issued: at('2026-03-11'), status: 'paid', discountPct: 10, taxPct: 20, lines: [{ description: 'Tune-up', quantity: 4, unitPrice: 25 }] },
  { id: 1004, customer: 'Harbour Cafe', issued: at('2026-04-01'), status: 'sent', discountPct: 0, taxPct: 0, lines: [{ description: 'Milk', quantity: 10, unitPrice: 1.1 }] },
  { id: 1005, customer: 'Bluebell Florist', issued: at('2026-05-19'), status: 'sent', discountPct: 0, taxPct: 5, lines: [{ description: 'Vases', quantity: 6, unitPrice: 12.5 }] },
  { id: 1006, customer: 'Lighthouse Books', issued: at('2026-06-02'), status: 'draft', discountPct: 5, taxPct: 10, lines: [{ description: 'Lamps', quantity: 2, unitPrice: 40 }] },
  { id: 1007, customer: 'Northwind Bikes', issued: at('2026-07-07'), status: 'sent', discountPct: 0, taxPct: 20, lines: [{ description: 'Tyres', quantity: 8, unitPrice: 30 }] },
  { id: 1008, customer: 'Pebble Bakery', issued: at('2026-08-14'), status: 'paid', discountPct: 0, taxPct: 0, lines: [{ description: 'Flour', quantity: 20, unitPrice: 2.5 }] },
  { id: 1009, customer: 'Harbour Cafe', issued: at('2026-09-09'), status: 'sent', discountPct: 0, taxPct: 0, lines: [{ description: 'Cups', quantity: 100, unitPrice: 0.15 }] },
  { id: 1010, customer: 'Bluebell Florist', issued: at('2026-10-21'), status: 'draft', discountPct: 0, taxPct: 5, lines: [{ description: 'Ribbon', quantity: 3, unitPrice: 4 }] },
  { id: 1011, customer: 'Pebble Bakery', issued: at('2026-11-02'), status: 'sent', discountPct: 0, taxPct: 0, lines: [{ description: 'Boxes', quantity: 50, unitPrice: 0.8 }] },
  { id: 1012, customer: 'Lighthouse Books', issued: at('2026-11-18'), status: 'sent', discountPct: 0, taxPct: 10, lines: [{ description: 'Signage', quantity: 1, unitPrice: 90 }] },
];
