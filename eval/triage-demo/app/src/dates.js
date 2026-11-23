/** Dates as users see them: YYYY-MM-DD, in UTC. */

const pad = (n) => String(n).padStart(2, '0');

export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth())}-${pad(d.getUTCDate())}`;
}

/** Whole days from `a` to `b`. */
export function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}
