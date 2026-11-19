import { describe, it, expect } from 'vitest';
import { isUndelivered, undeliveredNotice, type SendOutcome } from '../lib/deliveryNotice';

const agent = { id: 'a1', repoName: 'neoncore', name: 'neoncore', agentType: 'claude' as const, sessionId: 'sess-1', repoPath: '/code/neoncore' };

describe('isUndelivered — every transport the server can answer with', () => {
  // The full set lib/send-command.ts concludes with, plus the shapes a send can come back as.
  const cases: [string, SendOutcome | null, boolean][] = [
    ['no-channel', { delivered: false, transport: 'no-channel' }, true],
    ['primary-socket', { delivered: true, transport: 'primary-socket' }, false],
    ['agent-room', { delivered: true, transport: 'agent-room' }, false],
    ['inbox-socket (pending, not lost)', { delivered: false, transport: 'inbox-socket' }, false],
    ['queued behind current work', { queued: true }, false],
    ['forwarded to a peer', { delivered: true }, false],
    ['the send itself failed', null, false],
  ];
  for (const [name, o, want] of cases) it(name, () => expect(isUndelivered(o)).toBe(want));
});

describe('undeliveredNotice', () => {
  it('names the cartridge and the exact relaunch command', () => {
    expect(undeliveredNotice(agent, { transport: 'no-channel' })).toEqual({
      agentId: 'a1', who: 'neoncore · claude',
      relaunch: 'cd /code/neoncore && node ~/.neoncore/relay/index.js -- --resume sess-1',
    });
  });
  it('has no command to offer without a session id', () => {
    expect(undeliveredNotice({ ...agent, sessionId: '' }, { transport: 'no-channel' })?.relaunch).toBeNull();
  });
  it('is null when it was delivered', () => {
    expect(undeliveredNotice(agent, { transport: 'primary-socket', delivered: true })).toBeNull();
  });
});
