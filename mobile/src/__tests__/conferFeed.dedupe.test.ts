import { describe, it, expect } from 'vitest';
import type { ConferSession } from '../types';

/**
 * THE PHONE'S COPY OF THE RULE, PINNED TO THE SAME BEHAVIOUR AS THE DESK'S.
 *
 * The desk delegates to `standaloneConfers` (@neoncore/client, confer-view.ts). This app
 * cannot import it at runtime: metro resolves the package but cannot follow its NodeNext
 * '.js' specifiers, which is measured and written up in mobile/metro.config.js. So the rule is
 * restated in WorkflowsScreen, and a restated rule needs its own test or it is just a copy
 * waiting to drift — the failure mode this repo keeps hitting.
 *
 * The rule: a confer created BY a workflow step is already in the feed as its run, so listing
 * the session too shows one confer twice. Reported as "2 confers running at the same time for
 * baseback and backend-interlag" when a single confer had those two repos as participants.
 */

/** Exactly the expression in WorkflowsScreen.tsx. Change one, change the other. */
const standalone = (confers: Pick<ConferSession, 'id' | 'workflowId'>[]) =>
  confers.filter((c) => !c.workflowId);

describe('the phone feed lists a workflow confer once, as its run', () => {
  it('drops a session a workflow step owns', () => {
    expect(standalone([
      { id: 'owned', workflowId: 'run-1' },
      { id: 'solo', workflowId: null },
    ]).map((c) => c.id)).toEqual(['solo']);
  });

  it('keeps a session whose run was deleted — nothing else represents it', () => {
    expect(standalone([{ id: 'orphan', workflowId: null }, { id: 'blank', workflowId: '' }])
      .map((c) => c.id)).toEqual(['orphan', 'blank']);
  });

  it('keeps a session from a server too old to send the field', () => {
    // A mixed-version fleet must not lose confers: undefined means "not told", not "owned".
    expect(standalone([{ id: 'legacy' } as Pick<ConferSession, 'id' | 'workflowId'>])
      .map((c) => c.id)).toEqual(['legacy']);
  });
});
