import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Mobile's local types may be NARROWER than the server contract, never STRICTER.
 *
 * mobile/src/api.ts already imports the queue types from @neoncore/client rather than
 * copying them, with a comment explaining why: a hand-copied type drifts and nobody
 * notices. But the workflow types are still local copies, and one of them had drifted in
 * the direction that actually breaks the app.
 *
 * A field the server marks OPTIONAL and mobile marks REQUIRED is the dangerous direction.
 * It does not fail the typecheck — it DISABLES it: `s.projects.length` compiles clean
 * because mobile promised `projects` is always there, and then throws at runtime the
 * moment a server omits it, taking the whole screen down with it. The dashboard reads the
 * same field through the shared type and is forced to guard it
 * (WorkflowPanel.tsx: `wf.stepSummary.projects && ...length > 0`).
 *
 * Omitting a field entirely is fine and stays allowed: mobile renders less than the web
 * does, and a type that describes only what this app reads is honest.
 */

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MOBILE = fs.readFileSync(path.join(ROOT, 'mobile/src/types.ts'), 'utf8');
const SHARED = fs.readFileSync(path.join(ROOT, 'packages/client/src/types.ts'), 'utf8');

/** Interfaces that describe the same server payload under different local names. */
const ALIASES: Record<string, string> = { WorkflowStepSummary: 'StepSummary' };

/** interface name -> (field name -> isOptional) */
function parseInterfaces(src: string): Map<string, Map<string, boolean>> {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const out = new Map<string, Map<string, boolean>>();
  const iface = /export interface (\w+)[^{]*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = iface.exec(clean))) {
    const fields = new Map<string, boolean>();
    const field = /^\s{2}(\w+)(\??):\s*[^;\n]+;/gm;
    let f: RegExpExecArray | null;
    while ((f = field.exec(m[2]))) fields.set(f[1], f[2] === '?');
    out.set(m[1], fields);
  }
  return out;
}

describe('mobile types vs the shared server contract', () => {
  const mobile = parseInterfaces(MOBILE);
  const shared = parseInterfaces(SHARED);

  it('parses both type files (a silent parse failure would assert nothing)', () => {
    expect(mobile.size).toBeGreaterThan(3);
    expect(shared.size).toBeGreaterThan(3);
    expect([...shared.keys()]).toContain('StepSummary');
  });

  it('never declares a field required that the server declares optional', () => {
    const violations: string[] = [];

    for (const [name, fields] of mobile) {
      const counterpart = shared.get(ALIASES[name] ?? name);
      if (!counterpart) continue;
      for (const [field, mobileOptional] of fields) {
        const sharedOptional = counterpart.get(field);
        if (sharedOptional === undefined) continue; // mobile-only field, not a contract claim
        if (sharedOptional && !mobileOptional) {
          violations.push(
            `${name}.${field}: shared says optional, mobile says required — ` +
            'every read of it compiles unguarded and throws when the server omits it',
          );
        }
      }
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
