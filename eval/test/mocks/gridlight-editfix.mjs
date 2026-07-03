#!/usr/bin/env node
// Mock Gridlight that "solves" the edit-timeout task: replaces timeout: 30 with
// 60 in config.ts under --cwd. Lets us exercise the full runner path (fixture
// copy → spawn → assert → cleanup) deterministically, with no model server.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let cwd = process.cwd();
for (let i = 0; i < argv.length; i++) if (argv[i] === '--cwd') cwd = argv[++i];

const f = path.join(cwd, 'config.ts');
if (existsSync(f)) {
  writeFileSync(f, readFileSync(f, 'utf8').replace(/timeout:\s*30\b/, 'timeout: 60'));
}
process.stdout.write('edit applied\n');
