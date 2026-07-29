import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serverAddIssue } from '../servers';
import type { ServerEntry } from '../../types';

/**
 * Why an address was rejected from the fleet.
 *
 * The old UI inferred this by checking whether the server list grew after dispatching the
 * add — inside a setTimeout that closed over the PRE-add prop. It therefore reported
 * "Not added" unconditionally, including for adds that succeeded, which made a working
 * fleet look broken.
 */

const entry = (url: string): ServerEntry =>
  ({ url, serverId: '', name: url, token: null, manual: true } as ServerEntry);

const FLEET = [entry('http://mannys-mac-pro.local:4040')];

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost:4040' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('serverAddIssue', () => {
  // A scheme-less address is the normal way to type one — nobody types http:// by choice.
  const ACCEPTED = [
    'emmanuels-macbook-pro.local:4040',
    'http://emmanuels-macbook-pro.local:4040',
    'HTTPS://Studio.local:8443',
    '192.168.4.26:4040',
    'emmanuels-macbook-pro.local:4040/',
  ];

  it('accepts every address shape a person would actually type', () => {
    const rejected = ACCEPTED.filter((u) => serverAddIssue(FLEET, u) !== null);
    expect(rejected, `these valid addresses were rejected: ${rejected.join(', ')}`).toEqual([]);
  });

  it('names the reason instead of guessing, for each distinct failure', () => {
    expect(serverAddIssue(FLEET, '')).toMatch(/does not look like an address/i);
    expect(serverAddIssue(FLEET, 'http://localhost:4040')).toMatch(/this server/i);
    expect(serverAddIssue(FLEET, 'mannys-mac-pro.local:4040')).toMatch(/already in your fleet/i);
  });

  it('treats a duplicate as a duplicate regardless of how it is typed', () => {
    for (const dupe of ['MANNYS-MAC-PRO.local:4040', 'http://mannys-mac-pro.local:4040/']) {
      expect(serverAddIssue(FLEET, dupe), `${dupe} should read as a duplicate`).toMatch(/already/i);
    }
  });
});
