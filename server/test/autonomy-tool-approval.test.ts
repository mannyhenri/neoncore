import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What `full` autonomy is allowed to approve on your behalf.
 *
 * FOUND IN A SECURITY REVIEW OF MY OWN CHANGE. The agent-waiting branch answers an
 * AskUserQuestion and then falls to an `else` that calls applyDecision(perm.id, 'allowed') for
 * ANY other tool. A cartridge not in trust mode that asks to run a Bash command inserts a
 * pending permission and goes `waiting`; at `full` that branch approved it with nobody looking.
 * 603 Bash permission requests passed through this server today, so the shape is not theoretical
 * — they are invisible in the permissions table only because trust mode short-circuits them
 * before the row is written (routes/permissions.ts: `if (trustMode && toolName !==
 * 'AskUserQuestion')` returns without inserting).
 *
 * The codebase already draws this line and I crossed it: TRUST MODE is the feature for
 * auto-approving tool calls, it is set per cartridge, and it deliberately EXCLUDES
 * AskUserQuestion. Autonomy is the feature for resolving workflow gates. Answering a question is
 * not the same act as authorising a shell command, and one setting should not silently confer
 * the other — N4's plan said `full` takes "decision gates and agent questions by their
 * configured default", never arbitrary tools.
 *
 * SET-BASED over the tool names that actually reach this code, taken from the live server log
 * rather than imagined, because the failure is a category error: any tool NOT explicitly
 * classified gets approved by an else-branch nobody re-reads.
 */

const SRC = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'lib', 'attention-notifier.ts'), 'utf8',
);

/** Comments quote the defect to explain it; a scanner that reads prose flags its own docs. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * THE SET: every tool_name observed hitting POST /permissions/request on this machine, with
 * whether `full` autonomy may settle it without a person.
 */
const TOOLS: { name: string; autoApprovable: boolean; why: string }[] = [
  { name: 'AskUserQuestion', autoApprovable: true, why: 'a question — answering is what full is for' },
  { name: 'ExitPlanMode', autoApprovable: true, why: 'reviewing a plan is a decision, and the plan is in the notice' },
  { name: 'Bash', autoApprovable: false, why: 'arbitrary shell execution — trust mode exists for this, per cartridge' },
  { name: 'Write', autoApprovable: false, why: 'writes files; trust mode territory' },
  { name: 'Read', autoApprovable: false, why: 'reads files; still a tool grant, not a question' },
  { name: 'Agent', autoApprovable: false, why: 'spawns further agents' },
  { name: 'WebSearch', autoApprovable: false, why: 'reaches the network' },
  { name: 'mcp', autoApprovable: false, why: 'an arbitrary MCP tool — unknown blast radius by definition' },
  { name: 'ToolSearch', autoApprovable: false, why: 'not a question' },
  { name: 'EnterPlanMode', autoApprovable: false, why: 'not a question' },
];

test('the tool table is real — an empty scan would pass vacuously', () => {
  assert.ok(TOOLS.length >= 8, `expected the observed tool set, got ${TOOLS.length}`);
  assert.ok(TOOLS.some((t) => t.name === 'Bash'), 'Bash must be in the set — it is 603 of the requests');
});

test('full does not approve tool calls by falling through an else', () => {
  /*
   * The defect in one line: an unconditional `applyDecision(perm.id, 'allowed')` reached by any
   * tool that is not AskUserQuestion. The fix is an explicit allow-list, so a tool added later
   * is REFUSED by default and a person decides, rather than being approved by omission.
   */
  const elseApprovesAnything =
    /}\s*else\s*{\s*applyDecision\(\s*perm\.id\s*,\s*'allowed'\s*\)\s*;/.test(CODE);

  assert.equal(elseApprovesAnything, false,
    'attention-notifier approves ANY non-question tool at full autonomy via an else branch — '
    + 'a Bash permission on a non-trust cartridge would be authorised with nobody looking');
});

test('the approvable tools are named explicitly, and Bash is not among them', () => {
  // An allow-list must actually list. This asserts the shape a reviewer can check by eye.
  assert.match(CODE, /ExitPlanMode/,
    'ExitPlanMode is not named — full should still approve a plan it showed you');

  const banned = TOOLS.filter((t) => !t.autoApprovable).map((t) => t.name);
  const named = banned.filter((n) => new RegExp(`'${n}'`).test(CODE));
  assert.deepEqual(named, [],
    `these tools appear as approvable in the auto-resolver: ${named.join(', ')} — `
    + 'trust mode is the per-cartridge setting for granting tools, not autonomy');
});
