/**
 * ADX-006 — WHICH TRANSPORT CARRIED IT, not merely whether something did.
 *
 * `delivered` is a boolean, and it cannot tell a relay websocket from an
 * addressed inbox socket from a keystroke typed into whatever window happened to
 * be frontmost. Those three have very different reliability, and one of them —
 * the inbox — resolves ASYNCHRONOUSLY, so `delivered = false` on the synchronous
 * return now means two completely different things: "nothing was listening" and
 * "handed to a socket, answer pending". A dashboard cannot distinguish them and
 * neither can an operator reading NO COMMAND CHANNEL in the log.
 *
 * WHY THE TEST IS SET-BASED OVER THE SOURCE'S OWN CONCLUSION POINTS. Naming
 * today's five branches would pass forever while a sixth went unlabelled, and an
 * unlabelled branch is worse than no labelling at all: every reader of the field
 * would believe it is complete. So the count of `command.transport =`
 * assignments is compared against the count of `command.delivered =`
 * assignments, both read from the file. A branch that concludes delivery without
 * naming its transport fails this.
 *
 * WHY THE ROW MATTERS SEPARATELY FROM THE RETURN VALUE. The Command object is
 * returned once, to one caller. The ROW is what anything later reads — the
 * dashboard, a retry, an operator asking why a dispatch vanished. A transport
 * that exists only on the returned object answers the question for the one
 * caller who already knew.
 */
import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import db from '../src/db.js';
import { installStubIO } from './helpers/stub-io.js';
import { upgradeSocketsToAgentRoom } from '../src/ws.ts';
import { sendCommandToAgent } from '../src/lib/send-command.ts';
import { inboxPathFor } from '../src/lib/inbox-client.ts';

const io = installStubIO();
const SRC_PATH = path.join(import.meta.dirname, '..', 'src', 'lib', 'send-command.ts');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/*
 * Bound at the path PRODUCTION derives, using this process's own pid — the same
 * technique ADX-005's test uses, and for the same reason: the client refuses to
 * write to a pid that is not a live process owned by us, so a made-up pid never
 * reaches a socket, and pointing the listener at a temp path of the test's
 * choosing would leave the path derivation itself unexercised.
 */
const SOCK = inboxPathFor(process.pid);
const servers: net.Server[] = [];

test.before(async () => {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  await new Promise<void>((res) => {
    const s = net.createServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
    servers.push(s);
    s.listen(SOCK, () => res());
  });
});
test.after(() => {
  for (const s of servers) { try { s.close(); } catch { /* */ } }
  try { fs.unlinkSync(SOCK); } catch { /* */ }
});

let n = 0;
function cartridge(o: { inboxPid?: number } = {}): string {
  const id = `ag-adx6-${++n}`;
  db.prepare(
    `INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,
                         session_id,pending_question,inbox_pid,inbox_token)
     VALUES (?,?,?,?,?,'claude','working',?,?,'',?,?)`,
  ).run(id, `m/${id}`, 'm', `/r/${id}`, `r${id}`, new Date().toISOString(), `s-${id}`,
        o.inboxPid ?? 0, o.inboxPid ? 'tok' : '');
  return id;
}
const rowOf = (cmdId: string) =>
  db.prepare('SELECT * FROM commands WHERE id = ?').get(cmdId) as Record<string, unknown>;

/* ── The registry: every way a dispatch leaves, and how to reach it ──────── */

interface Branch {
  transport: string;
  why: string;
  drive: (() => ReturnType<typeof sendCommandToAgent>) | null;
  delegatedTo?: string;
}

const BRANCHES: Branch[] = [
  {
    transport: 'primary-socket',
    why: 'the most recently registered relay window',
    drive: () => {
      /*
       * The primary socket lives in a module-private map that stub-io's
       * connect() does not populate, so registering a room alone lands in the
       * agent-room branch instead — my first version did exactly that and
       * measured the wrong branch. upgradeSocketsToAgentRoom is the exported
       * path that actually sets it.
       */
      const id = cartridge();
      io.addPathSocket(`sock-${id}`, `ext:m:/r/${id}:claude`);
      upgradeSocketsToAgentRoom('m', `/r/${id}`, id, 'claude');
      return sendCommandToAgent(id, 'x');
    },
  },
  {
    transport: 'agent-room',
    why: 'room-wide emit when no primary socket is registered',
    drive: () => { const id = cartridge(); io.connect(id); return sendCommandToAgent(id, 'x'); },
  },
  {
    transport: 'inbox-socket',
    why: 'the addressed per-session socket, where the alternative is the dead end',
    drive: () => sendCommandToAgent(cartridge({ inboxPid: process.pid }), 'x'),
  },
  {
    transport: 'no-channel',
    why: 'nothing is listening — the narrower alarm this task exists to sharpen',
    drive: () => sendCommandToAgent(cartridge(), 'x'),
  },
];

/* ── 1. No branch may conclude without naming itself ─────────────────────── */

test('a branch CANNOT conclude delivery without naming its transport', () => {
  /*
   * Originally this counted `command.delivered =` against `command.transport =`
   * and required the two to match. The implementation then routed every branch
   * through ONE `conclude(transport, delivered)` helper, which makes an
   * unlabelled branch structurally impossible rather than merely counted — a
   * strictly stronger guarantee, so the assertion moved to it. What is checked
   * here is that the funnel is real: exactly one place assigns either field, and
   * every branch reaches delivery through it.
   */
  const assignsDelivered = [...SRC.matchAll(/command\.delivered\s*=/g)].length;
  const assignsTransport = [...SRC.matchAll(/command\.transport\s*=/g)].length;
  assert.equal(assignsDelivered, 1,
    `${assignsDelivered} places assign command.delivered — the single funnel is gone, so a `
    + 'branch can now conclude without naming a transport');
  assert.equal(assignsTransport, 1,
    `${assignsTransport} places assign command.transport — see above`);

  const funnel = SRC.indexOf('const conclude =');
  assert.ok(funnel !== -1, 'the conclude() funnel is gone');
  assert.ok(SRC.indexOf('command.delivered =') > funnel && SRC.indexOf('command.transport =') > funnel,
    'delivered/transport are assigned outside the funnel');

  /* And the funnel persists to the row, not only to the object. */
  const body = SRC.slice(funnel, SRC.indexOf('};', funnel));
  assert.match(body, /UPDATE commands SET transport/,
    'the funnel sets the field but never writes the row — everything later reads the row');
});

/**
 * A transport may legitimately be concluded from MORE THAN ONE call site, and
 * each duplication has to justify itself here.
 *
 * `inbox-socket` has two: the ADX-005 last-resort branch, reached when nothing
 * else is listening, and the ADX-007 `deliverNow` preference, reached ahead of
 * the relay when an operator asks for "now". Same transport, different reasons
 * to choose it — so a raw count of call sites against registry entries is the
 * wrong invariant, while "every transport in the source is covered" stays right.
 */
const EXTRA_CALL_SITES: Record<string, string> = {
  'inbox-socket': 'ADX-005 reaches it as a last resort; ADX-007 prefers it for deliverNow',
};

test('the registry covers every transport concluded in the source', () => {
  const sites = [...SRC.matchAll(/^\s*conclude\('([a-z-]+)'/gm)].map((m) => m[1]);
  assert.ok(sites.length >= 5, `only ${sites.length} conclude() call sites found — the scan is broken`);

  const inSource = [...new Set(sites)].sort();
  const covered = BRANCHES.map((b) => b.transport).sort();
  assert.deepEqual(inSource, covered,
    'the transports concluded in send-command.ts and the ones this registry drives have '
    + 'diverged — a new branch is unexercised until it is added to BRANCHES.');

  /* And every duplicate call site is accounted for, rather than silently tolerated. */
  const dupes = inSource.filter((t) => sites.filter((x) => x === t).length > 1);
  const unexplained = dupes.filter((t) => !EXTRA_CALL_SITES[t]);
  assert.deepEqual(unexplained, [],
    `these transports are concluded from several places with no stated reason: ${unexplained.join(', ')}`);
});

test('no two branches report the same transport', () => {
  const names = BRANCHES.map((b) => b.transport);
  assert.equal(new Set(names).size, names.length, `duplicates: ${names.join(', ')}`);
});

test('a branch that cannot be driven names what covers it instead', () => {
  /*
   * ADX-008 deleted the terminal-fallback branch, which was the only undriveable
   * one — so this set is empty today and the test passes vacuously. It is kept
   * rather than deleted because the RULE still matters: the next branch that
   * cannot be driven must say what covers it instead, or "not driven" and
   * "forgotten" become indistinguishable again.
   */
  for (const b of BRANCHES.filter((x) => !x.drive)) {
    assert.ok(b.delegatedTo, `${b.transport} cannot be driven and names no covering test`);
    assert.ok(fs.existsSync(path.join(import.meta.dirname, b.delegatedTo)),
      `${b.transport} delegates to ${b.delegatedTo}, which does not exist`);
  }
});

/* ── 2. Each branch reports itself, on the object AND on the row ─────────── */

for (const b of BRANCHES.filter((x) => x.drive)) {
  test(`${b.transport} is reported — ${b.why}`, () => {
    const c = b.drive!();
    assert.ok(c, 'no command was produced');
    assert.equal((c as Record<string, unknown>).transport, b.transport,
      `expected transport ${b.transport}, got ${JSON.stringify((c as Record<string, unknown>).transport)}`);

    /*
     * The row, separately. The returned object answers the question for the one
     * caller who already knew; everything later — the dashboard, a retry, an
     * operator asking why a dispatch vanished — reads the row.
     */
    assert.equal(rowOf(c!.id).transport, b.transport,
      `the command row does not carry the transport for ${b.transport}`);
  });
}

/* ── 3. The alarm narrows ────────────────────────────────────────────────── */

test('NO COMMAND CHANNEL is raised for the no-channel case ONLY', () => {
  /*
   * The whole point of the epic: a cartridge whose relay dropped used to be
   * written off with this alarm. Now it is reachable, so the alarm must mean the
   * narrower thing — nothing at all is listening — or it keeps crying wolf and
   * gets ignored for the case that is genuinely lost.
   */
  const at = SRC.indexOf('NO COMMAND CHANNEL');
  assert.ok(at !== -1, 'the alarm is gone entirely — the genuinely-lost case now says nothing');
  const before = SRC.slice(0, at);
  const branchStart = before.lastIndexOf('} else {');
  assert.ok(branchStart !== -1, 'could not locate the branch the alarm sits in');
  assert.ok(!SRC.slice(branchStart, at).includes('postToInbox'),
    'the alarm fires inside the inbox branch — a reachable cartridge would be reported lost');
});

test('an inbox hand-over does NOT claim delivery on the synchronous return', () => {
  /*
   * ADX-001 measured a session that accepts the connection, takes the write and
   * delivers nothing, with no error either side. ADX-005 therefore leaves
   * `delivered` false and lets the row carry the outcome once it is known.
   * Naming the transport must not quietly undo that.
   */
  const c = BRANCHES.find((b) => b.transport === 'inbox-socket')!.drive!();
  assert.equal(c?.delivered, false,
    'the inbox branch now claims synchronous delivery — the socket cannot prove receipt');
  assert.equal((c as Record<string, unknown>).transport, 'inbox-socket',
    'a transport must still be reported even when delivery is not yet known');
});
