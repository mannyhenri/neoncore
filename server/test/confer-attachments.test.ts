/**
 * ATTACHMENTS MUST REACH EVERY CONFER, BY EVERY ROUTE THAT STARTS ONE.
 *
 * Reported as "the attached pictures don't get to interlag". They did reach the DISK — the
 * launch path materializes the bytes into every participant's checkout, and 121 files sit in
 * backend-interlag/.neoncore/attachments. What never arrived was the PROMPT BLOCK that tells
 * the agent those files exist and where. An agent reads files, not intentions: a block that is
 * never dispatched is an attachment that was never sent.
 *
 * It is NOT specific to that repo. Confer 3a671acf (baseback + backend-interlag, 2026-09-22
 * 23:41) stored `attachments = {}` while its own batch metadata.json, written 0.6s earlier,
 * listed two PNGs. NEITHER participant got a block.
 *
 * Two of the three paths that can start a confer dropped them:
 *
 *   routes/confer.ts   direct start      passes attachmentBlocks        ✓
 *   routes/confer.ts   QUEUED payload    omitted — and the comment
 *                                        above it says "What we enqueue
 *                                        must equal what we would have
 *                                        dispatched"                    ✗
 *   workflow-executor  confer STEP       omitted — a confer inside a
 *                                        workflow never sees the run's
 *                                        attachments at all             ✗
 *
 * SET-BASED OVER THE SOURCE, not over one example. An example-based test passes as soon as the
 * first of the two is fixed, which is the exact half-done fix this is written to prevent — and
 * a fourth path added later is caught without anyone remembering this file exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** Strip comments so a mention of the field in prose can never satisfy the scan. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The slice of source from `open` to its balanced close — the whole call/object. */
function balanced(src: string, startIdx: number, open: string, close: string): string {
  const from = src.indexOf(open, startIdx);
  if (from < 0) return '';
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return '';
}

/**
 * Every place a confer is born, with the source slice that must carry the blocks.
 * Derived by scanning, so a new call site joins the set on its own.
 */
function conferCreationSites(): { where: string; body: string }[] {
  const out: { where: string; body: string }[] = [];

  for (const rel of ['routes/confer.ts', 'lib/workflow-executor-v2.ts', 'lib/queue-kinds.ts']) {
    const src = stripComments(read(rel));

    // (a) direct startConfer({ ... }) calls built from an object literal.
    let idx = 0;
    for (;;) {
      const at = src.indexOf('startConfer(', idx);
      if (at < 0) break;
      idx = at + 1;
      if (/(function|import)\s*$/.test(src.slice(Math.max(0, at - 30), at))) continue;
      const call = balanced(src, at, '(', ')');
      // A pass-through call (queue dispatch forwards the stored payload) carries no literal;
      // its obligation lives on the ENQUEUER, checked as (b).
      if (!call.includes('{')) continue;
      out.push({ where: `${rel} → startConfer({...})`, body: call });
    }

    // (b) the queue payload for kind 'confer' — what is stored IS what is later dispatched.
    let q = 0;
    for (;;) {
      const at = src.indexOf("kind: 'confer'", q);
      if (at < 0) break;
      q = at + 1;
      const pay = src.indexOf('payload:', at);
      if (pay < 0 || pay - at > 1200) continue;
      const obj = balanced(src, pay, '{', '}');
      if (obj) out.push({ where: `${rel} → queued confer payload`, body: obj });
    }
  }
  return out;
}

test('every path that starts a confer carries the attachment blocks', () => {
  const sites = conferCreationSites();

  assert.ok(sites.length >= 3,
    `expected at least 3 confer-creating paths, found ${sites.length} — the scan is no longer `
    + `finding them and this test would pass vacuously:\n${sites.map((s) => s.where).join('\n')}`);

  const dropping = sites
    .filter((s) => !/attachmentBlocks/.test(s.body))
    .map((s) => s.where);

  assert.deepEqual(dropping, [],
    'these confer paths never pass attachmentBlocks, so files are copied into the repo and the '
    + 'agent is never told they exist');
});
