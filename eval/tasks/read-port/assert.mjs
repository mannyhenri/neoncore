import { result, fileTextEquals } from '../_lib/assert.mjs';

// The model writes the port to answer.txt. Asserting the file (not stdout)
// defeats two false positives: the port literal echoes to stdout the moment
// server.ts is read, and 4040 is also NeonCore's own default port.
export async function assert({ cwd }) {
  return result([await fileTextEquals(cwd, 'answer.txt', '4040', 'answer.txt is 4040')]);
}
