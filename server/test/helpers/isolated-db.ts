/**
 * Point the process at a throwaway database. MUST be imported BEFORE anything that opens
 * the DB.
 *
 * A plain `process.env.NEONCORE_DB_PATH = ...` statement at the top of a test file does not
 * work: ESM imports are HOISTED, so `import db from '../src/db.js'` is evaluated before any
 * statement in the file body runs. The assignment looks first in the source and executes
 * last. That is how the first version of this isolation silently wrote to the production
 * database while appearing to be isolated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NEONCORE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncdb-')), 'test.db');
