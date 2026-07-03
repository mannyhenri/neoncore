import { result, fileMatches, fileNotMatches } from '../_lib/assert.mjs';

// End-state: timeout is 60, and the old value 30 is gone. Method is irrelevant.
export async function assert({ cwd }) {
  return result([
    await fileMatches(cwd, 'config.ts', /timeout:\s*60\b/, 'timeout is 60'),
    await fileNotMatches(cwd, 'config.ts', /timeout:\s*30\b/, 'old 30 removed'),
  ]);
}
