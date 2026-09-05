/**
 * Every caller that reaches the API must present the fleet token — BEFORE strict is flipped.
 *
 * lib/auth.ts states the hazard in its own header: "Turning auth on is a fleet-wide, silent,
 * self-inflicted outage waiting to happen. Every hook script, relay and runner already
 * deployed on every machine sends no Authorization header. Flip straight to strict and all of
 * them 401 at once: agents stop registering, activity stops flowing, and the grid simply goes
 * quiet. Nothing crashes, so nothing obviously points at auth."
 *
 * That is why permissive is the default and why the flip waits for the log to go quiet. But a
 * quiet LOG is not proof: it only shows callers that happened to fire while someone was
 * watching. `open-directory.ts` registers an agent exactly once per new repo, and would have
 * sat unnoticed for weeks between appearances.
 *
 * So the readiness check is derived from the CODE — every non-test file that makes an HTTP
 * call to the orchestrator — not from what the log caught. Set-based because the danger is
 * uniform: seven of eight callers authenticating is still a dead fleet, just a slower one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Files that talk to the orchestrator over HTTP. Discovered, not remembered. */
function apiCallers(): string[] {
  const roots = ['agent/hooks', 'agent/relay', 'agent/runner', 'server/src', 'packages/client/src', 'mobile/src'];
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') || e.name === '__pycache__') continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(child); continue; }
      if (!/\.(ts|tsx|js|py)$/.test(e.name)) continue;
      if (/\.test\.|__tests__/.test(child)) continue;
      const src = fs.readFileSync(path.join(ROOT, child), 'utf8');
      // Makes a request AND names an orchestrator path. Both, so a Discord or filesystem
      // call is not dragged in and a route table is not mistaken for a caller.
      const requests = /\bfetch\(|urlopen|http\.request|https?\.request|requests\.(get|post|put|delete)/.test(src);
      const orchestrator = /ORCHESTRATOR_URL|NEONCORE_URL|localhost:4040|\/api\//.test(src);
      if (requests && orchestrator) out.push(child);
    }
  };
  roots.forEach(walk);
  return out.sort();
}

/** Does this file attach the fleet token to what it sends? */
function authenticates(rel: string): boolean {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
  // `auth_headers` too: the Python helper is snake_case, and a regex that only knew the
  // JS spelling reported all four hooks as unauthenticated after they had been fixed.
  return /Authorization|Bearer|fleetToken|FLEET_TOKEN|auth_?[Hh]eaders\(/.test(src);
}

test('the caller scan is non-vacuous', () => {
  const callers = apiCallers();
  assert.ok(callers.length >= 10,
    `expected the fleet's API callers, found ${callers.length} — the scanner is broken and every ` +
    'assertion below would pass while finding nothing');
});

/**
 * Callers that legitimately send nothing, with the reason.
 *
 * An exemption list is only honest if it cannot rot, so the test below proves each entry
 * still calls ONLY public paths — an exemption that silently starts calling a private route
 * is the hole this whole file exists to close.
 */
const EXEMPT: Record<string, string> = {
  'server/src/index.ts':
    'self health-check on /api/health, which lib/auth.ts isPublicPath() exempts by design — '
    + 'it is how a peer decides this server is reachable at all',
};

test('every exemption calls ONLY paths auth actually treats as public', () => {
  const publicPaths = ['/api/health'];
  const bad: string[] = [];
  for (const rel of Object.keys(EXEMPT)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Only what is actually FETCHED. Scanning every backtick string swept in route mounts
    // and log lines — app.use('/api/agents', ...) is not a call this process makes.
    for (const m of src.matchAll(/fetch\(\s*`([^`]+)`/g)) {
      const called = m[1].replace(/^[^/]*\$\{[^}]*\}/, '').replace(/\$\{[^}]*\}/g, '');
      const apiPath = called.slice(called.indexOf('/api/'));
      if (!called.includes('/api/')) continue;
      if (!publicPaths.some((pp) => apiPath.startsWith(pp))) bad.push(`${rel} fetches ${apiPath}`);
    }
  }
  assert.deepEqual(bad, [],
    `an exemption calls a NON-public path and will 401 under strict:\n  ${bad.join('\n  ')}`);
});

test('EVERY API caller presents the fleet token', () => {
  const silent = apiCallers().filter((f) => !authenticates(f) && !(f in EXEMPT));
  assert.deepEqual(silent, [],
    `these call the orchestrator with no Authorization header and will 401 the moment ` +
    `NEONCORE_AUTH_MODE=strict is set:\n  ${silent.join('\n  ')}\n` +
    'Seven of eight authenticating is still a dead fleet.');
});

test('the token reaches a machine without anyone copying it by hand', () => {
  // The hooks are spawned by Claude Code, not by the server, so an env var set for `npm start`
  // never reaches them. Something has to put the secret where a hook can read it, or every
  // machine becomes a manual step that is skipped once and fails silently.
  // NOT /writeTokenFile|TOKEN_FILE/: renaming the export left TOKEN_FILE in the function
  // body, so that regex passed against a build that published nothing. Assert the EXPORT and
  // the CALL SITE — a rename or a deleted call breaks one of them.
  const auth = fs.readFileSync(path.join(ROOT, 'server/src/lib/auth.ts'), 'utf8');
  assert.match(auth, /export function writeTokenFile\(/,
    'lib/auth.ts no longer exports writeTokenFile — nothing publishes the token');
  assert.match(auth, /export const TOKEN_FILE\b/,
    'lib/auth.ts no longer exports TOKEN_FILE — the agent side has no agreed location');

  const index = fs.readFileSync(path.join(ROOT, 'server/src/index.ts'), 'utf8');
  assert.match(index, /writeTokenFile\(/,
    'the server never CALLS writeTokenFile at boot — the file would only ever exist by hand');

  // The agent side must read the same location the server writes.
  for (const rel of ['agent/hooks/_fleet.py', 'agent/lib/fleet-token.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /\.neoncore/, `${rel} does not read the published token location`);
    assert.match(src, /NEONCORE_FLEET_TOKEN/, `${rel} ignores the env override`);
  }
});

/**
 * ── THE CREDENTIAL ITSELF ───────────────────────────────────────────────────────────────
 *
 * Wiring every caller to send a token is necessary and not sufficient. This fleet's stored
 * `fleet_token` was found to be the literal string `dev-token`: nine characters, a well-known
 * placeholder, and the first thing anyone would try. Strict mode on top of that is not
 * authentication — it is a lock whose key is printed on the door, and it would read as
 * "secured" on every dashboard and in every status line.
 *
 * So readiness is asserted, not assumed. This test fails while the token is guessable, which
 * is the correct signal: the callers are ready, the SECRET is not.
 *
 * Deliberately NOT rotated automatically. A wrong token is rejected in BOTH modes — only an
 * absent one is grandfathered — so rotating instantly 401s every client that already holds
 * the old value: the other server, the dashboard's stored fleet entries, the phone. That is
 * an operator action with a blast radius, not a side effect of running the tests.
 */
const PLACEHOLDERS = new Set([
  'dev-token', 'devtoken', 'changeme', 'change-me', 'secret', 'token',
  'password', 'neoncore', 'test', 'testing', 'local', 'dev',
]);

test('the fleet token is a real secret, not a placeholder', () => {
  const authSrc = fs.readFileSync(path.join(ROOT, 'server/src/lib/auth.ts'), 'utf8');
  // The generator is what a rotation must produce; assert it is actually random and long,
  // so "rotate it" cannot quietly mean "set another short string".
  assert.match(authSrc, /randomBytes\(\s*\d{2,}\s*\)/,
    'ensureFleetToken no longer mints a long random token');

  const file = path.join(process.env.HOME || '', '.neoncore', 'token');
  if (!fs.existsSync(file)) return; // nothing published on this machine — nothing to judge
  const token = fs.readFileSync(file, 'utf8').trim();

  assert.ok(!PLACEHOLDERS.has(token.toLowerCase()),
    `the fleet token is the placeholder "${token}" — strict mode over a guessable secret is ` +
    'not authentication. Rotate it before flipping NEONCORE_AUTH_MODE=strict.');
  assert.ok(token.length >= 24,
    `the fleet token is ${token.length} characters — too short to resist guessing. ` +
    'Rotate it before flipping NEONCORE_AUTH_MODE=strict.');
});
