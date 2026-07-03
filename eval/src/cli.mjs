#!/usr/bin/env node
// parity-eval — behavioral parity eval for a Gridlight-served local model.
//
//   parity-eval run --model qwen2.5-coder:7b [options]
//
// Options:
//   --model <id>         (required) GRIDLIGHT_MODEL to test
//   --gateway <url>      OpenAI-compatible gateway (default http://localhost:11434, Ollama)
//   --backend <mode>     GRIDLIGHT_BACKEND_MODE (default openai-compatible)
//   --k <n>              runs per task for pass@k (default 3)
//   --tasks-dir <dir>    task suite dir (default ./tasks)
//   --gridlight-bin <b>  gridlight binary (default env GRIDLIGHT_BIN or "gridlight")
//   --only <a,b,c>       run only these task ids
//   --neoncore           report to NeonCore during runs (default off = hermetic)
//   --no-probe           skip the gateway reachability probe

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks } from './loadTasks.mjs';
import { runTaskK } from './runner.mjs';
import { buildReport } from './score.mjs';
import { probeGateway } from './probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { _: [], k: 3, gateway: 'http://localhost:11434', backend: 'openai-compatible', probe: true, neoncore: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--gateway') out.gateway = argv[++i];
    else if (a === '--backend') out.backend = argv[++i];
    else if (a === '--k') out.k = Number(argv[++i]);
    else if (a === '--tasks-dir') out.tasksDir = argv[++i];
    else if (a === '--gridlight-bin') out.gridlightBin = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--neoncore') out.neoncore = true;
    else if (a === '--no-probe') out.probe = false;
    else out._.push(a);
  }
  return out;
}

function pct(n) { return `${Math.round(n * 100)}%`; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'run') {
    process.stderr.write('usage: parity-eval run --model <id> [--gateway url] [--k n] [--only a,b]\n');
    process.exit(2);
  }
  if (!args.model) {
    process.stderr.write('error: --model is required\n');
    process.exit(2);
  }

  const gridlightBin = args.gridlightBin || process.env.GRIDLIGHT_BIN || 'gridlight';
  const tasksDir = args.tasksDir || path.join(PKG_ROOT, 'tasks');

  // Probe first: distinguish "server down" from "model got it wrong".
  if (args.probe) {
    const p = await probeGateway(args.gateway);
    if (!p.ok) {
      process.stderr.write(`[probe] ${p.detail}\n`);
      process.stderr.write('[probe] refusing to run — a down gateway would score every task as a false failure. Start the model server or pass --no-probe.\n');
      process.exit(1);
    }
    process.stdout.write(`[probe] ${p.detail}\n`);
  }

  const tasks = await loadTasks(tasksDir, args.only);
  if (!tasks.length) {
    process.stderr.write(`error: no tasks found in ${tasksDir}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nparity-eval · model=${args.model} · k=${args.k} · ${tasks.length} tasks\n`);
  process.stdout.write('─'.repeat(60) + '\n');

  const results = [];
  for (const task of tasks) {
    const r = await runTaskK(task, {
      gridlightBin,
      model: args.model,
      gatewayUrl: args.gateway,
      backendMode: args.backend,
      neoncore: args.neoncore,
    }, args.k);
    results.push(r);
    const mark = r.passRate === 1 ? '✓' : r.passRate === 0 ? '✗' : '~';
    process.stdout.write(`  ${mark} ${task.id.padEnd(28)} ${task.class.padEnd(10)} ${r.passes}/${r.k} (${pct(r.passRate)})\n`);
  }

  const ranAt = new Date().toISOString();
  const report = buildReport(args.model, args.backend, results, ranAt);

  process.stdout.write('─'.repeat(60) + '\n');
  process.stdout.write('By class (score · 95% lower bound):\n');
  for (const [cls, c] of Object.entries(report.byClass)) {
    process.stdout.write(`  ${cls.padEnd(12)} ${pct(c.score).padStart(4)}  (lb ${pct(c.lowerBound)})\n`);
  }
  process.stdout.write(`\nAGGREGATE: ${pct(report.aggregate.score)} · lower bound ${pct(report.aggregate.lowerBound)}\n`);

  // Persist. In Step 1 this same report also POSTs to NeonCore model_parity_scores.
  const outDir = path.join(PKG_ROOT, 'results', args.model.replace(/[^a-zA-Z0-9._-]/g, '_'));
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${ranAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2));
  process.stdout.write(`\nreport → ${path.relative(process.cwd(), outFile)}\n`);
}

main().catch((err) => {
  process.stderr.write(`parity-eval: ${err?.stack || err}\n`);
  process.exit(1);
});
