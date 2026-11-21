/**
 * EVERY bell notification says what kind it is — set-based over every place one is sent and
 * every event a feature can announce, read from the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFICATION_KINDS, PILOT_FAILED_EVENTS, PILOT_FINISHED_EVENTS, pilotEventKind, attentionKind } from '../src/lib/notification-kind.js';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});
const sources = files(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));

test('every place that sends a bell notification gives it a kind', () => {
  const sites: string[] = [];
  const bare: string[] = [];
  for (const { rel, text } of sources) {
    const re = /emit\('workflow_notification'[^,]*,\s*\{/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // The object literal that follows, to its closing brace.
      let depth = 1; let i = re.lastIndex;
      while (depth > 0 && i < text.length) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
      const body = text.slice(re.lastIndex, i);
      const line = text.slice(0, m.index).split('\n').length;
      sites.push(`${rel}:${line}`);
      if (!/\bkind:/.test(body)) bare.push(`${rel}:${line}`);
    }
  }
  assert.equal(sites.length, 5, `expected the five known send sites, found: ${sites.join(', ')}`);
  assert.deepEqual(bare, [], 'sent without a kind');
});

test('every event a feature announces has a kind, and each kind is the right one', () => {
  const events = new Map<string, Set<string>>();
  for (const { text } of sources) {
    const re = /announcePilot\(\s*[\w.]+,\s*'([\w-]+)'[\s\S]{0,400}?'(action|info)'/g;
    for (let m = re.exec(text); m; m = re.exec(text)) events.set(m[1], (events.get(m[1]) ?? new Set()).add(m[2]));
  }
  assert.ok(events.size >= 12, `found only ${[...events.keys()].join(', ')}`);
  for (const [event, urgencies] of events) for (const urgency of urgencies) {
    const kind = pilotEventKind(event, urgency as 'action' | 'info');
    assert.ok((NOTIFICATION_KINDS as readonly string[]).includes(kind), event);
    const want = (PILOT_FAILED_EVENTS as readonly string[]).includes(event) ? 'failed'
      : (PILOT_FINISHED_EVENTS as readonly string[]).includes(event) ? 'finished'
      : urgency === 'action' ? 'needs-you' : 'notice';
    assert.equal(kind, want, event);
  }
  // The named lists are real: every event in them is one a feature actually announces.
  for (const e of [...PILOT_FAILED_EVENTS, ...PILOT_FINISHED_EVENTS]) assert.ok(events.has(e), `${e} is never announced`);
});

test('every push type a run raises attention with has a kind', () => {
  const types = new Set<string>();
  for (const { text } of sources) {
    const re = /notifyNeedsAttention\([\s\S]{0,600}?'((?:workflow|decision|step)_[a-z_]+)'\s*,?\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) types.add(m[1]);
  }
  assert.ok(types.size >= 5, `found only ${[...types].join(', ')}`);
  for (const t of types) {
    assert.equal(attentionKind(t), /failed|interrupted|stalled/.test(t) ? 'failed' : 'needs-you', t);
  }
  assert.equal(attentionKind('workflow_step_failed'), 'failed');
  assert.equal(attentionKind('decision_gate'), 'needs-you');
  assert.equal(attentionKind('workflow_tasks_outstanding'), 'needs-you');
});
