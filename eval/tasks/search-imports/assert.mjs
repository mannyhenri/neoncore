import { result, stdoutContains } from '../_lib/assert.mjs';

// alpha.js (require) and gamma.js (import) use lodash; beta.js does not.
export async function assert({ stdout }) {
  return result([
    await stdoutContains(stdout, 'alpha.js', 'found alpha.js'),
    await stdoutContains(stdout, 'gamma.js', 'found gamma.js'),
  ]);
}
