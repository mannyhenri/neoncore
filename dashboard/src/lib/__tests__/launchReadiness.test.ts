/**
 * CAN THIS LAUNCH START? ONE ANSWER, FOR THE BUTTON AND FOR THE HANDLER.
 *
 * THE BUG, reported three times: "if I select Run on and select two projects, the Run Workflow
 * button turns green but doesn't start."
 *
 * Both were true. The rule lived TWICE in WorkflowPanel:
 *   · the button's `disabled=` expression, which HAD a confer branch (`conferAgents.length >= 2`)
 *   · `handleDeferredRun`'s own `allAgentsAssigned` guard, which did NOT
 * In confer mode the single-cartridge <select> is not rendered, so `runAgentId` stays ''. The
 * button therefore enabled and the handler hit `if (!allAgentsAssigned) return` on its first
 * line — a bare `return`, no error, no state change, nothing in the console. A dead green button.
 *
 * Fixing the confer branch in the handler would have fixed this instance and left the class:
 * two copies of one predicate, drifting apart the next time a launch mode is added. So there is
 * one function, both callers use it, and this asserts over every MODE rather than over the one
 * that was reported.
 *
 * THE SECOND DEFECT, which is why it took three reports: the guard returned SILENTLY. Even when
 * refusing correctly it said nothing. Every blocker now carries a sentence, and the test asserts
 * a blocked launch always has one — an unexplained refusal is the bug wearing a different hat.
 */
import { describe, it, expect } from 'vitest';
import { launchBlockers, type LaunchState } from '../launchReadiness';

const base: LaunchState = {
  projectId: 'p1',
  agentStepCount: 3,
  perStepAgents: false,
  assignments: {},
  runAgentId: '',
  conferAgents: [],
  promptSteps: [],
  prompts: {},
  requiresContext: false,
  initialContext: '',
};

/** Every way a launch can legitimately supply its cartridges. */
const MODES: { name: string; state: Partial<LaunchState> }[] = [
  { name: 'nothing deferred', state: { agentStepCount: 0 } },
  { name: 'one cartridge for the whole run', state: { runAgentId: 'cart-a' } },
  { name: 'a cartridge per step', state: { perStepAgents: true, assignments: { s1: 'a', s2: 'b', s3: 'c' } } },
  { name: 'confer across two cartridges', state: { conferAgents: ['cart-a', 'cart-b'] } },
  { name: 'confer across three cartridges', state: { conferAgents: ['a', 'b', 'c'] } },
];

describe('launch readiness', () => {
  it('EVERY way of supplying cartridges is accepted — including confer', () => {
    const refused: string[] = [];
    for (const m of MODES) {
      const blockers = launchBlockers({ ...base, ...m.state, assignments: m.state.assignments ?? {} });
      if (blockers.length > 0) refused.push(`${m.name} → ${blockers.join('; ')}`);
    }
    expect(refused, `a fully-specified launch was refused:\n  ${refused.join('\n  ')}`).toEqual([]);
    expect(MODES.length).toBeGreaterThanOrEqual(5);
  });

  it('confer with two cartridges needs no single-cartridge pick — the select is not even shown', () => {
    // The exact reported case: Run on → two cartridges, nothing else touched.
    expect(launchBlockers({ ...base, conferAgents: ['cart-a', 'cart-b'] })).toEqual([]);
  });

  it('ONE cartridge is not a confer — it still needs a cartridge picked', () => {
    // Otherwise "confer" becomes a way to launch with nothing assigned at all.
    const blockers = launchBlockers({ ...base, conferAgents: ['cart-a'] });
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('EVERY refusal explains itself — a silent block is the bug being fixed', () => {
    const blockedStates: { why: string; state: Partial<LaunchState> }[] = [
      { why: 'no project', state: { projectId: '' } },
      { why: 'no cartridge at all', state: {} },
      { why: 'per-step with a gap', state: { perStepAgents: true, assignments: { s1: 'a' } } },
      { why: 'one-cartridge confer', state: { conferAgents: ['solo'] } },
      { why: 'missing prompt input', state: {
        runAgentId: 'a',
        promptSteps: [{ stepId: 's1', field: 'prompt', label: 'Prompt', stepName: 'Step' }],
        prompts: {},
      } },
      { why: 'required context left empty', state: { runAgentId: 'a', requiresContext: true } },
    ];
    for (const b of blockedStates) {
      const blockers = launchBlockers({ ...base, ...b.state, assignments: b.state.assignments ?? {} });
      expect(blockers.length, `"${b.why}" was allowed through`).toBeGreaterThan(0);
      for (const msg of blockers) {
        expect(msg.length, `"${b.why}" produced an empty blocker message`).toBeGreaterThan(10);
      }
    }
  });

  it('the panel has no SECOND copy of this rule', () => {
    // The whole point. Two copies is what produced a green button wired to a dead handler.
    // Both the disabled= expression and the handler must call launchBlockers and nothing else.
    // (Read as a string so this fails on a re-introduced inline predicate, not on a type error.)
    return import('fs').then(({ readFileSync }) =>
      import('path').then(({ resolve }) => {
        const src = readFileSync(
          resolve(__dirname, '../../components/WorkflowPanel.tsx'), 'utf8');
        expect(src, 'WorkflowPanel does not use the shared predicate').toMatch(/launchBlockers\(/);
        // The old inline shape, in either copy.
        expect(src, 'an inline allAgentsAssigned predicate is back').not.toMatch(/allAgentsAssigned/);
      }));
  });
});
