import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * Every route must have a caller — the write-has-reader guard, one altitude up.
 *
 * We shipped a column nobody read, built a guard against that, and then shipped an entire
 * HTTP API nobody called: 7 queue routes, mounted and green under 265 tests, with zero
 * references in dashboard, mobile or extension. The existing guard checks columns; a route
 * with no caller is the identical defect at a different altitude.
 *
 * ARTEFACTS is a table rather than a file per kind, deliberately: when we find the NEXT
 * altitude — and we will, the same way we found this one — adding it should be a row.
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/**
 * A routed artefact: where its routes are declared, which module must expose a client
 * function for each, and which surfaces must call that client.
 */
const ARTEFACTS = [
  {
    name: 'queue',
    routeFile: 'server/src/routes/queue.ts',
    mountPrefix: '/api/queue',
    clientDir: 'packages/client/src',
    // {dir, entry, mounts} rather than a bare directory. mobile/App.tsx is OUTSIDE
    // mobile/src and is the file that decides whether a screen is REACHABLE — a scan of
    // src alone would pass while the app shipped a screen no user can open, which is the
    // same dead-drop class one altitude down. The pair makes forgetting the entry file
    // impossible for the NEXT artefact too.
    // Each surface DECLARES which client functions it is expected to call. A single OR
    // over the whole directory passed the surface on one match anywhere, which is how a
    // route with a client wrapper and zero callers survived inside the guard built to
    // catch exactly that. Declaring the set makes mobile's deliberate subset a stated
    // intent rather than a gap the guard cannot distinguish from an accident.
    surfaces: [
      {
        dir: 'dashboard/src', entry: 'dashboard/src/App.tsx', mounts: '<QueuePanel',
        calls: ['getQueue', 'enqueueItem', 'cancelQueueItem', 'pauseQueueLane', 'resumeQueueLane', 'tickQueue'],
      },
      {
        // Pause/resume/tick are desk work and deliberately absent from a phone.
        dir: 'mobile/src', entry: 'mobile/App.tsx', mounts: '<QueueScreen',
        calls: ['getQueue', 'enqueueItem', 'cancelQueueItem'],
      },
    ],
    // 6 since /validate was deleted — it had a route, a client wrapper and zero callers.
    expectedRouteCount: 6,
  },
];

/** `router.get('/lanes/:lane/pause', ...)` -> { method, subPath } */
function routesOf(file: string): { method: string; subPath: string }[] {
  const src = read(file);
  return [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)]
    .map((m) => ({ method: m[1].toUpperCase(), subPath: m[2] }));
}

for (const art of ARTEFACTS) {
  test(`${art.name}: route discovery is non-vacuous`, () => {
    // A scanner that silently matches nothing passes forever. This is the assertion whose
    // absence let the write-has-reader guard read green while finding no routes at all.
    assert.ok(exists(art.routeFile), `${art.routeFile} does not exist`);
    const routes = routesOf(art.routeFile);
    assert.equal(routes.length, art.expectedRouteCount,
      `expected ${art.expectedRouteCount} routes in ${art.routeFile}, discovered ${routes.length} — ` +
      'either the routes changed (update the count deliberately) or the scanner is broken');
  });

  test(`${art.name}: every route has a client function in the shared package`, () => {
    const routes = routesOf(art.routeFile);
    const clientSrc = walk(art.clientDir).map(read).join('\n');
    assert.ok(clientSrc.length > 0, `${art.clientDir} produced no source — scanner is broken`);

    const missing = routes.filter((r) => {
      // The client must name the concrete path it calls. Parameterised segments are
      // template holes, so match on the literal prefix before the first ':'.
      // createClient's BASE_URL already ends in /api, so the client writes '/queue…' not
      // '/api/queue…'. Match the path as the CLIENT expresses it, not as express mounts it.
      const clientPath = art.mountPrefix.replace(/^\/api/, '') + (r.subPath === '/' ? '' : r.subPath);
      const literal = clientPath.split('/:')[0];
      return !clientSrc.includes(literal);
    }).map((r) => `${r.method} ${art.mountPrefix}${r.subPath}`);

    assert.deepEqual(missing, [],
      `${missing.length} route(s) have no client function in ${art.clientDir}: ${missing.join(', ')}`);
  });

  test(`${art.name}: every client function is claimed by a surface — no orphan wrappers`, () => {
    // A client function nobody calls is the same dead drop as a route nobody calls, one
    // layer in. This is what /queue/validate was: route, wrapper, zero callers, guard green.
    const clientSrc = walk(art.clientDir).map(read).join('\n');
    const declared = [...clientSrc.matchAll(/^\s{2}(\w+):\s*\(/gm)]
      .map((m) => m[1])
      .filter((n) => /Queue|queue/.test(n));
    const claimed = new Set(art.surfaces.flatMap((s) => s.calls));
    const orphans = declared.filter((d) => !claimed.has(d));
    assert.deepEqual(orphans, [],
      `client exposes queue functions no surface calls: ${orphans.join(', ')} — call them or delete them`);
  });

  for (const surface of art.surfaces) {
    test(`${art.name}: ${surface.dir} calls every client function it declares`, () => {
      // Scan dir AND entry as one corpus: mobile/App.tsx is outside mobile/src, so a call
      // moved there would read as missing on a surface that demonstrably works.
      const files = [...walk(surface.dir), surface.entry].filter((f) => exists(f));
      assert.ok(files.length > 1, `${surface.dir} produced no source — scanner is broken`);
      const src = files.map(read).join('\n');
      const missing = surface.calls.filter((fn) => !src.includes(fn));
      assert.deepEqual(missing, [],
        `${surface.dir} declares these client calls but never makes them: ${missing.join(', ')}`);
    });

    test(`${art.name}: ${surface.entry} makes the surface REACHABLE, not merely present`, () => {
      // A screen that exists but is never routed is a file, not a feature. Both surfaces
      // satisfy this today, so this is a ratchet — locking the property in while it holds
      // is the only time locking it in is free.
      assert.ok(exists(surface.entry), `${surface.entry} does not exist`);
      const entry = read(surface.entry);
      assert.ok(entry.includes(surface.mounts),
        `${surface.entry} never renders ${surface.mounts} — the screen exists but no user can open it`);
    });
  }
}
