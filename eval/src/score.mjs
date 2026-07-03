// Scoring: aggregate per-task pass@k results into a per-capability-class matrix
// plus an overall score. Includes a Wilson lower-bound so routing (Task 1) can
// gate on the conservative estimate near a threshold, not a noisy point score.

/**
 * Wilson score interval lower bound for a binomial proportion.
 * Routing should gate on this, not the raw pass rate: with k=3 and 2/3 passing,
 * the point estimate (0.67) overstates confidence. The lower bound is honest.
 * @param {number} passes
 * @param {number} n
 * @param {number} z  1.96 = 95%
 * @returns {number}
 */
export function wilsonLower(passes, n, z = 1.96) {
  if (n === 0) return 0;
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/**
 * @param {Array<{id:string,class:string,passes:number,k:number,passRate:number}>} taskResults
 * @returns {{byClass:Record<string,{pass:number,total:number,score:number,lowerBound:number}>, aggregate:{pass:number,total:number,score:number,lowerBound:number}}}
 */
export function score(taskResults) {
  const byClass = {};
  let totalPasses = 0;
  let totalRuns = 0;

  for (const t of taskResults) {
    const c = (byClass[t.class] ??= { pass: 0, total: 0, score: 0, lowerBound: 0 });
    c.pass += t.passes;
    c.total += t.k;
    totalPasses += t.passes;
    totalRuns += t.k;
  }
  for (const c of Object.values(byClass)) {
    c.score = c.total ? c.pass / c.total : 0;
    c.lowerBound = wilsonLower(c.pass, c.total);
  }

  return {
    byClass,
    aggregate: {
      pass: totalPasses,
      total: totalRuns,
      score: totalRuns ? totalPasses / totalRuns : 0,
      lowerBound: wilsonLower(totalPasses, totalRuns),
    },
  };
}

/**
 * Assemble the full result record for a model run (written to disk; in Step 1
 * this shape also POSTs to NeonCore's model_parity_scores table).
 */
export function buildReport(modelId, backend, taskResults, ranAt) {
  const s = score(taskResults);
  return {
    modelId,
    backend,
    ranAt,
    k: taskResults[0]?.k ?? 0,
    tasks: taskResults.map((t) => ({
      id: t.id,
      class: t.class,
      passes: t.passes,
      k: t.k,
      passRate: t.passRate,
    })),
    byClass: s.byClass,
    aggregate: s.aggregate,
  };
}
