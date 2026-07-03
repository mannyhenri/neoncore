import { result, stdoutContains } from '../_lib/assert.mjs';

export async function assert({ stdout }) {
  return result([await stdoutContains(stdout, '4040', 'reports port 4040')]);
}
