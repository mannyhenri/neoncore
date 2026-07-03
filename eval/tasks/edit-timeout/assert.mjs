import { result, fileMatches, fileNotMatches } from '../_lib/assert.mjs';

// End-state: timeout is 60, old value 30 gone — AND "change nothing else" is
// enforced by checking the sibling fields survive, so an over-broad or
// clobbering edit doesn't score as a clean one.
export async function assert({ cwd }) {
  return result([
    await fileMatches(cwd, 'config.ts', /\btimeout:\s*60\b/, 'timeout is 60'),
    await fileNotMatches(cwd, 'config.ts', /\btimeout:\s*30\b/, 'old 30 removed'),
    await fileMatches(cwd, 'config.ts', /\bretries:\s*3\b/, 'retries untouched'),
    await fileMatches(cwd, 'config.ts', /\bverbose:\s*false\b/, 'verbose untouched'),
  ]);
}
