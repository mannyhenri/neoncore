/**
 * N1 of docs/plans/build-order.md — one notice, every configured channel, no app SDK loose.
 *
 * THE FAILURE THIS PREVENTS. `stuck-detector.ts`, `workflow-executor-v2.ts` and
 * `routes/permissions.ts` each imported `sendPushToAll` from `lib/apns-push.js` directly. That
 * is survivable with one delivery app and unmaintainable with two: every new channel means
 * editing every call site, and the first one anybody forgets is silently quiet forever.
 *
 * The boundary test below is the plan's OWN done-when — "no file outside `lib/channels/`
 * imports an app SDK" — expressed as a scan over every source file rather than a check of the
 * three we happen to have converted. That matters because the defect is a PARTIAL port:
 * converting two call sites and leaving the third looks correct in review and leaves one
 * notification that only ever reaches one app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerChannel, clearChannels, notifyAll, listChannels,
  type Channel, type Notice, type Delivery,
} from '../src/lib/channels.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');

/** Every .ts file under server/src, so the boundary cannot be escaped by adding a directory. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(abs));
    else if (e.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p);

/**
 * Source with comments removed.
 *
 * Both scans below are about what a file DOES, and this codebase talks about its own coupling
 * constantly — lib/channels.ts opens by naming `sendPushToAll` as the thing it replaced, and
 * discord-bot.ts documents that it mirrors that signature. A scan that reads prose fails on the
 * very comments written to explain the fix, which is how the first run of this test reported
 * two violations that did not exist.
 *
 * `//` is only treated as a comment when it does not follow a colon, so a "http://" inside a
 * string does not swallow the rest of its line.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * THE SET: delivery-app SDKs. One entry per app NeonCore can speak through. Adding Slack means
 * adding a row here, and the scan then covers it everywhere at once.
 */
const APP_SDKS = ['discord.js', '@slack/', 'telegraf', 'node-telegram-bot-api'];

test('no file outside lib/channels/ imports a delivery app SDK', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const r = rel(file);
    // The adapters are the ONE place an SDK is allowed. lib/discord-bot.ts is the inbound
    // driver (a CommandSource), which is the same boundary from the other direction.
    if (r.startsWith('lib/channels/') || r === 'lib/discord-bot.ts') continue;

    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const sdk of APP_SDKS) {
      // A BARE specifier only. `./lib/channels/discord.js` is a local path that happens to end
      // in the package's name, and matching it flagged index.ts for importing its own adapter.
      const esc = sdk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const importsIt = new RegExp(`from\\s+['"]${esc}(['"]|/)`).test(src)
        || new RegExp(`require\\(\\s*['"]${esc}(['"]|/)`).test(src);
      if (importsIt) offenders.push(`${r} imports ${sdk}`);
    }
  }

  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n`);
});

test('no notification call site reaches past the abstraction to a transport', () => {
  // The whole point of N1. `routes/push.ts` is the ONE deliberate exception: it exists to verify
  // an APNs device token end to end, so fanning it to every channel would stop it testing the
  // thing it is named after. Stated here rather than left as an unexplained survivor.
  const ALLOWED = new Set(['lib/apns-push.ts', 'lib/channels/apns.ts', 'routes/push.ts']);
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const r = rel(file);
    if (ALLOWED.has(r)) continue;
    if (/\bsendPushToAll\b/.test(codeOnly(fs.readFileSync(file, 'utf8')))) {
      offenders.push(`${r} calls sendPushToAll directly — it should build a Notice and call notifyAll`);
    }
  }

  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n`);
});

// ── Behaviour ────────────────────────────────────────────────────────────────

function fake(name: string, opts: Partial<{
  configured: boolean; ok: boolean; drops: (keyof Notice)[]; throws: boolean;
}> = {}): Channel & { seen: Notice[] } {
  const seen: Notice[] = [];
  return {
    name, seen,
    isConfigured: () => opts.configured ?? true,
    async send(notice: Notice): Promise<Delivery> {
      if (opts.throws) throw new Error(`${name} exploded`);
      seen.push(notice);
      return { ok: opts.ok ?? true, dropped: opts.drops ?? [] };
    },
  };
}

const NOTICE: Notice = { title: 'Workflow failed', body: 'CE: Full Delivery #2 failed.' };

test('one notice reaches every configured channel', () => {
  clearChannels();
  const a = fake('a'), b = fake('b');
  registerChannel(a); registerChannel(b);

  return notifyAll(NOTICE).then((report) => {
    assert.equal(a.seen.length, 1, 'channel a did not receive the notice');
    assert.equal(b.seen.length, 1, 'channel b did not receive the notice');
    assert.deepEqual(listChannels().map((c) => c.name).sort(), ['a', 'b']);
    assert.equal(report.delivered, 2);
  });
});

test('an unconfigured channel is skipped, not failed', async () => {
  clearChannels();
  const on = fake('on'), off = fake('off', { configured: false });
  registerChannel(on); registerChannel(off);

  const report = await notifyAll(NOTICE);
  assert.equal(off.seen.length, 0, 'an unconfigured channel was sent to');
  assert.equal(report.delivered, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 0, 'not being configured is not a failure');
});

test('a channel that cannot carry a field SAYS SO rather than pretending', async () => {
  // The plan is explicit: "APNs drops attachments and reports it, so a missing picture is a
  // known limitation and not a mystery." A boolean return cannot express that, which is why
  // send() resolves a Delivery.
  clearChannels();
  registerChannel(fake('apns-like', { drops: ['attachments'] }));

  const report = await notifyAll({ ...NOTICE, attachments: ['/tmp/shot.png'] });
  assert.deepEqual(report.dropped, [{ channel: 'apns-like', fields: ['attachments'] }]);
});

test('one channel throwing does not silence the others, and never reaches the caller', async () => {
  // A notification path that can break its caller is worse than one that is quiet: these fire
  // from the workflow executor, where an exception would take a run down with it.
  clearChannels();
  const good = fake('good');
  registerChannel(fake('bad', { throws: true }));
  registerChannel(good);

  const report = await notifyAll(NOTICE);
  assert.equal(good.seen.length, 1, 'a throwing channel prevented delivery to a healthy one');
  assert.equal(report.failed, 1);
  assert.equal(report.delivered, 1);
});

test('notifyAll with no channels registered is inert, not an error', async () => {
  clearChannels();
  const report = await notifyAll(NOTICE);
  assert.deepEqual(report, { delivered: 0, skipped: 0, failed: 0, dropped: [] });
});
