import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A macOS launch hands the terminal `bash <script>`, never the bare script path.
 *
 * Each launch writes a fresh, chmod +x temp script. Executed directly, it is a brand-new
 * executable, so macOS holds the exec for a syspolicyd/XProtect assessment first. When those
 * daemons are busy (cargo builds minting test binaries), that took 13s for a two-line script,
 * over 60s for the real launch script, and in Terminal it ended in `killed` — gl-demo, gw-demo
 * and gridlight-manager-gw-demo all failed to start on 2026-10-13. Run as `bash <script>`, the
 * only executable is bash itself, already assessed: the same script finished in 2.5s.
 *
 * The set is every place a macOS terminal is told to run a launch script: the runner's
 * Terminal.app branch, and open-directory's iTerm2 and Terminal.app branches.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  path.resolve(here, '../../agent/runner/index.js'),
  path.resolve(here, '../src/lib/open-directory.ts'),
];

const handoffs = SOURCES.flatMap((file) =>
  fs.readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ file: path.basename(file), line: i + 1, text: line }))
    .filter(({ text }) => /'(do script|write text) /.test(text)),
);

test('the complete set of macOS terminal handoffs is found (3)', () => {
  assert.equal(handoffs.length, 3, handoffs.map((h) => `${h.file}:${h.line}`).join(', '));
});

test('every macOS terminal handoff runs the script through bash', () => {
  const direct = handoffs.filter(({ text }) => !/'(do script|write text) \$\{JSON\.stringify\(`bash /.test(text));
  assert.deepEqual(direct.map((h) => `${h.file}:${h.line}: ${h.text.trim()}`), []);
});
