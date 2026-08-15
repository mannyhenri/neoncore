/**
 * Every dispatched step must tell the agent to report via the MCP TOOL, not a raw curl.
 *
 * THE HALF-FINISHED MIGRATION THIS CLOSES. mcp-server.ts:13 describes
 * `neoncore_report_step_done` as the "reliable replacement for the curl webhook", and the
 * tool's own description tells the agent to call it "instead of curling the webhook". But
 * workflow-executor-v2 kept appending a raw curl to every step prompt, so the replacement was
 * built, documented as the replacement, and never adopted by the thing it replaced. The agent
 * only ever saw the curl.
 *
 * WHY CURL FAILS SILENTLY, WHICH IS THE WORST WAY TO FAIL:
 *   · `${NEONCORE_URL:-…}` resolves in the AGENT's shell. Pointed at the wrong machine, the
 *     completion POSTs somewhere else and the step hangs forever with no error anywhere.
 *   · No Authorization header. With strict auth on — precisely what you enable before leaving
 *     a machine unattended — every step completion is rejected. The queue's own workflow
 *     dispatcher hit this and had to attach the fleet token explicitly.
 *   · The payload is single-quoted JSON containing the agent's prose. One apostrophe in
 *     "don't", or a newline in pasted command output, breaks the command.
 *   · A shell command buried at the end of a ~2000-char prompt is simply less likely to be
 *     run than a tool in the agent's tool list. Observed: gridlight ran four greps for CE
 *     Brainstorm, never ran the curl, and the step sat at result_len=0.
 *
 * The set is the three instruction builders. Migrating two of three would leave panel steps
 * on the fragile path — the exact partial fix this file exists to prevent.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  __buildCompletionSuffixForTests as buildCompletionSuffix,
  __buildPanelCompletionSuffixForTests as buildPanelCompletionSuffix,
} from '../src/lib/workflow-executor-v2.ts';

const MCP_TOOL = 'neoncore_report_step_done';

/** Every completion instruction a dispatched prompt can carry. */
const INSTRUCTIONS: { label: string; text: string; requiresVerification: boolean; panelAgent?: string }[] = [
  {
    label: 'gate step (verdict only, no scope/verify)',
    text: buildCompletionSuffix('step-gate', false),
    requiresVerification: false,
  },
  {
    label: 'work step (work standard: scope + verify)',
    text: buildCompletionSuffix('step-work', true),
    requiresVerification: true,
  },
  {
    label: 'panel member (per-agent channel)',
    text: buildPanelCompletionSuffix('step-panel', 'agent-42'),
    requiresVerification: false,
    panelAgent: 'agent-42',
  },
];

test('the registry covers every builder in the executor', () => {
  // Derived from the source so a fourth builder cannot be added without an entry here.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/lib/workflow-executor-v2.ts'), 'utf8');
  const builders = [...src.matchAll(/function build\w*CompletionSuffix\(/g)].length;
  assert.equal(builders, 2, `expected 2 builder functions, found ${builders} — update this registry`);
  assert.equal(INSTRUCTIONS.length, 3, 'two builders produce three instruction shapes (gate / work / panel)');
});

test('EVERY instruction names the MCP tool', () => {
  const missing = INSTRUCTIONS.filter((i) => !i.text.includes(MCP_TOOL)).map((i) => i.label);
  assert.deepEqual(missing, [],
    `these still send the agent to a raw curl:\n  ${missing.join('\n  ')}`);
});

test('EVERY instruction leads with the tool, not the curl', () => {
  // Order is the instruction. A curl above the tool call is the one the agent runs.
  const wrong: string[] = [];
  for (const i of INSTRUCTIONS) {
    const tool = i.text.indexOf(MCP_TOOL);
    const curl = i.text.indexOf('curl ');
    if (curl !== -1 && curl < tool) wrong.push(`${i.label}: curl appears before the tool`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY instruction carries the step id the agent must report against', () => {
  const wrong = INSTRUCTIONS.filter((i, n) => !i.text.includes(['step-gate', 'step-work', 'step-panel'][n]))
    .map((i) => i.label);
  assert.deepEqual(wrong, [], `no stepId to report against:\n  ${wrong.join('\n  ')}`);
});

test('work steps still demand scope AND verify; gates still do not', () => {
  // The work standard must survive the transport change — this is the property that makes a
  // completion mean something, and it is easy to drop while rewriting the wording.
  const wrong: string[] = [];
  for (const i of INSTRUCTIONS) {
    const hasScope = /scope/i.test(i.text);
    const hasVerify = /verify/i.test(i.text);
    if (i.requiresVerification && !(hasScope && hasVerify)) {
      wrong.push(`${i.label}: lost the scope/verify requirement`);
    }
    if (!i.requiresVerification && hasScope && hasVerify) {
      wrong.push(`${i.label}: demands scope/verify, which is meaningless for a verdict`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the panel instruction keeps its per-agent channel', () => {
  // Panel members all report against the SAME step. Without the agent id the first responder
  // would complete the step for everyone and the deliberation would collapse to one voice.
  const panel = INSTRUCTIONS.find((i) => i.panelAgent)!;
  assert.match(panel.text, /agent-42/, 'the panel instruction lost its per-agent identity');
});

test('curl survives ONLY as an explicitly labelled fallback', () => {
  // Not deleted: an agent whose MCP server is missing needs a way out, and the MCP tool's own
  // error path already points at the curl. But it must read as the fallback, never the
  // instruction, or we are back where we started.
  for (const i of INSTRUCTIONS) {
    if (!i.text.includes('curl ')) continue;
    assert.match(i.text, /fallback|only if|unavailable|not available/i,
      `${i.label}: curl is present but not marked as a fallback`);
  }
});

test('the MCP tool can actually complete a PANEL step, or the panel instruction is a lie', () => {
  // neoncore_report_step_done posts to /webhook/:stepId/complete. A panel member needs
  // /webhook/:stepId/panel/:agentId/complete — a different route. Telling panel members to use
  // the tool without that support would send their verdict to the wrong endpoint.
  const mcp = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/mcp-server.ts'), 'utf8');
  assert.match(mcp, /panel/i, 'the MCP tool has no panel support, so panel steps cannot report through it');
});
