import { result, fileMatches, fileNotMatches, commandSucceeds } from '../_lib/assert.mjs';

// The decisive class. Multi-file rename must be complete AND consistent:
// getUser gone everywhere, fetchUser present, and the module still wires up
// (require('./handler')(1) throws if the import/def rename fell out of sync).
export async function assert({ cwd }) {
  const files = ['user.js', 'handler.js', 'report.js'];
  const checks = [];
  for (const f of files) {
    checks.push(await fileNotMatches(cwd, f, /\bgetUser\b/, `${f}: no getUser`));
  }
  checks.push(await fileMatches(cwd, 'user.js', /\bfetchUser\b/, 'user.js: defines fetchUser'));
  checks.push(
    commandSucceeds(cwd, 'node', ['-e', "require('./handler')(1);"], 'handler still runs after rename'),
  );
  return result(checks);
}
