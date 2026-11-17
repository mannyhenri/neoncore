/**
 * The Confer launch form's optional Jira epic.
 *
 * Confer works one task, or every task of a Jira epic. The epic travels in the run's launch
 * context as a `JIRA EPIC: KEY` line, which the template's first step ("Scope the Work") looks
 * for before it looks the epic up. The server owns that convention:
 * CONFER_EPIC_LINE in server/src/lib/templates/confer.ts — the two are checked against each
 * other by server/test/template-library.test.ts.
 */
export const CONFER_EPIC_LINE = 'JIRA EPIC:';

/** An epic key typed as a key, a browse URL, or with stray spaces → `GRD-1712`; '' if none. */
export function normalizeEpicKey(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const key = text.match(/[A-Za-z][A-Za-z0-9_]*-\d+/);
  return key ? key[0].toUpperCase() : text;
}

/** The launch context for a Confer run: the epic line first (when given), then the task text. */
export function conferLaunchContext(task: string, epic: string): string {
  const key = normalizeEpicKey(epic);
  return [key ? `${CONFER_EPIC_LINE} ${key}` : '', task.trim()].filter(Boolean).join('\n\n');
}
