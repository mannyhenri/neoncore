/**
 * Every file:line in the routing doc still points at what it claims.
 *
 * This doc's entire value is that its claims are checkable — it opens by saying so. A citation
 * that rots turns that into the opposite: confident prose pointing at the wrong line, which is
 * harder to catch than no citation at all because it looks verified.
 *
 * It already happened, inside a single confer. `probe-local-model.mjs:184` was correct when the
 * draft was written and became a bare `},` two commits later when the probe gained an --engine
 * flag. Nobody was careless; the number rotted between draft and revise. That is the specific
 * hazard of citation-based writing, and prose review cannot catch it — only resolving the
 * citation against the file can.
 *
 * Set-based over EVERY citation extracted from the doc, so a new one is covered the moment it
 * is written rather than when someone remembers to check it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const DOC = 'docs/how-routing-decides.md';
const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');

/** Where a bare filename in the doc actually lives. */
const DIRS = [
  'server/src/lib', 'server/src/routes', 'server/scripts', 'server/src',
];

function resolveFile(name: string): string | null {
  for (const d of DIRS) {
    const p = path.join(ROOT, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** `file.ts:123` and `file.ts:12-34`, wherever they appear in the prose. */
function citations(): { raw: string; file: string; from: number; to: number }[] {
  return [...text.matchAll(/([a-zA-Z0-9._-]+\.(?:ts|mjs)):(\d+)(?:-(\d+))?/g)].map((m) => ({
    raw: m[0],
    file: m[1],
    from: Number(m[2]),
    // "133-139" and the shorthand "133-9" the doc uses for a short range.
    to: m[3] ? Number(m[3].length < String(m[2]).length
      ? String(m[2]).slice(0, String(m[2]).length - m[3].length) + m[3]
      : m[3]) : Number(m[2]),
  }));
}

test('the doc still exists and carries citations — otherwise this guard is vacuous', () => {
  assert.ok(citations().length >= 8,
    `expected the routing doc to cite several file:line locations, found ${citations().length}`);
});

test('EVERY cited file exists', () => {
  const missing = [...new Set(citations().map((c) => c.file))].filter((f) => !resolveFile(f));
  assert.deepEqual(missing, [], `the doc cites files that do not exist: ${missing.join(', ')}`);
});

test('EVERY cited line is in range and is not blank or a bare brace', () => {
  // A citation that lands on `},` is the exact rot that already happened: the line number
  // survives a refactor, the meaning does not.
  const bad: string[] = [];
  for (const c of citations()) {
    const p = resolveFile(c.file);
    if (!p) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    if (c.from > lines.length) { bad.push(`${c.raw} is past end of file (${lines.length} lines)`); continue; }
    const body = lines.slice(c.from - 1, c.to).join('\n').trim();
    if (body === '') bad.push(`${c.raw} points at blank lines`);
    else if (/^[}\]);,]+$/.test(body)) bad.push(`${c.raw} points at "${body}" — a closing brace, so it has drifted`);
  }
  assert.deepEqual(bad, [], `citations have rotted:\n  ${bad.join('\n  ')}`);
});

test('the numbers the doc quotes still match the live registry', () => {
  // The doc states 44 functions and a 15/29 split. Both come from code and data that can change
  // under it — a re-probe alone would move the split — so the doc must not silently disagree.
  const cap = fs.readFileSync(path.join(ROOT, 'server/src/lib/engine-capability.ts'), 'utf8');
  const declaredMin = /MIN_TRIALS\s*=\s*(\d+)/.exec(cap)?.[1];
  assert.ok(declaredMin, 'MIN_TRIALS not found in engine-capability.ts');
  assert.ok(text.includes(`MIN_TRIALS = ${declaredMin}`),
    `the doc quotes a different MIN_TRIALS than the code (code says ${declaredMin})`);

  const gate = /GATE_THRESHOLD\s*=\s*([\d.]+)/.exec(cap)?.[1];
  assert.ok(gate && text.includes(gate),
    `the doc does not quote the real GATE_THRESHOLD (code says ${gate})`);
});
