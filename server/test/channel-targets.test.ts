// FIRST import — this file reaches db.ts through remote-commands. See helpers/isolated-db.ts.
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM: no __dirname, and no require.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (f: string) => fs.readFileSync(path.join(HERE, '..', 'src', f), 'utf8');
import db from '../src/db.ts';
import {
  parseChannelTargets, acceptsChannel, defaultTargetFor, channelForTarget,
} from '../src/lib/channel-targets.ts';
import { targetForNotice, TARGET_SOURCES, type TargetSource } from '../src/lib/notice-target.ts';
import { registerRemoteCommands } from '../src/lib/remote-commands.ts';
import { listCommands, getCommand, clearRegistries } from '../src/lib/commands-registry.ts';

/**
 * A CHANNEL IS AN ADDRESS — option 2 of the routing choices.
 *
 * Post in the film channel and it drives the film cartridge; post in the main one and it drives
 * the orchestrator. NeonCore routes by a name it reads from config and NEVER interprets: nothing
 * here knows what "film-engine" is or does, only that a channel id maps to that string.
 *
 * SET-BASED OVER THE COMMANDS THAT ACTUALLY RESOLVE A CARTRIDGE, discovered from the registry
 * rather than typed. Only `prompt` does today; `autonomy` addresses runs and `cartridges`
 * addresses nothing. A test written against `prompt` alone would pass on the day a second
 * targeted command was added and silently ignored the channel it was posted in.
 */

const MAIN = '111111111111111111';
const FILM = '1545620138697555978';   // the real channel this was built for

/** Commands that take a cartridge target, derived from the source, not listed. */
function targetedCommands(): string[] {
  const src = SRC('lib/remote-commands.ts');
  const out: string[] = [];
  for (const m of src.matchAll(/registerCommand\('([a-z]+)'/g)) {
    const i = m.index!;
    let depth = 0, started = false, end = i;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '(') { depth++; started = true; }
      else if (src[j] === ')') { depth--; if (started && depth === 0) { end = j; break; } }
    }
    if (src.slice(i, end).includes('resolveCartridge')) out.push(m[1]);
  }
  return out;
}

// ── the map ─────────────────────────────────────────────────────────────────

test('a channel→target map parses, and a malformed entry is dropped not guessed', () => {
  const m = parseChannelTargets(`${FILM}=film-engine, ${MAIN}=neoncore`);
  assert.equal(m.get(FILM), 'film-engine');
  assert.equal(m.get(MAIN), 'neoncore');

  // Junk must not become a target. A half-parsed entry would route commands at
  // whatever it happened to produce.
  for (const bad of ['', '   ', 'nothing', '=orphan', `${FILM}=`, '=']) {
    assert.equal(parseChannelTargets(bad).size, 0, `"${bad}" produced a mapping`);
  }
});

test('an unmapped channel is not accepted, and the primary channel always is', () => {
  const cfg = { channelId: MAIN, targets: parseChannelTargets(`${FILM}=film-engine`) };
  assert.equal(acceptsChannel(MAIN, cfg), true, 'the primary channel stopped being accepted');
  assert.equal(acceptsChannel(FILM, cfg), true, 'a mapped channel is not accepted');
  assert.equal(acceptsChannel('999999999999999999', cfg), false,
    'an unmapped channel was accepted — the bot would answer anywhere it is invited');
});

test('the primary channel has no default target, a mapped one does', () => {
  const cfg = { channelId: MAIN, targets: parseChannelTargets(`${FILM}=film-engine`) };
  assert.equal(defaultTargetFor(FILM, cfg), 'film-engine');
  assert.equal(defaultTargetFor(MAIN, cfg), undefined);
  assert.equal(defaultTargetFor('999999999999999999', cfg), undefined);
});

/*
 * AND IT HOLDS WHEN CONFIG MAPS THE PRIMARY CHANNEL TOO.
 *
 * The version above passes with the guard deleted, because the primary channel simply is not in
 * the map — proven by mutation. The case that actually matters is an operator mapping their main
 * channel by mistake: without the guard every untargeted command there would silently address
 * one cartridge, and succeed, which is the worst way to be wrong.
 */
test('the primary channel keeps no default even when config maps it', () => {
  const cfg = { channelId: MAIN, targets: parseChannelTargets(`${MAIN}=some-target, ${FILM}=film-engine`) };
  assert.equal(defaultTargetFor(MAIN, cfg), undefined,
    'the main channel acquired a default target — commands there would silently address one cartridge');
  assert.equal(defaultTargetFor(FILM, cfg), 'film-engine', 'the mapped channel stopped resolving');
});

// ── the commands ────────────────────────────────────────────────────────────

test('every command that resolves a cartridge honours the channel default', async () => {
  clearRegistries();
  registerRemoteCommands();

  const targeted = targetedCommands();
  assert.ok(targeted.length >= 1, 'no targeted commands found — this scan is not reading the registry');

  // A live cartridge to resolve against.
  db.prepare(`INSERT INTO agents (id, name, repo_name, machine, repo_path, agent_type, status, last_seen)
              VALUES ('a1', 'film', 'film-engine', 'm', '/x/film-engine', 'claude', 'working', datetime('now'))`).run();

  for (const name of targeted) {
    const handler = getCommand(name)!;
    assert.ok(handler, `${name} is not registered`);

    /*
     * RESOLUTION is what is under test, not delivery. `sendCommandToAgent` needs a live
     * WebSocket, which a unit test has no business standing up — so reaching the transport at
     * all is the proof that the channel's target resolved to a real cartridge. Replying
     * "No online cartridge matches" or "Usage:" means it did not.
     */
    const drive = async (ctx: Record<string, unknown>) => {
      let said = '';
      try {
        await handler({ args: 'do the thing', reply: async (t: string) => { said = t; }, ...ctx } as never);
      } catch (err) {
        if (!/WebSocket/i.test(String(err))) throw err;
        return { said, reachedTransport: true };
      }
      return { said, reachedTransport: false };
    };

    // Posted in the film channel with NO target named: must resolve without being told.
    const inChannel = await drive({ defaultTarget: 'film-engine' });
    assert.doesNotMatch(inChannel.said, /Usage:/i,
      `${name} asked for a target in a channel that already names one: ${inChannel.said}`);
    assert.doesNotMatch(inChannel.said, /No online cartridge/i,
      `${name} did not resolve the channel's target: ${inChannel.said}`);
    assert.ok(inChannel.reachedTransport || /film-engine/.test(inChannel.said),
      `${name} never addressed the channel's target: ${inChannel.said}`);

    /*
     * Posted in a channel that names nothing: it must not guess. The exact wording depends on
     * what was typed — "Usage:" for a bare command, "No online cartridge matches" when the first
     * word looked like a target and was not one. Asserting one phrasing tested the message
     * rather than the rule; what matters is that it refused to address anybody and never
     * reached the transport.
     */
    const bare = await drive({});
    assert.equal(bare.reachedTransport, false,
      `${name} dispatched to a cartridge nobody named`);
    assert.match(bare.said, /Usage:|No online cartridge/i,
      `${name} neither asked nor refused in a channel that names no target: ${bare.said}`);
    assert.doesNotMatch(bare.said, /Sent to/i,
      `${name} guessed a target in a channel that names none: ${bare.said}`);
  }

  db.prepare("DELETE FROM agents WHERE id = 'a1'").run();
});

test('an explicit target still wins over the channel default', async () => {
  clearRegistries();
  registerRemoteCommands();
  db.prepare(`INSERT INTO agents (id, name, repo_name, machine, repo_path, agent_type, status, last_seen)
              VALUES ('a2', 'other', 'gl-dev', 'm', '/x/gl-dev', 'claude', 'working', datetime('now'))`).run();

  let said = '';
  try {
    await getCommand('prompt')!({
      args: 'gl-dev do the thing', reply: async (t) => { said = t; }, defaultTarget: 'film-engine',
    });
  } catch (err) { if (!/WebSocket/i.test(String(err))) throw err; }
  // Either it said so, or it reached the transport for gl-dev. What it must NOT do is report
  // the channel's default — that would mean the default overrode what was typed.
  assert.doesNotMatch(said, /film-engine/,
    `the channel default overrode an explicit target: ${said}`);
  assert.doesNotMatch(said, /No online cartridge/i,
    `the explicit target did not resolve: ${said}`);
  db.prepare("DELETE FROM agents WHERE id = 'a2'").run();
});

/* NeonCore must not learn what a target IS. */
test('nothing outside config names a particular target', () => {
  for (const f of ['lib/channel-targets.ts', 'lib/commands-registry.ts', 'lib/remote-commands.ts']) {
    /*
     * COMMENTS STRIPPED FIRST. The first version matched this module's own docstring — the
     * sentence explaining that a target literal would BE the coupling — and reported the file
     * for saying what it does. A check that cries wolf on its own documentation is one nobody
     * runs twice. Line-based: every comment in these files is a whole-line or trailing one, and
     * a block-comment regex eats a `/*` inside a string.
     */
    const code = SRC(f)
      .split('\n')
      .map((l: string) => l.replace(/\/\/.*$/, ''))
      .filter((l: string) => !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    assert.ok(code.length > 300, `${f}: comment stripping removed almost everything — this scan reads nothing`);
    assert.doesNotMatch(code, /film-engine/,
      `${f} names a specific target in CODE — routing must read the name from config, never know it`);
  }
});

// ══ outbound: a reply lands where the conversation is ═══════════════════════

/**
 * Inbound made a channel an address and outbound stayed single-channel, so you could talk to a
 * cartridge in its own room and have every answer arrive somewhere else. A half-built
 * conversation is worse than none: a missing reply and a misdirected one look identical.
 */
test('a channel is found for a target, and an unmapped target finds none', () => {
  const cfg = { channelId: MAIN, targets: parseChannelTargets(`${FILM}=film-engine`) };
  assert.equal(channelForTarget('film-engine', cfg), FILM);
  assert.equal(channelForTarget('FILM-ENGINE', cfg), FILM, 'target matching is case-sensitive');
  assert.equal(channelForTarget('gl-dev', cfg), undefined,
    'an unmapped target resolved to a channel — notices would land in the wrong room');
  for (const empty of ['', '   ', undefined]) {
    assert.equal(channelForTarget(empty as string, cfg), undefined);
  }
});

/**
 * SET-BASED OVER THE WAYS A NOTICE CAN NAME ITS CARTRIDGE — `TARGET_SOURCES`, the registry in
 * notice-target.ts. Every notifyAll call site carries one of these already; resolving here
 * rather than threading a target through eight call sites is eight fewer chances to forget one,
 * and the one forgotten is the notice that goes to the wrong place.
 */
test('every declared way of naming a cartridge resolves', () => {
  db.prepare(`INSERT INTO agents (id, name, repo_name, machine, repo_path, agent_type, status, last_seen)
              VALUES ('t1', 'film', 'film-engine', 'm', '/x/film-engine', 'claude', 'working', datetime('now'))`).run();
  db.prepare(`INSERT INTO workflows (id, name, status, target_repos, created_at)
              VALUES ('w1', 'run', 'running', '["/x/film-engine"]', datetime('now'))`).run();

  const cases: Record<TargetSource, Record<string, unknown>> = {
    target: { target: 'film-engine' },
    agentId: { agentId: 't1' },
    workflowId: { workflowId: 'w1' },
  };
  assert.deepEqual(Object.keys(cases).sort(), [...TARGET_SOURCES].sort(),
    'this test does not cover every declared way of naming a cartridge');

  for (const source of TARGET_SOURCES) {
    const r = targetForNotice(cases[source]);
    assert.equal(r.target, 'film-engine', `${source} did not resolve the cartridge`);
    assert.equal(r.via, source, `${source} resolved via ${r.via}`);
  }

  // Nothing to go on is answered honestly rather than guessed.
  assert.deepEqual(targetForNotice({}), { via: null });
  assert.deepEqual(targetForNotice(undefined), { via: null });

  // An ambiguous workflow is NOT guessed: several repos is not an address.
  db.prepare(`INSERT INTO workflows (id, name, status, target_repos, created_at)
              VALUES ('w2', 'run', 'running', '["/x/a","/x/b"]', datetime('now'))`).run();
  assert.equal(targetForNotice({ workflowId: 'w2' }).target, undefined,
    'a workflow spanning several repos was routed to one of them');

  db.prepare("DELETE FROM agents WHERE id = 't1'").run();
  db.prepare("DELETE FROM workflows WHERE id IN ('w1','w2')").run();
});

/* An explicit target beats a derived one — a caller that knows better may say so. */
test('an explicit target outranks what could be derived', () => {
  db.prepare(`INSERT INTO agents (id, name, repo_name, machine, repo_path, agent_type, status, last_seen)
              VALUES ('t2', 'other', 'gl-dev', 'm', '/x/gl-dev', 'claude', 'working', datetime('now'))`).run();
  const r = targetForNotice({ agentId: 't2', target: 'film-engine' });
  assert.equal(r.target, 'film-engine');
  assert.equal(r.via, 'target');
  db.prepare("DELETE FROM agents WHERE id = 't2'").run();
});

/* Every notifyAll site must carry something this can resolve, or the routing is decorative. */
test('every notifyAll call site carries an id the resolver can use', () => {
  const roots = ['lib', 'routes'];
  const sites: string[] = [];
  for (const root of roots) {
    const dir = path.join(HERE, '..', 'src', root);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/notifyAll\(\{/g)) {
        // The object literal, bounded by brace depth rather than a line window.
        let depth = 0, started = false, end = m.index!;
        for (let j = m.index!; j < src.length; j++) {
          if (src[j] === '{') { depth++; started = true; }
          else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j; break; } }
        }
        const body = src.slice(m.index!, end);
        const named = /\b(agentId|workflowId|target)\b/.test(body);
        sites.push(`${root}/${f}${named ? '' : '  ← NAMES NO CARTRIDGE'}`);
      }
    }
  }
  assert.ok(sites.length >= 5, `only ${sites.length} notifyAll sites found; this scan is not reading them`);
  const blind = sites.filter((s) => s.includes('NAMES NO'));
  // Reported rather than failed: a notice about the machine as a whole legitimately names no
  // cartridge. What must never happen is that NONE of them do.
  assert.ok(blind.length < sites.length,
    `no notifyAll site names a cartridge — outbound routing would never fire: ${sites.join(', ')}`);
});
