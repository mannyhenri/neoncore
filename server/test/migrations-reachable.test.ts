import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Every schema migration in db.ts must be reachable ON ITS OWN.
 *
 * The schema is upgraded by a run of try/catch blocks: probe for a column, add
 * it in the catch when the probe throws. That shape has one silent failure
 * mode -- if a block's closing brace is missing, the blocks that follow are
 * swallowed INTO the previous block's catch. They then run only on a database
 * that is also missing the previous block's column, and on every other
 * database they never run at all.
 *
 * That is not hypothetical. `inbox_pid`, `inbox_token` (ADX-002) and
 * `commands.transport` (ADX-006) were nested inside the `model` migration's
 * catch exactly this way. Every test passed, `tsc` was clean, and the running
 * server 500'd on every agent registration with "no such column: inbox_pid" --
 * that database already had `model`, so the catch never fired.
 *
 * A fresh-database test cannot see it: on a fresh database the outer probe DOES
 * throw, so the swallowed blocks run and the schema comes out correct. The
 * defect only appears on an UPGRADE. So this simulates one per block: take a
 * fully-migrated database, drop exactly the columns that ONE block adds, re-run
 * db.ts, and require them back. A swallowed block fails because its guard
 * column is still present, so nothing re-adds it.
 *
 * Blocks are read from the source by brace matching rather than hand-listed,
 * so a migration added later is covered without touching this file. Only
 * INNERMOST blocks are tested -- a block whose catch contains another try IS
 * the swallowing bug, and its inner block is what reports it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TS = path.join(HERE, '..', 'src', 'db.ts');

type Block = { probe: string; adds: { table: string; col: string }[]; line: number };

/** Blank out comments and string bodies so brace matching cannot be fooled by them. */
function blankNonCode(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    const blankUntil = (end: string, from: number): number => {
      let j = from;
      while (j < src.length && !src.startsWith(end, j)) {
        if (src[j] === '\\') { out[j] = ' '; j++; }
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      for (let k = 0; k < end.length && j + k < src.length; k++) if (src[j + k] !== '\n') out[j + k] = ' ';
      return j + end.length;
    };
    if (c === '/' && d === '/') { out[i] = out[i + 1] = ' '; i = blankUntil('\n', i + 2); }
    else if (c === '/' && d === '*') { out[i] = out[i + 1] = ' '; i = blankUntil('*/', i + 2); }
    else if (c === '"' || c === "'" || c === '`') { i = blankUntil(c, i + 1); }
    else i++;
  }
  return out.join('');
}

function migrationBlocks(src: string): Block[] {
  const code = blankNonCode(src);
  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;
  const matchBrace = (open: number): number => {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) return i;
    }
    return -1;
  };

  const blocks: Block[] = [];
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    const tryOpen = m.index! + m[0].length - 1;
    const tryClose = matchBrace(tryOpen);
    if (tryClose < 0) continue;
    const after = code.slice(tryClose + 1);
    const catchM = after.match(/^\s*catch\s*(?:\([^)]*\))?\s*\{/);
    if (!catchM) continue;
    const catchOpen = tryClose + 1 + catchM[0].length - 1;
    const catchClose = matchBrace(catchOpen);
    if (catchClose < 0) continue;

    // Innermost only: a catch containing another try IS the swallow; its inner block reports it.
    if (/\btry\s*\{/.test(code.slice(catchOpen, catchClose))) continue;

    const probeM = src.slice(tryOpen, tryClose).match(/SELECT\s+(\w+)\s+FROM/i);
    if (!probeM) continue;
    const adds = [...src.slice(catchOpen, catchClose).matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)]
      .map((a) => ({ table: a[1], col: a[2] }));
    if (adds.length === 0) continue;

    blocks.push({ probe: probeM[1], adds, line: lineOf(tryOpen) });
  }
  return blocks;
}

function columnsOf(file: string, table: string): Set<string> {
  const db = new Database(file, { readonly: true });
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name));
  } finally {
    db.close();
  }
}

let bust = 0;
async function migrate(file: string): Promise<void> {
  process.env.NEONCORE_DB_PATH = file;
  await import(`../src/db.ts?reachability=${bust++}`);
}

test('every schema migration in db.ts is reachable on its own', async () => {
  const blocks = migrationBlocks(fs.readFileSync(DB_TS, 'utf8'));
  assert.ok(blocks.length > 20, `expected to parse the migration registry, found ${blocks.length} blocks`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-migrations-'));
  const reference = path.join(dir, 'reference.db');
  await migrate(reference);

  const unreachable: string[] = [];
  const notAppliedAtAll: string[] = [];
  const undroppable: string[] = [];
  let verified = 0;

  for (const block of blocks) {
    const label = `db.ts:${block.line} (probe ${block.probe})`;

    const absent = block.adds.filter((a) => !columnsOf(reference, a.table).has(a.col));
    if (absent.length > 0) {
      notAppliedAtAll.push(`${label} -- ${absent.map((a) => `${a.table}.${a.col}`).join(', ')}`);
      continue;
    }

    const upgrading = path.join(dir, `block-${block.line}.db`);
    fs.copyFileSync(reference, upgrading);

    const db = new Database(upgrading);
    let dropFailed = '';
    try {
      for (const a of block.adds) db.exec(`ALTER TABLE ${a.table} DROP COLUMN ${a.col}`);
    } catch (err) {
      dropFailed = (err as Error).message; // indexed / PK / generated columns cannot be dropped
    } finally {
      db.close();
    }
    if (dropFailed) { undroppable.push(`${label}: ${dropFailed}`); continue; }

    // A swallowed block does not merely leave the column missing -- db.ts's own import-time
    // code then runs against the hole and throws. Attribute that to the block under test.
    try {
      await migrate(upgrading);
    } catch (err) {
      unreachable.push(`${label} -- re-init threw: ${(err as Error).message}`);
      continue;
    }

    const stillMissing = block.adds.filter((a) => !columnsOf(upgrading, a.table).has(a.col));
    if (stillMissing.length > 0) {
      unreachable.push(`${label} -- did not restore ${stillMissing.map((a) => `${a.table}.${a.col}`).join(', ')}`);
    } else {
      verified++;
    }
  }

  assert.deepStrictEqual(
    notAppliedAtAll,
    [],
    `these migrations never ran, even on a fresh database:\n  ${notAppliedAtAll.join('\n  ')}`,
  );

  assert.deepStrictEqual(
    unreachable,
    [],
    'these migrations did NOT restore their own columns on a database missing only those columns.\n' +
      'That means the block is swallowed inside a previous migration\'s catch (a missing closing\n' +
      'brace) and will never run on an existing database:\n  ' +
      unreachable.join('\n  '),
  );

  console.log(
    `[migrations] ${blocks.length} migration blocks parsed; ${verified} verified by drop-and-restore; ` +
      `${undroppable.length} not droppable by sqlite${undroppable.length ? `: ${undroppable.join('; ')}` : ''}`,
  );
});
