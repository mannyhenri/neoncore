#!/usr/bin/env node
/**
 * Render a measured capability profile into the eligibility map and the scenario report.
 *
 * Usage: npx tsx server/scripts/report-eligibility.mjs <profile.json>
 */
import fs from 'node:fs';
import { FUNCTIONS, SCENARIOS } from '../src/lib/engine-capability.ts';
import { eligibilityMap, summarise } from '../src/lib/engine-router.ts';


// SCENARIOS now comes from the registry and is validated by engine-router.test.ts.
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const map = eligibilityMap(profile);
const sum = summarise(map);

console.log(`\n# Eligibility map — ${profile.modelId}   (measured ${profile.measuredAt})\n`);
console.log('## Measured capability vector\n');
for (const dim of Object.keys(profile.vector)) {
  const v = profile.vector[dim];
  const n = profile.trials?.[dim] ?? '?';
  const s = profile.perDimensionSeconds?.[dim];
  const shown = Number.isFinite(v) ? v.toFixed(2) : 'UNMEASURED';
  console.log(`  ${dim.padEnd(15)} ${String(shown).padEnd(11)} N=${n}  median ${s ? s.toFixed(1) + 's' : '—'}`);
}
console.log(`\n  interactive turn latency: ${profile.interactiveTurnSeconds}s\n`);

console.log(`## Overall: ${sum.local}/${sum.total} functions local, ${sum.frontier} frontier`);
console.log(`   states: ${JSON.stringify(sum.byState)}\n`);

console.log('## The eight scenarios you named\n');
for (const [name, fns] of Object.entries(SCENARIOS)) {
  if (fns.length === 0) {
    console.log(`### ${name}\n  -> LOCAL, free. No model call at all (T0, heuristic).\n`);
    continue;
  }
  const decisions = fns.map((id) => ({ id, d: map[id] }));
  const local = decisions.filter((x) => x.d.engine === 'local');
  const verdict = local.length === decisions.length ? 'LOCAL'
    : local.length === 0 ? 'FRONTIER' : 'SPLIT';
  console.log(`### ${name}  ->  ${verdict}`);
  for (const { id, d } of decisions) {
    console.log(`  ${d.engine === 'local' ? 'local   ' : 'frontier'}  ${id.padEnd(30)} ${d.reason}`);
  }
  console.log('');
}

console.log('## Full map by tier\n');
const byTier = {};
for (const fn of FUNCTIONS) (byTier[fn.tier] ||= []).push(fn.id);
for (const tier of Object.keys(byTier).sort()) {
  const ids = byTier[tier];
  const loc = ids.filter((id) => map[id].engine === 'local').length;
  console.log(`  ${tier.padEnd(9)} ${loc}/${ids.length} local   e.g. ${map[ids[0]].reason}`);
}
console.log('');
