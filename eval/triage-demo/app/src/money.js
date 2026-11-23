/** Money helpers. Amounts are dollars as numbers; what a user sees is rounded to the cent. */

/** Round to the cent. */
export function cents(amount) {
  return Math.round(amount * 100) / 100;
}

/** "$1,234.50" */
export function formatMoney(amount) {
  const [whole, frac] = cents(amount).toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
