import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE APP IS BUILT AND SHARED LOCALLY, WITH THE PERSONAL TEAM — no Gridlight account (2026-11-23:
 * "remove the gridlight account for the mobile app and simply share it locally"). The Gridlight
 * team's archive was blocked on its Program License Agreement; the personal team ("Emmanuel Henri",
 * W7QXFS7XBU) is free, so it cannot sign Push Notifications and its profiles last 7 days.
 * `npm run ios:release` therefore: signs with the personal team, builds WITHOUT the push
 * entitlement (left in the project for a paid team), and installs onto the connected iPhone.
 * SET: every release surface — the script, package.json, RELEASE.md, README.md.
 */
const MOBILE = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(resolve(MOBILE, f), 'utf8');
const SURFACES = ['scripts/build-ios.sh', 'package.json', 'RELEASE.md', 'README.md'];

describe('local iOS build', () => {
  it.each(SURFACES)('%s names no Gridlight team', (f) => {
    expect(read(f)).not.toMatch(/3AXRJ22S9P/);
  });

  const script = read('scripts/build-ios.sh');
  it('signs with the personal team by default (NEONCORE_TEAM_ID overrides)', () => {
    expect(script).toMatch(/NEONCORE_TEAM_ID:-W7QXFS7XBU/);
    expect(script).not.toMatch(/find-certificate -c "Apple Development"/);   // the first cert was Gridlight's
  });
  it('builds without the push entitlement — a personal team cannot sign it', () => {
    // An empty CODE_SIGN_ENTITLEMENTS on the command line is ignored by xcodebuild (found live):
    // the local build points at its own entitlements file, which has no aps-environment.
    expect(script).toMatch(/CODE_SIGN_ENTITLEMENTS=NeonCore\/NeonCore\.local\.entitlements/);
    const local = read('ios/NeonCore/NeonCore.local.entitlements');
    expect(local).toMatch(/<dict>/);
    expect(local).not.toMatch(/aps-environment/);
    expect(read('ios/NeonCore/NeonCore.entitlements')).toMatch(/aps-environment/);   // kept for a paid team
  });
  it('installs onto the connected iPhone; no archive upload, no TestFlight', () => {
    expect(script).toMatch(/devicectl device install app/);
    expect(script).not.toMatch(/exportArchive|app-store-connect|TestFlight/);
  });
  it('npm run ios:release runs it', () => {
    expect(JSON.parse(read('package.json')).scripts['ios:release']).toBe('bash scripts/build-ios.sh');
  });
});
