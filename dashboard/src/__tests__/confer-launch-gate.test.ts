import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A fully-specified run-level confer must be CLICKABLE on every surface that offers one.
 *
 * Reported as "can't start Epic: Task by Task with a confer". Nothing errored: the Run button
 * was simply grey. Every launch gate was written when "who runs this" meant one cartridge, so
 * it reads the single-cartridge state (`runAgentId` / `agentId` / `deferredAssignments`) and
 * calls an empty one unrunnable. Run-level confer arrived later and deliberately leaves that
 * state empty — no single cartridge owns a step — so picking participants makes the button
 * LESS clickable, not more. The server already understands the mode
 * (lib/workflow-launch.ts `confersEveryStep`, routes/workflows.ts `conferAllSteps`), and the
 * phone already gates correctly. Only the desk's buttons never learned.
 *
 * SET-BASED over the surfaces DISCOVERED in the source, not a list typed here, because the
 * failure this prevents is the partial fix: three launchers offer confer and fixing two looks
 * identical from the one you didn't open. A surface added later is covered the day it lands.
 *
 * It reads source rather than rendering because `disabled` is a static expression, and
 * rendering WorkflowCanvasEditor or GoalsPage would mean mocking the API, the socket and the
 * agent tree to answer a question the text already answers.
 *
 * ── WHAT THIS TEST MISSED, AND WHY IT WAS REPORTED THREE MORE TIMES ───────────────────
 * The version above checked `disabled={...}` and NOTHING ELSE. But the rule lives twice in
 * every one of these surfaces — once in the button and once in the click handler's own guard —
 * and the two halves were fixed independently, each time only one of them:
 *
 *   · WorkflowCanvasEditor: the HANDLER got `confering ||`, the button did not → grey button.
 *     That is the report this file was written for, and checking `disabled` caught it.
 *   · WorkflowPanel: the BUTTON got `conferAgents.length >= 2 ||`, the handler did not → a
 *     GREEN button whose handler hit a bare `return` on its first line. Silent. This test went
 *     green on that fix and the bug survived it, through three more reports.
 *
 * So the scan now covers the handler too, and a surface that DELEGATES both halves to one
 * shared predicate (`launchBlockers`, lib/launchReadiness.ts) satisfies it outright — that is
 * strictly stronger than two expressions that merely happen to agree today.
 */

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

/** Comments say what code does NOT do as often as what it does — never scan them. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * THE SET: every surface that lets a person pick run-level confer participants.
 *
 * `setConferAgents(` is the picker's own write — a surface that merely displays a confer, or
 * forwards the field without a picker, cannot produce this bug and is correctly absent.
 */
function conferLaunchSurfaces(): { file: string; src: string }[] {
  const files = [
    ...walk(path.join(REPO, 'dashboard', 'src')),
    ...walk(path.join(REPO, 'mobile', 'src')),
  ];
  return files
    .map((f) => ({ file: path.relative(REPO, f), src: strip(fs.readFileSync(f, 'utf8')) }))
    .filter(({ src }) => src.includes('setConferAgents('))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Every `disabled={...}` expression in a file, brace-balanced so nested objects survive. */
function disabledExpressions(src: string): string[] {
  const out: string[] = [];
  const needle = 'disabled={';
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    let depth = 1;
    let j = i + needle.length;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    out.push(src.slice(i + needle.length, j - 1));
  }
  return out;
}

/**
 * Gates that demand a SINGLE cartridge. These are the expressions confer has to be exempt
 * from; a gate on `starting` or `templateId` is orthogonal and left alone.
 */
const SINGLE_CARTRIDGE = /\brunAgentId\b|\bagentId\b|\bdeferredAssignments\b/;
/** However the exemption is spelled — a hoisted `confering` flag counts. */
const CONFER_AWARE = /\bconferAgents\b|\bconfering\b/;

/**
 * A surface that routes BOTH halves through the shared predicate cannot have the two disagree,
 * so it needs no per-expression exemption check.
 */
const DELEGATES = /\blaunchBlockers\s*\(/;

/**
 * The click handler's own guard — the half this file did not read, and where the silent
 * version of this bug lived. A bare `return` in here is invisible: no error, no state change,
 * nothing in the console.
 */
function launchHandlerGuards(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:const|function)\s+handle\w*Run\w*\s*=?\s*(?:async\s*)?(?:\([^)]*\)\s*=>|\()/g)) {
    // The guard block is the opening of the handler, before any await — every version of this
    // bug was a validity check on the first few lines.
    const body = src.slice(m.index ?? 0, (m.index ?? 0) + 900);
    for (const g of body.matchAll(/if\s*\(([^)]*(?:runAgentId|deferredAssignments|allAgentsAssigned|agentId)[^)]*)\)/g)) {
      out.push(g[1]);
    }
    // …including the assignment that feeds such a check.
    for (const g of body.matchAll(/const\s+all\w*Assigned\s*=([\s\S]{0,300}?);/g)) out.push(g[1]);
  }
  return out;
}

const SURFACES = conferLaunchSurfaces();

describe('a fully-specified confer is launchable everywhere it is offered', () => {
  it('the scan is non-vacuous', () => {
    expect(SURFACES.map((s) => s.file).join('\n')).toMatch(/WorkflowPanel\.tsx/);
    // Desk: WorkflowPanel, GoalsPage, WorkflowCanvasEditor. Phone: WorkflowsScreen.
    expect(SURFACES.length, 'confer launch surfaces disappeared from the scan')
      .toBeGreaterThanOrEqual(4);
  });

  it.each(SURFACES)('$file gates its BUTTON on confer, not on one cartridge', ({ file, src }) => {
    if (DELEGATES.test(src)) return; // one predicate for both halves — nothing to disagree about

    const gates = disabledExpressions(src).filter((e) => SINGLE_CARTRIDGE.test(e));
    expect(gates.length, `${file} offers confer but no launch gate reads the cartridge — `
      + 'the scan found nothing to check, which hides a regression rather than catching it')
      .toBeGreaterThan(0);

    const blind = gates.filter((e) => !CONFER_AWARE.test(e));
    expect(blind, `${file}: ${blind.length} launch gate(s) require a single cartridge with no `
      + 'confer exemption, so picking 2+ participants leaves the button greyed out:\n'
      + blind.map((e) => `  disabled={${e.replace(/\s+/g, ' ').trim()}}`).join('\n'))
      .toEqual([]);
  });

  it.each(SURFACES)('$file gates its HANDLER on confer too — a green button that does nothing', ({ file, src }) => {
    // NO delegation escape hatch here, deliberately. `launchBlockers` appearing somewhere in a
    // file does not prove the handler uses it — the first version of this check exempted the
    // whole file on that basis and passed against the shipped bug. If the handler really
    // delegates, the scan below finds no single-cartridge guard and this passes on its own.
    const blind = launchHandlerGuards(src).filter(
      (g) => SINGLE_CARTRIDGE.test(g) && !CONFER_AWARE.test(g));
    expect(blind, `${file}: the click handler refuses a fully-specified confer even though the `
      + 'button allows it. The user sees a green button that does nothing at all — the handler '
      + 'returns before making any request:\n'
      + blind.map((g) => `  ${g.replace(/\s+/g, ' ').trim()}`).join('\n'))
      .toEqual([]);
  });
});
