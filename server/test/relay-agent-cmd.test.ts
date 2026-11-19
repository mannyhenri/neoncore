/**
 * The relay must find the agent CLI even when the launch shell's PATH does not have it, and say
 * so when it is nowhere — instead of spawning into a silent exit 1 (2026-11-19: a newer nvm
 * default node had no `claude`, and every dashboard launch died ~20 ms in with nothing on screen).
 *
 * Every resolution path of resolveAgentCommand is one case below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs module from the relay, no type declarations
import { resolveAgentCommand, fallbackDirs } from '../../agent/relay/agent-cmd.mjs';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent/relay/index.js');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cmd-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const mkbin = (dir: string, name = 'claude', mode = 0o755) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\necho ok\n');
    fs.chmodSync(p, mode);
    return p;
  };
  return { root, home, mkbin };
}

const isWin = process.platform === 'win32';

test('found on PATH', { skip: isWin }, () => {
  const { root, home, mkbin } = sandbox();
  const p = mkbin(path.join(root, 'onpath'));
  assert.deepEqual(resolveAgentCommand('claude', { env: { PATH: path.join(root, 'onpath') }, home }), { path: p, via: 'path' });
});

test('explicit path: used when executable, null when missing', { skip: isWin }, () => {
  const { root, home, mkbin } = sandbox();
  const p = mkbin(path.join(root, 'x'));
  assert.deepEqual(resolveAgentCommand(p, { env: { PATH: '' }, home }), { path: p, via: 'explicit' });
  assert.equal(resolveAgentCommand(path.join(root, 'nope', 'claude'), { env: { PATH: '' }, home }), null);
});

test('not on PATH: found in each fallback location', { skip: isWin }, () => {
  for (const rel of [['.local', 'bin'], ['.claude', 'local'], ['.npm-global', 'bin'], ['.bun', 'bin']]) {
    const { home, mkbin } = sandbox();
    const p = mkbin(path.join(home, ...rel));
    assert.deepEqual(resolveAgentCommand('claude', { env: { PATH: '/nonexistent' }, home }), { path: p, via: 'fallback' }, rel.join('/'));
  }
});

test('not on PATH: found in an nvm version bin — the 2026-11-19 failure', { skip: isWin }, () => {
  const { home, mkbin } = sandbox();
  // The default moved to the newer node, which has no claude; the older one does.
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.23.5', 'bin'), { recursive: true });
  const p = mkbin(path.join(home, '.nvm', 'versions', 'node', 'v22.15.1', 'bin'));
  const nvmPathOnly = path.join(home, '.nvm', 'versions', 'node', 'v22.23.5', 'bin');
  assert.deepEqual(resolveAgentCommand('claude', { env: { PATH: nvmPathOnly }, home }), { path: p, via: 'fallback' });
});

test('nvm versions are searched newest first (numeric, not lexical)', { skip: isWin }, () => {
  const { home, mkbin } = sandbox();
  mkbin(path.join(home, '.nvm', 'versions', 'node', 'v9.11.2', 'bin'));
  const newest = mkbin(path.join(home, '.nvm', 'versions', 'node', 'v22.15.1', 'bin'));
  mkbin(path.join(home, '.nvm', 'versions', 'node', 'v21.6.1', 'bin'));
  assert.equal(resolveAgentCommand('claude', { env: { PATH: '' }, home })?.path, newest);
  const nvmDirs = fallbackDirs({ home, env: {} }).filter((d: string) => d.includes('.nvm'));
  assert.deepEqual(nvmDirs.map((d: string) => path.basename(path.dirname(d))), ['v22.15.1', 'v21.6.1', 'v9.11.2']);
});

test('NVM_DIR is honoured', { skip: isWin }, () => {
  const { root, home, mkbin } = sandbox();
  const p = mkbin(path.join(root, 'custom-nvm', 'versions', 'node', 'v20.0.0', 'bin'));
  assert.equal(resolveAgentCommand('claude', { env: { PATH: '', NVM_DIR: path.join(root, 'custom-nvm') }, home })?.path, p);
});

test('PATH wins over fallbacks', { skip: isWin }, () => {
  const { root, home, mkbin } = sandbox();
  mkbin(path.join(home, '.local', 'bin'));
  const onPath = mkbin(path.join(root, 'onpath'));
  assert.equal(resolveAgentCommand('claude', { env: { PATH: path.join(root, 'onpath') }, home })?.via, 'path');
  assert.equal(resolveAgentCommand('claude', { env: { PATH: path.join(root, 'onpath') }, home })?.path, onPath);
});

test('a non-executable file or a directory named claude is skipped', { skip: isWin }, () => {
  const { root, home, mkbin } = sandbox();
  mkbin(path.join(root, 'noexec'), 'claude', 0o644);
  fs.mkdirSync(path.join(root, 'isdir', 'claude'), { recursive: true });
  const real = mkbin(path.join(home, '.local', 'bin'));
  const PATH = [path.join(root, 'noexec'), path.join(root, 'isdir')].join(path.delimiter);
  assert.deepEqual(resolveAgentCommand('claude', { env: { PATH }, home }), { path: real, via: 'fallback' });
});

test('nowhere: null', { skip: isWin }, () => {
  const { home } = sandbox();
  assert.equal(resolveAgentCommand('claude', { env: { PATH: '/nonexistent' }, home }), null);
  assert.equal(resolveAgentCommand('', { env: { PATH: '' }, home }), null);
});

test('win32: passed through to the OS (PATHEXT / .cmd)', () => {
  assert.deepEqual(resolveAgentCommand('claude.cmd', { env: { PATH: '' }, platform: 'win32', home: '/x' }), { path: 'claude.cmd', via: 'path' });
});

test('relay: a missing agent CLI fails loudly on the terminal with 127, before registering', { skip: isWin }, () => {
  const { home } = sandbox();
  const r = spawnSync(process.execPath, [RELAY], {
    cwd: home,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      HOME: home,
      PATH: path.dirname(process.execPath), // node only — no claude anywhere
      NEONCORE_URL: 'http://127.0.0.1:9', // nothing listens: proves we exit before registering
      NEONCORE_AGENT_CMD: 'neoncore-no-such-agent-cli',
    },
  });
  assert.equal(r.status, 127, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /cannot find `neoncore-no-such-agent-cli`/);
  assert.doesNotMatch(r.stderr, /could not reach orchestrator/, 'must fail before trying to register');
});
