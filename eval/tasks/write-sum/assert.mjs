import { result, commandSucceeds } from '../_lib/assert.mjs';

// Behavioral: require the module and call sum(2,3); pass iff it returns 5.
// This ignores HOW the function was written — only that it works.
export async function assert({ cwd }) {
  return result([
    commandSucceeds(
      cwd,
      'node',
      ['-e', "const m=require('./math.js'); if (m.sum(2,3)!==5) process.exit(1);"],
      'sum(2,3) === 5',
    ),
  ]);
}
