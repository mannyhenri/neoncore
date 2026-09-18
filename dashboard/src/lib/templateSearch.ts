/**
 * Finding one template among 26.
 *
 * The picker had category tabs and nothing else, which works at eight templates and stops
 * working somewhere around twenty — you know the workflow exists, you just cannot remember
 * whether it was filed under quality or delivery.
 *
 * THREE THINGS THIS DOES DELIBERATELY:
 *
 *  · IT TAKES NO CATEGORY. Search spans the whole library by construction, so typing "canary"
 *    while the Quality tab is active still finds the Ship workflow under Delivery. A search
 *    that quietly obeys the active tab answers "we don't have one", which is worse than no
 *    search at all.
 *
 *  · IT SEARCHES STEP NAMES. `stepSummary.stepNames` already reaches the client, and half of
 *    what anyone remembers about a workflow is a step inside it — "the one with the STRIDE
 *    review" — a phrase that appears in neither the name nor the description.
 *
 *  · EVERY WORD MUST MATCH (AND, not OR). With OR, each extra word you type WIDENS the
 *    result, so refining a search makes it worse. Word order does not matter, because nobody
 *    remembers whether it was "QA report" or "report QA".
 */

export interface SearchableTemplate {
  name: string;
  description?: string;
  stepSummary?: { stepNames?: string[] };
}

/**
 * Everything about a template a person might type.
 *
 * Fields are joined with a separator that cannot appear inside one, so a query never matches
 * across a boundary — "review open" must not match a template whose description ends in
 * "review" and whose first step begins "Open PR".
 */
function haystack(t: SearchableTemplate): string {
  return [
    t.name,
    t.description ?? '',
    ...(t.stepSummary?.stepNames ?? []),
  ].join(' ~|~ ').toLowerCase();
}

/**
 * The templates matching `query`, in their original order.
 *
 * An empty query returns the input untouched — searching for nothing is not a filter. A query
 * that matches nothing returns nothing, NOT the full list: falling back to everything is how a
 * search box comes to look like it is ignoring you.
 */
export function searchTemplates<T extends SearchableTemplate>(templates: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...templates];
  return templates.filter((t) => {
    const hay = haystack(t);
    return words.every((w) => hay.includes(w));
  });
}
