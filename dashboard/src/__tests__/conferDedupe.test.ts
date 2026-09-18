import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { activeStandaloneConfers, recentStandaloneConfers, isOwnedByRun } from '@neoncore/client';

/**
 * ONE CONFER IS ONE ENTRY, WHETHER OR NOT A WORKFLOW STARTED IT.
 *
 * Reported as "I have 2 confers running at the same time for baseback and backend-interlag —
 * is there an extra one?". There was not. One confer was running, with those two repos as its
 * two participants, and both cartridges read `working` because that is what participating in
 * a confer looks like. The second entry was the same confer counted again: runs come from
 * /api/workflows, confers from /api/confer, and a confer created by a workflow STEP appears in
 * both.
 *
 *   totalActive = activeRuns.length + activeV1.length + activeConfers.length   → 2
 *
 * A standalone confer has no run beside it and must still be listed, so the rule is not "hide
 * confers" but "hide the ones a run already represents".
 */
describe('a workflow-owned confer is not listed beside its own run', () => {
  const owned = { id: 'a', status: 'running', workflowId: 'run-1', completedAt: null };
  const solo = { id: 'b', status: 'running', workflowId: null, completedAt: null };
  const orphan = { id: 'c', status: 'running', workflowId: '', completedAt: null };

  it('drops the owned one and keeps the standalone one', () => {
    expect(activeStandaloneConfers([owned, solo]).map((c) => c.id)).toEqual(['b']);
  });

  it('keeps a confer whose run is gone — it has nothing else representing it', () => {
    // workflowId comes back null/'' when the owning run was deleted. Hiding it would make the
    // confer vanish from every list with no run left to show it.
    expect(activeStandaloneConfers([orphan]).map((c) => c.id)).toEqual(['c']);
    expect(isOwnedByRun(orphan)).toBe(false);
  });

  it('applies the same rule to the recent list, not just the active one', () => {
    const now = Date.now();
    const recentOwned = { id: 'd', status: 'completed', workflowId: 'run-2', completedAt: new Date(now - 1000).toISOString() };
    const recentSolo = { id: 'e', status: 'completed', workflowId: null, completedAt: new Date(now - 1000).toISOString() };
    const old = { id: 'f', status: 'completed', workflowId: null, completedAt: new Date(now - 60 * 60 * 1000).toISOString() };
    expect(recentStandaloneConfers([recentOwned, recentSolo, old], 10 * 60 * 1000, now).map((c) => c.id))
      .toEqual(['e']);
  });
});

/**
 * SET-BASED over the surfaces DISCOVERED in the source, not a list typed here.
 *
 * The rule lives on four surfaces across two apps — the desk's active list, its recent list,
 * its active count, and the phone's feed. Four copies is how three end up right and one stays
 * wrong, which is the same shape as the confer LAUNCH gate that was reported three times
 * (see confer-launch-gate.test.ts).
 *
 * The desk must DELEGATE to the shared helper. The phone cannot: metro resolves
 * @neoncore/client but cannot follow its NodeNext '.js' specifiers, so a runtime import from
 * it fails there (measured — see mobile/metro.config.js). The phone is therefore allowed to
 * restate the rule, but it must still be keyed on `workflowId`; filtering confers by status
 * alone is the bug.
 */
describe('every surface that lists confers beside runs applies the rule', () => {
  const root = path.resolve(__dirname, '../../..');

  /**
   * Comments do not implement anything.
   *
   * The first version of this scan searched the raw file, and the comment above the desk's
   * filter says the word `standaloneConfers`. Mutating the real call sites back to the broken
   * form left that comment in place, and the test PASSED on code that listed a workflow confer
   * twice. Same false pass as the launch-gate test that only scanned `disabled={...}`: a check
   * that can be satisfied by prose is not a check.
   */
  const code = (file: string) => fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** Files that build a list mixing runs and confers. */
  function surfaces(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = code(p);
        /**
         * A surface is a file that turns a `confers` COLLECTION into a list. The pattern has
         * to match the correct form as well as the buggy one, or fixing the last offender
         * empties the scan and the test starts passing for the wrong reason — which is what
         * the first version of this file did.
         */
        if (/\bconfers\s*\.\s*(filter|map)\s*\(|\.\.\.confers\b|activeConfers|recentConfers|standaloneConfers/.test(src)) out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  it('the desk delegates to the shared helper', () => {
    const found = surfaces(path.join(root, 'dashboard/src'));
    expect(found.length, 'no desk surface lists confers — the scan is not scanning').toBeGreaterThan(0);
    const offenders = found.filter((f) => {
      return !/(activeStandaloneConfers|recentStandaloneConfers|standaloneConfers|isOwnedByRun)\s*\(/.test(code(f));
    });
    expect(offenders.map((f) => path.relative(root, f)), 
      'these desk surfaces build a confer list without the shared rule, so a workflow confer '
      + 'is listed beside the run that already represents it').toEqual([]);
  });

  it('the phone keys its own copy on workflowId', () => {
    const found = surfaces(path.join(root, 'mobile/src'));
    expect(found.length, 'no phone surface lists confers — the scan is not scanning').toBeGreaterThan(0);
    const offenders = found.filter((f) => !/workflowId/.test(code(f)));
    expect(offenders.map((f) => path.relative(root, f)),
      'these phone surfaces list confers without checking workflowId, so a workflow confer '
      + 'shows twice in the feed').toEqual([]);
  });
});
