import { result, fileTextEquals } from '../_lib/assert.mjs';

// 3 .ts files under src/ (a.ts, b.ts, nested/c.ts); notes.md must not count.
// The model writes its count to answer.txt — asserting the file (not stdout)
// so an incidental "3" in the transcript can't fake a pass.
export async function assert({ cwd }) {
  return result([await fileTextEquals(cwd, 'answer.txt', '3', 'answer.txt is 3')]);
}
