/**
 * EVERY curl WE TELL AN AGENT TO RUN MUST CARRY THE FLEET TOKEN.
 *
 * Step fallbacks, confer milestone signals and the MCP tool's own error path all printed a bare
 * `curl -s -X POST …/api/…`. Under NEONCORE_AUTH_MODE=strict every one of those is a 401 — and
 * for a confer the curl is the PRIMARY completion signal, so strict auth would wedge every
 * confer. SET-BASED: every source file, every curl that posts to the API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_CURL_HEADER } from '../src/lib/server-url.ts';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});

test('the header is the one the hooks send (agent/hooks/_fleet.py)', () => {
  assert.equal(AUTH_CURL_HEADER, '-H "Authorization: Bearer $(cat ~/.neoncore/token)"');
});

test('EVERY agent-facing curl to the API authenticates', () => {
  const bare: string[] = [];
  let seen = 0;
  for (const file of files(src)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bcurl\b[^\n]*-X POST/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
      seen++;
      // The header may sit on the next line of a concatenated string.
      const window = lines.slice(i, i + 3).join('\n');
      if (!/AUTH_CURL_HEADER|Authorization: Bearer/.test(window)) bare.push(`${relative(src, file)}:${i + 1}`);
    });
  }
  assert.ok(seen >= 4, `expected the known curl sites, found ${seen}`);
  assert.deepEqual(bare, [], `curl without the fleet token:\n  ${bare.join('\n  ')}`);
});
