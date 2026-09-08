/**
 * A FIELD THE SERVER SENDS AND THE CLIENT TYPE OMITS IS AN INVISIBLE FIELD.
 *
 * `workflows.context_label` was in the schema, and no UI could show it. Part of why: the wire
 * shapes are declared TWICE — `server/src/types.ts` for the server, `packages/client/src/types.ts`
 * for the web app and the iOS app. A field added on one side is not a compile error on the other;
 * it is simply absent, and `wf.contextLabel` in a component fails to typecheck with a message
 * that reads like the field does not exist at all.
 *
 * ── WHY route-contract.test.ts DOES NOT ALREADY COVER THIS ────────────────────────────
 * That test drives the real router and asserts the client never declares a field the server does
 * not send — the INVENTED direction, which fails loudly at runtime (a UI branching on `undefined`
 * reported every successful enqueue as "rejected"). This is the opposite direction: DROPPED. It
 * never throws, never renders wrong, just silently makes new server data unreachable. Nothing
 * caught it, which is why the column sat dead long enough to be reported as a bug.
 *
 * ── COMPARED STRUCTURALLY, NOT BY A LIST ─────────────────────────────────────────────
 * Both declarations are parsed from source. A field added to a server interface tomorrow fails
 * this test until the client learns it too, with no list here to update.
 *
 * Only TOP-LEVEL members count: `Workflow.stepSummary` is inline on the server and the named
 * `StepSummary` on the client, so its nested members would read as seven phantom omissions.
 * Depth tracking, not a skip list, because a skip list would also hide real drift.
 *
 * The client may legitimately carry MORE than the server sends (view-only state), so this is a
 * one-way check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
/**
 * The server declares its wire shapes in more than one file — `QueueItem` lives with the queue
 * kind registry it belongs to. Concatenated because interface names are unique across them, so a
 * shape can move file without this test noticing or caring.
 */
const SERVER = ['server/src/types.ts', 'server/src/lib/queue-kinds.ts']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const CLIENT = fs.readFileSync(path.join(ROOT, 'packages/client/src/types.ts'), 'utf8');

/**
 * Top-level member names of one interface. Returns null when the interface is absent, so a
 * renamed interface fails as "not found" rather than passing with an empty set — a parser that
 * gives up silently is the way this kind of test goes vacuous.
 */
function membersOf(src: string, name: string): string[] | null {
  const open = src.indexOf(`export interface ${name} {`);
  if (open === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', open);
  const start = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const body = src.slice(start, i);

  const members: string[] = [];
  let d = 0;
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\??\s*:/.exec(line);
    if (m && d === 0) members.push(m[1]);
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') d++;
      else if (ch === '}' || ch === ')' || ch === ']') d--;
    }
  }
  return members;
}

/** The shapes that cross the wire and are rendered by both the web app and the iOS app. */
const SHARED = ['Workflow', 'ConferSession', 'Agent', 'WorkflowStep', 'Project', 'QueueItem'];

test('EVERY field the server declares exists on the client type that renders it', () => {
  const problems: string[] = [];
  for (const name of SHARED) {
    const server = membersOf(SERVER, name);
    const client = membersOf(CLIENT, name);
    if (!server) { problems.push(`${name}: not found in server/src/types.ts`); continue; }
    if (!client) { problems.push(`${name}: not found in packages/client/src/types.ts`); continue; }
    if (server.length === 0) { problems.push(`${name}: parsed zero server members — the parser is broken`); continue; }
    for (const f of server) {
      if (!client.includes(f)) problems.push(`${name}.${f} — sent by the server, absent from the client type, so no UI can read it`);
    }
  }
  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}\n`);
});

test('the parser really finds members — a vacuous pass would hide every drift', () => {
  const wf = membersOf(SERVER, 'Workflow');
  assert.ok(wf && wf.length > 10, `parsed ${wf?.length} Workflow members`);
  assert.ok(wf!.includes('contextLabel'), 'the field this whole exercise added is not parsed');
  assert.ok(!wf!.includes('stepNames'), 'nested stepSummary members leaked in as top-level');
  assert.equal(membersOf(SERVER, 'NoSuchInterfaceAnywhere'), null);
});
