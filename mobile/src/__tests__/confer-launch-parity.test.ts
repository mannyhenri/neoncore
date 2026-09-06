import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The phone can launch a run-level confer, not just watch one.
 *
 * `conferAllSteps` shipped wired through mobile/src/api.ts with no UI to reach it — the phone
 * could send the field and no user could ever cause it to. That is the same shape as the 105
 * capabilities missing from iOS: the plumbing exists, the surface does not, and nothing fails.
 *
 * SET-BASED over what the DESK's launcher does, read from WorkflowPanel.tsx, because parity is
 * the actual requirement — a picker that lets you choose participants but not override the
 * single-cartridge selection would launch a confer AND a run-level agent, and the server would
 * take the last writer. Half a launcher is worse than none: it fails as a run that quietly did
 * something other than what the screen said.
 */

const MOBILE = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(MOBILE, p), 'utf8');
/** Comments describe what code does NOT do as often as what it does. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SCREEN = 'src/screens/WorkflowsScreen.tsx';

/**
 * THE SET: every property the desk's confer launcher has. Each is a way to get a confer launch
 * wrong that produces no error — the reason this is checked rather than reviewed.
 */
const PROPERTIES: { key: string; why: string; holds: (src: string) => boolean }[] = [
  {
    key: 'participant-state',
    why: 'a confer needs a LIST of cartridges; one selected id cannot express it',
    holds: (s) => /conferAgents/.test(s) && /useState<string\[\]>/.test(s),
  },
  {
    key: 'multi-select',
    why: 'tapping a second cartridge must add it, not replace the first',
    holds: (s) => /conferAgents.*includes\(|includes\(a\.id\)/.test(s)
      && /filter\(\(?x\)? =>|prev\.filter/.test(s),
  },
  {
    key: 'sends-the-field',
    why: 'the whole point — without it the run launches single-owner and looks identical',
    // Matches the PROPERTY, not one spelling. The first version demanded a literal
    // `conferAgents.length >= 2 ?` and failed against a correct implementation that hoisted
    // the condition into a `confering` variable — a guard written against guessed code.
    holds: (s) => /startWorkflow\([\s\S]{0,400}conferAgents/.test(s),
  },
  {
    key: 'overrides-single-cartridge',
    why: 'sending both a run agent and participants makes the outcome depend on write order',
    // The run agent must be BLANKED when conferring, however the condition is spelled.
    holds: (s) => /(confering|conferAgents\.length >= 2)\s*\?\s*''\s*:\s*agentId/.test(s),
  },
  {
    key: 'requires-two',
    why: 'a one-cartridge confer is an ordinary dispatch, and the server rejects it — say so '
      + 'here rather than sending a request that cannot succeed',
    holds: (s) => /conferAgents\.length === 1/.test(s),
  },
  {
    key: 'launchable-without-a-run-agent',
    why: 'the start button gates on agentId; in confer mode there IS no single agent, so a '
      + 'fully-specified confer would be unclickable',
    // Anchored to `disabled`, which is what actually gates the button. The first version
    // matched the same expression in the STYLE prop and passed a mutation that reverted
    // `disabled` to `!agentId` — leaving a fully-specified confer greyed out while the
    // button merely LOOKED enabled.
    holds: (s) => /disabled=\{[^}]*conferAgents\.length < 2/.test(s),
  },
];

describe('the phone can launch a run-level confer', () => {
  it('scans are non-vacuous', () => {
    expect(code(SCREEN).length, 'WorkflowsScreen unreadable').toBeGreaterThan(500);
    expect(code('src/api.ts'), 'api.ts lost conferAllSteps').toMatch(/conferAllSteps/);
  });

  it('has EVERY property the desk launcher has', () => {
    const src = code(SCREEN);
    const missing = PROPERTIES.filter((p) => !p.holds(src)).map((p) => `${p.key} — ${p.why}`);
    expect(missing, `the phone's confer launcher is incomplete:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('the property set is enumerated, not sampled', () => {
    expect(PROPERTIES.length).toBe(6);
  });
});
