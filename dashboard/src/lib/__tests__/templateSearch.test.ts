/**
 * FINDING A TEMPLATE AMONG 26.
 *
 * The picker had category tabs and nothing else. That works at 8 templates and stops working
 * at 26 — you know the workflow exists, you just cannot remember whether someone filed it
 * under quality or delivery.
 *
 * THREE DECISIONS WORTH PINNING:
 *
 *  1. SEARCH SPANS EVERY CATEGORY. Typing "canary" while the Quality tab is active must find
 *     the Ship workflow, which lives under Delivery. A search that silently obeys the active
 *     tab returns nothing and reads as "we don't have one" — the exact wrong answer.
 *  2. STEP NAMES ARE SEARCHABLE. `stepSummary.stepNames` already reaches the client. Half of
 *     what you remember about a workflow is a step inside it ("the one with the STRIDE
 *     review"), and the name and description often do not contain that word.
 *  3. NO MATCH IS A STATED RESULT, not an empty list. An empty container looks identical to
 *     a broken filter.
 */
import { describe, it, expect } from 'vitest';
import { searchTemplates, type SearchableTemplate } from '../templateSearch';

const T = (name: string, description = '', stepNames: string[] = []): SearchableTemplate =>
  ({ name, description, stepSummary: { stepNames } });

const LIBRARY: SearchableTemplate[] = [
  T('CE: Phase 6 — Ship', 'Document release → human merge approval → land & deploy.',
    ['Document Release', 'Merge Gate', 'Land & Deploy', 'Canary Watch', 'Canary Decision']),
  T('Full QA Review', 'Golden path → edge cases → error handling → performance → security.',
    ['Golden Path Testing', 'Edge Case Testing', 'Accessibility Review', 'QA Report']),
  T('Bug Hunter', 'Proactive bug hunt: static analysis → dead code → bug pattern scan.',
    ['Static & Lint Analysis', 'Dead Code Scan', 'Implement Fixes']),
  T('Daily AI Research Digest', 'Searches the web for the last 24-48h of AI news.',
    ['Scan the Web', 'Filter for Relevance', 'Render the Digest']),
  T('CE: Phase 4 — Review', '6 specialist agents run in parallel.',
    ['Security Sentinel', 'CSO / STRIDE Review', 'Performance Oracle', 'Open PR']),
];

/** The three fields a query is matched against. */
const SEARCHABLE = ['name', 'description', 'stepNames'] as const;

describe('template search', () => {
  it('EVERY searchable field can find a template', () => {
    const cases: { field: typeof SEARCHABLE[number]; query: string; expect: string }[] = [
      { field: 'name',        query: 'bug hunter',  expect: 'Bug Hunter' },
      { field: 'description', query: 'golden path', expect: 'Full QA Review' },
      // The one a name/description search cannot reach: you remember the STEP.
      { field: 'stepNames',   query: 'stride',      expect: 'CE: Phase 4 — Review' },
    ];
    expect(cases.length).toBe(SEARCHABLE.length);

    const missed: string[] = [];
    for (const c of cases) {
      const found = searchTemplates(LIBRARY, c.query).map((t) => t.name);
      if (!found.includes(c.expect)) missed.push(`${c.field}: "${c.query}" → [${found.join(', ')}]`);
    }
    expect(missed, `a searchable field did not match:\n  ${missed.join('\n  ')}`).toEqual([]);
  });

  it('is case- and whitespace-insensitive — nobody types exact case', () => {
    for (const q of ['CANARY', 'canary', '  Canary  ', 'CaNaRy']) {
      expect(searchTemplates(LIBRARY, q).map((t) => t.name), `"${q}" missed`)
        .toContain('CE: Phase 6 — Ship');
    }
  });

  it('matches every word, in any order — "qa report" and "report qa" are the same search', () => {
    const a = searchTemplates(LIBRARY, 'qa report').map((t) => t.name);
    const b = searchTemplates(LIBRARY, 'report qa').map((t) => t.name);
    expect(a).toEqual(b);
    expect(a).toContain('Full QA Review');
    // Every word must match SOMETHING — this is an AND, not an OR, or a second word only
    // ever widens the result and typing more makes searching worse.
    expect(searchTemplates(LIBRARY, 'qa canary')).toEqual([]);
  });

  it('an empty query returns everything, unchanged and in order', () => {
    for (const q of ['', '   ']) {
      expect(searchTemplates(LIBRARY, q)).toEqual(LIBRARY);
    }
  });

  it('a query that matches nothing returns nothing — not everything', () => {
    // The failure that makes a search box useless: an unmatched query falling back to the
    // full list, so it looks like search silently did nothing.
    expect(searchTemplates(LIBRARY, 'kubernetes helm chart')).toEqual([]);
  });

  it('search is not scoped to a category — the tab must not hide a match', () => {
    // "canary" lives in a Delivery template. Searching it while another tab is active has to
    // find it, or the honest answer "we have one" is reported as "we don't".
    const hit = searchTemplates(LIBRARY, 'canary');
    expect(hit.map((t) => t.name)).toEqual(['CE: Phase 6 — Ship']);
    // Proven by construction: the function takes no category argument at all.
    expect(searchTemplates.length).toBe(2);
  });

  it('handles a template with no description or steps without throwing', () => {
    const sparse = [{ name: 'Bare' } as SearchableTemplate];
    expect(searchTemplates(sparse, 'bare').map((t) => t.name)).toEqual(['Bare']);
    expect(searchTemplates(sparse, 'anything else')).toEqual([]);
  });

  it('the panel uses the shared search and states when nothing matched', () => {
    return import('fs').then(({ readFileSync }) => import('path').then(({ resolve }) => {
      const src = readFileSync(resolve(__dirname, '../../components/WorkflowPanel.tsx'), 'utf8');
      expect(src, 'WorkflowPanel does not use searchTemplates').toMatch(/searchTemplates\(/);
      expect(src, 'no empty-result message — an empty list reads as a broken filter')
        .toMatch(/No template matches|no templates match/i);
    }));
  });
});
