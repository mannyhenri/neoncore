#!/usr/bin/env node
/**
 * node packages/qa-runner/cli.mjs <run|act|snapshot> …   (docs/plans/qa-section.md § Runner CLI)
 *
 *   run      --spec <file.json> --out <dir> [--state <file>]
 *   act      --spec <file.json> --out <dir> [--state <file>]
 *   snapshot --url <url> --allow <host,…> --out <dir> [--state <file>]
 *
 * Prints ONE JSON object to stdout. Exit 0 when it ran (passed or failed), 2 on bad input or a
 * guardrail refusal (status "blocked").
 * --state keeps the browser's cookies between calls (a cartridge logs in once, then acts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { actSpec, runSpec, snapshot } from './src/index.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function out(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : 0;
}

function readSpec() {
  const file = arg('spec');
  if (!file) return { problem: '--spec <file.json> is required' };
  try { return { spec: JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) { return { problem: `cannot read ${file}: ${err.message}` }; }
}

const cmd = process.argv[2];
const outDir = resolve(arg('out') || '.qa-runner-out');
const state = arg('state') ? resolve(arg('state')) : undefined;

try {
  if (cmd === 'run' || cmd === 'act') {
    const { spec, problem } = readSpec();
    if (problem) out({ status: 'blocked', error: problem });
    else out(cmd === 'run' ? await runSpec(spec, outDir, { state }) : await actSpec(spec, outDir, { state }));
  } else if (cmd === 'snapshot') {
    const url = arg('url');
    const allowHosts = String(arg('allow') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!url) out({ status: 'blocked', error: '--url is required' });
    else out(await snapshot({ url, allowHosts, outDir, state }));
  } else {
    out({ status: 'blocked', error: `unknown command "${cmd ?? ''}" (run, act or snapshot)` });
  }
} catch (err) {
  out({ status: 'blocked', error: `runner error: ${err.message}` });
}
