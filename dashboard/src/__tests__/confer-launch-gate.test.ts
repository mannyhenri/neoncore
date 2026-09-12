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

const SURFACES = conferLaunchSurfaces();

describe('a fully-specified confer is launchable everywhere it is offered', () => {
  it('the scan is non-vacuous', () => {
    expect(SURFACES.map((s) => s.file).join('\n')).toMatch(/WorkflowPanel\.tsx/);
    // Desk: WorkflowPanel, GoalsPage, WorkflowCanvasEditor. Phone: WorkflowsScreen.
    expect(SURFACES.length, 'confer launch surfaces disappeared from the scan')
      .toBeGreaterThanOrEqual(4);
  });

  it.each(SURFACES)('$file gates its launch on confer, not on one cartridge', ({ file, src }) => {
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
});
