/**
 * A SHORT, HUMAN SUBJECT FOR A RUN — so a list can say what it is without a uuid.
 *
 * REPORTED: "Can we not list the tasks/workflows/confer with codenames/ids and the actual name
 * of the prompt and workflow used."
 *
 * Most of that was already stored. A run carries `name` (the template it came from),
 * `run_number`, and `initial_context` (the prompt). What was missing is a short SUBJECT, because
 * `initial_context` is only sometimes label-shaped:
 *
 *   "GRD-3665"                                                     8 chars, already perfect
 *   "We need to investigate what's involved in developing for      340 chars, a paragraph that
 *    thor Arm64...and create the epic for it. See we have a         cannot be a row in a list
 *    demo in 4 weeks for this platform"
 *
 * `workflows.context_label` exists for exactly this and was DEAD — present in the schema, null on
 * every row, written nowhere in server/ or dashboard/, and dropped by `normalizeWorkflow` on the
 * way out. The socket was built and never wired.
 *
 * ── WHY A TRACKER KEY WINS OVER THE FIRST WORDS ────────────────────────────────────────
 * When a prompt names a ticket, that ticket IS the subject — it is what the person will search
 * for, what the branch is named after, and what the other agents call it. "GRD-3412" beats
 * "Please look at GRD-3412 and fix the gall…" on every axis. Only when there is no key does the
 * prose become the label.
 *
 * ── FIRST KEY, NOT LAST ────────────────────────────────────────────────────────────────
 * "Refactor GRD-1001 and then GRD-1002" is about GRD-1001; the second is a consequence. Taking
 * the last would label the run after its own follow-up work.
 */

/** How long a label may be. A list row, not a description — it sits beside a name and a number. */
export const LIBELLE_MAX = 48;

/** Tracker keys: two-or-more uppercase letters, a dash, digits. GRD-3665, ABC-12. */
const CLE_TRACKER = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/**
 * A short subject for a run, derived from the prompt it was given.
 *
 * Returns '' for an empty prompt rather than inventing something: a run with no context is
 * legitimately identified by its template name and run number alone, and a fabricated subject
 * would be worse than none.
 */
export function libelleContexte(initialContext: string | null | undefined): string {
  const texte = (initialContext || '').trim();
  if (!texte) return '';

  // A named ticket is the subject. Cheapest and best label available.
  const cle = texte.match(CLE_TRACKER);
  if (cle) return cle[1];

  // Otherwise the opening of the prompt. First line only — a multi-line prompt's later lines are
  // detail, and a newline in a list row breaks the row.
  const premiere = texte.split('\n')[0].trim().replace(/\s+/g, ' ');
  if (premiere.length <= LIBELLE_MAX) return premiere;

  // Cut at a word boundary. A label ending "developi…" reads as corruption rather than brevity.
  const coupe = premiere.slice(0, LIBELLE_MAX - 2);
  const dernierEspace = coupe.lastIndexOf(' ');
  const garde = dernierEspace > LIBELLE_MAX / 2 ? coupe.slice(0, dernierEspace) : coupe;
  return `${garde.replace(/[,;:.\s]+$/, '')} …`;
}

/**
 * The one-line human identity of a run: what it is, which run, and what it is about.
 * Falls back cleanly — a run with no subject still reads as "Deep Research #11".
 */
export function libelleRun(
  name: string,
  runNumber: number | null | undefined,
  contextLabel: string | null | undefined,
): string {
  const tete = runNumber ? `${name} #${runNumber}` : name;
  const sujet = (contextLabel || '').trim();
  return sujet ? `${tete} — ${sujet}` : tete;
}
