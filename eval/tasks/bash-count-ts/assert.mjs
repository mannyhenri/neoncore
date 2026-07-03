import { result, stdoutContains } from '../_lib/assert.mjs';

// 3 .ts files under src/ (a.ts, b.ts, nested/c.ts); notes.md must not count.
export async function assert({ stdout }) {
  return result([await stdoutContains(stdout, '3', 'reports count 3')]);
}
