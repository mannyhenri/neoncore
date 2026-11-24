/**
 * OVER-THE-AIR UPDATES — the JavaScript and the native side agree (ios/NeonCore/NeonCorePush.swift).
 *
 * The native code cannot be compiled here, so what binds the two halves is checked as text: the
 * runtime number is the same on both sides; every native method src/ota.ts calls is exported in
 * NeonCorePush.m AND implemented in Swift; the release build launches NeonCoreUpdates.launchBundle()
 * before the bundle inside the app; and the probation and rollback rules are where they belong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const listeners: ((s: string) => void)[] = [];
vi.mock('react-native', () => ({
  AppState: { addEventListener: (_: string, cb: (s: string) => void) => { listeners.push(cb); return { remove: () => listeners.splice(listeners.indexOf(cb), 1) }; } },
  NativeModules: {}, Platform: { OS: 'ios' },
}));
const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock('react', () => ({ useEffect: (fn: () => void | (() => void)) => { hooks.effects.push(fn); }, useState: (v: unknown) => [v, () => {}] }));
import { OTA_RUNTIME, HEALTHY_AFTER_MS, describeUpdate, useUpdates, type UpdatesNative } from '../ota';

const IOS = path.join(import.meta.dirname, '..', '..', 'ios', 'NeonCore');
const SWIFT = fs.readFileSync(path.join(IOS, 'NeonCorePush.swift'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(IOS, 'NeonCorePush.m'), 'utf8');
const DELEGATE = fs.readFileSync(path.join(IOS, 'AppDelegate.swift'), 'utf8');
const OTA = fs.readFileSync(path.join(import.meta.dirname, '..', 'ota.ts'), 'utf8');

beforeEach(() => { hooks.effects = []; listeners.length = 0; });

describe('updates: the native side and the JavaScript agree', () => {
  it('one runtime number on both sides', () => {
    expect(/static let runtime = "([^"]+)"/.exec(SWIFT)?.[1]).toBe(OTA_RUNTIME);
  });
  it('every native method the JavaScript calls is exported to React Native and implemented in Swift', () => {
    const called = [...new Set([...OTA.matchAll(/impl\??\.(ota[A-Za-z]+)\(/g)].map((m) => m[1]))].sort();
    expect(called).toEqual(['otaCheckNow', 'otaConfigure', 'otaMarkHealthy', 'otaStatus']);
    for (const name of called) {
      expect(BRIDGE, `${name} in NeonCorePush.m`).toMatch(new RegExp(`RCT_EXTERN_METHOD\\(${name}\\b`));
      expect(SWIFT, `${name} in NeonCorePush.swift`).toMatch(new RegExp(`@objc(\\(${name}[:a-zA-Z]*\\))?\\s*func ${name}\\(`));
    }
  });
  it('the release build launches a downloaded version first, then the one inside the app; it checks after launch', () => {
    expect(DELEGATE).toMatch(/NeonCoreUpdates\.launchBundle\(\) \?\? Bundle\.main\.url\(forResource: "main", withExtension: "jsbundle"\)/);
    expect(DELEGATE).toMatch(/NeonCoreUpdates\.checkInBackground\(\)/);
  });
  it('the safety rules are in the native code: checksums, probation, rollback, a fresh build starts clean', () => {
    expect(SWIFT).toMatch(/SHA256\.hash/);
    expect(SWIFT).toMatch(/hex\(fetched\) == expected/);
    expect(SWIFT).toMatch(/static let probationLaunches = \d/);
    expect(SWIFT).toMatch(/launches > probationLaunches/);
    expect(SWIFT).toMatch(/defaults\.string\(forKey: "ota\.build"\) != build/);
    expect(SWIFT).toMatch(/"since"/);
  });
});

describe('updates: the app reports and checks', () => {
  const fake = (): UpdatesNative & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, otaConfigure: (s, t) => calls.push(`configure ${s} ${t}`), otaMarkHealthy: () => calls.push('healthy'), otaCheckNow: () => calls.push('check'), otaStatus: async () => ({ running: '', next: '', lastCheck: '', lastError: '', runtime: '1', build: '45' }) };
  };
  it('tells the native side its server, says healthy after a few seconds, and checks whenever the app comes to the front', () => {
    vi.useFakeTimers();
    const n = fake();
    useUpdates('http://mac.local:4040', 'tok', n);
    const cleanups = hooks.effects.map((fx) => fx());
    expect(n.calls).toEqual(['configure http://mac.local:4040 tok']);
    vi.advanceTimersByTime(HEALTHY_AFTER_MS - 1);
    expect(n.calls).not.toContain('healthy');
    vi.advanceTimersByTime(1);
    expect(n.calls).toContain('healthy');
    listeners.forEach((l) => l('background'));
    listeners.forEach((l) => l('active'));
    expect(n.calls.filter((c) => c === 'check')).toHaveLength(1);
    cleanups.forEach((c) => typeof c === 'function' && c());
    vi.useRealTimers();
  });
  it('says, in words, what is running and what waits', () => {
    const base = { running: '', next: '', lastCheck: '2026-11-23T23:15:00Z', lastError: '', runtime: '1', build: '45' };
    expect(describeUpdate(null)).toBe('This build cannot update over the air.');
    expect(describeUpdate(base)).toBe('As installed (build 45) — up to date (checked 23:15).');
    expect(describeUpdate({ ...base, running: '0.8.0-1' })).toBe('Version 0.8.0-1 — up to date (checked 23:15).');
    expect(describeUpdate({ ...base, running: '0.8.0-1', next: '0.8.0-2' })).toBe('Version 0.8.0-1 — version 0.8.0-2 is ready: close and reopen the app to use it.');
    expect(describeUpdate({ ...base, lastError: 'Could not check for updates: offline' })).toBe('As installed (build 45) — Could not check for updates: offline');
  });
});
