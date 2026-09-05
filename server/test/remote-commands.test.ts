/**
 * Addressing a cartridge from a phone — N2 of docs/plans/build-order.md.
 *
 * THE FAILURE THIS EXISTS TO PREVENT is not "no match". It is the WRONG match. `!prompt` types
 * into a live agent session, so a resolver that picks the first row when a fragment is
 * ambiguous drops your instruction into a cartridge doing something else entirely — and you
 * find out later, from the other machine's git history. Not understanding you is recoverable;
 * confidently guessing is not.
 *
 * SET-BASED over the ways a query can match, iterating the case table rather than asserting one
 * happy path. The precedence between them is the load-bearing part: a repo literally named
 * `dev` must be reachable by typing `dev` even while three other cartridges have those letters
 * somewhere in their names, so exact must beat fuzzy rather than merely usually winning.
 */
// FIRST import, before anything that reaches db.ts. `remote-commands.ts` imports the database
// to list cartridges, so without this the test opens the developer's PRODUCTION neoncore.db —
// which is what it did on its first run, announcing itself with "[db] Seeded 20 default
// workflow templates" against 412MB of real data. See the helper's own note on ESM hoisting.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCartridge, splitPromptArgs, type CartridgeRow,
} from '../src/lib/remote-commands.ts';
import { registerRemoteCommands } from '../src/lib/remote-commands.ts';
import { listCommands, getCommand, clearRegistries } from '../src/lib/commands-registry.ts';

const row = (id: string, machine: string, repo: string, status = 'working'): CartridgeRow => ({
  id, name: `${machine}/${repo}`, repo_name: repo, status, last_seen: '2026-09-04T17:00:00.000Z',
});

/** A fleet shaped like the real one: same repo on two machines, and overlapping name fragments. */
const FLEET: CartridgeRow[] = [
  row('a1', 'Mannys-Mac-Pro.local', 'film-engine'),
  row('a2', 'Mannys-Mac-Pro.local', 'film-engine-wt2'),
  row('a3', 'Mannys-Mac-Pro.local', 'neoncore'),
  row('a4', 'Mannys-Mac-Pro.local', 'gl-dev'),
  row('a5', 'Emmanuels-MacBook-Pro.local', 'dev'),
];

/** THE SET: every way a query resolves, and what it must resolve to. */
const CASES: { label: string; query: string; want: string }[] = [
  { label: 'an exact agent id', query: 'a3', want: 'found:a3' },
  { label: 'an exact repo name', query: 'film-engine', want: 'found:a1' },
  { label: 'an exact repo name, wrong case', query: 'FILM-ENGINE', want: 'found:a1' },
  { label: 'the full machine/repo name', query: 'Mannys-Mac-Pro.local/neoncore', want: 'found:a3' },

  // The precedence case. `dev` is a real repo AND a fragment of `gl-dev`. Exact must win, or
  // the cartridge literally called `dev` becomes unaddressable.
  { label: 'an exact name that is also a fragment of another', query: 'dev', want: 'found:a5' },

  { label: 'a unique fragment', query: 'neon', want: 'found:a3' },
  { label: 'a unique fragment matching one of two similar', query: 'wt2', want: 'found:a2' },

  // The dangerous one: two cartridges contain "film-engine".
  { label: 'a fragment matching two cartridges', query: 'film', want: 'ambiguous:2' },

  { label: 'no match at all', query: 'nope', want: 'none' },
  { label: 'an empty query', query: '', want: 'none' },
  { label: 'whitespace only', query: '   ', want: 'none' },
];

test('every kind of query resolves the way it must — and an ambiguous one is never guessed', () => {
  const failures: string[] = [];

  for (const c of CASES) {
    const r = resolveCartridge(FLEET, c.query);
    const got = r.kind === 'found' ? `found:${r.agent.id}`
      : r.kind === 'ambiguous' ? `ambiguous:${r.candidates.length}`
      : 'none';
    if (got !== c.want) failures.push(`${c.label} (${JSON.stringify(c.query)}): got ${got}, want ${c.want}`);
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

test('an ambiguous query names the candidates, so the next attempt can succeed', () => {
  // A bare "be more specific" is a dead end on a phone: you cannot see the fleet from there.
  const r = resolveCartridge(FLEET, 'film');
  assert.equal(r.kind, 'ambiguous');
  if (r.kind !== 'ambiguous') return;
  assert.deepEqual(r.candidates.map((c) => c.repo_name).sort(), ['film-engine', 'film-engine-wt2']);
});

test('resolution never throws on rows with missing fields', () => {
  // Rows come from SQLite, where repo_name can be empty for an agent that registered oddly.
  const ragged = [
    { id: 'x', name: '', repo_name: '', status: 'idle', last_seen: '' },
  ] as CartridgeRow[];
  for (const q of ['', 'anything', 'x']) {
    assert.doesNotThrow(() => resolveCartridge(ragged, q), `threw on ${JSON.stringify(q)}`);
  }
  assert.equal(resolveCartridge(ragged, 'x').kind, 'found', 'an exact id must still resolve');
});

/** THE SET: how the argument string splits. The prompt text must survive intact. */
const SPLITS: { input: string; target: string; text: string }[] = [
  { input: 'film-engine go fix the tests', target: 'film-engine', text: 'go fix the tests' },
  { input: 'film-engine', target: 'film-engine', text: '' },
  { input: '  film-engine   run   the   suite  ', target: 'film-engine', text: 'run   the   suite' },
  { input: '', target: '', text: '' },
  // A multi-line prompt pasted from a phone. The newline is the first whitespace.
  { input: 'neoncore fix this:\nline two', target: 'neoncore', text: 'fix this:\nline two' },
];

test('the cartridge is split off without mangling the prompt behind it', () => {
  const failures: string[] = [];
  for (const s of SPLITS) {
    const got = splitPromptArgs(s.input);
    if (got.target !== s.target || got.text !== s.text) {
      failures.push(`${JSON.stringify(s.input)} → ${JSON.stringify(got)}, want ${JSON.stringify({ target: s.target, text: s.text })}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
});

/**
 * THE SET: every command the remote surface registers, and the phase that added it.
 *
 * Asserted as an EXACT set rather than a subset, so a command appearing without a line here
 * fails — that is how N4's `autonomy` announced itself, which is the behaviour wanted. A
 * command nobody listed is one nobody documented, tested, or decided to expose.
 */
const REQUIRED_COMMANDS = [
  'cartridges',   // N2
  'prompt',       // N2
  'autonomy',     // N4 — read the posture, and raise it with a time-box
];

test('every remote command registers against the SHARED registry, not a driver', () => {
  clearRegistries();
  assert.deepEqual(listCommands(), [], 'registry was not empty at the start of the test');

  registerRemoteCommands();

  const missing = REQUIRED_COMMANDS.filter((c) => !getCommand(c));
  assert.deepEqual(missing, [], `not registered: ${missing.join(', ')}`);
  // Registered on the shared table means any driver dispatches them — the plan's "through the
  // abstraction, not around it".
  assert.deepEqual(listCommands(), REQUIRED_COMMANDS.slice().sort());
});
