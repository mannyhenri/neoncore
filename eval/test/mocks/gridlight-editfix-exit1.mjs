#!/usr/bin/env node
// Mock Gridlight that DOES the edit-timeout task correctly but exits 1
// (self-reported failure). Proves runTask gates the verdict on exit code:
// a correct end-state must still score fail when the run reports failure.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let cwd = process.cwd();
for (let i = 0; i < argv.length; i++) if (argv[i] === '--cwd') cwd = argv[++i];

const f = path.join(cwd, 'config.ts');
if (existsSync(f)) writeFileSync(f, readFileSync(f, 'utf8').replace(/timeout:\s*30\b/, 'timeout: 60'));
process.stdout.write('edit applied but reporting failure\n');
process.exit(1);
