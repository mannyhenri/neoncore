import { result, fileLineSetEquals } from '../_lib/assert.mjs';

// alpha.js (require) and gamma.js (import) use lodash; beta.js does not.
// fileLineSetEquals rejects extra entries, so a bare `ls` dump that also lists
// beta.js fails — the model must actually filter, not just enumerate.
export async function assert({ cwd }) {
  return result([
    await fileLineSetEquals(cwd, 'lodash-users.txt', ['alpha.js', 'gamma.js'], 'exactly alpha.js + gamma.js'),
  ]);
}
