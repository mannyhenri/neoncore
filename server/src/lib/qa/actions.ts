/**
 * CHECKING WHAT A CARTRIDGE SUBMITS: the action format, and the repair rule.
 *
 * Everything a cartridge hands back is DATA to be interpreted by the runner — never code. This
 * module refuses anything that is not a well-formed QaAction, and it refuses any repair that
 * changes WHAT a check sentence checks: a repair may change how a step is done, never what is
 * verified (scope §8, "Repair hides a real bug").
 */
import { ACTION_KINDS, EXPECT_KINDS, isCheckSentence, QaError, type Locator, type QaAction } from './types.js';

const LOCATOR_KEYS = ['role', 'name', 'label', 'text', 'placeholder', 'testId', 'css'] as const;

function locator(v: unknown, where: string): Locator {
  if (!v || typeof v !== 'object') throw new QaError(`${where}: target must be a locator object`);
  const out: Locator = {};
  for (const k of LOCATOR_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string' && x.trim()) out[k] = x;
  }
  if (Object.keys(out).length === 0) throw new QaError(`${where}: target names no role, name, label, text, placeholder, testId or css`);
  return out;
}

/** One action, checked and normalised. Throws QaError naming what is wrong. */
export function parseAction(v: unknown, where: string): QaAction {
  if (!v || typeof v !== 'object') throw new QaError(`${where}: not an action object`);
  const a = v as Record<string, unknown>;
  const kind = a.do;
  if (typeof kind !== 'string' || !(ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new QaError(`${where}: "do" must be one of ${ACTION_KINDS.join(', ')}`);
  }
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  switch (kind) {
    case 'goto': {
      const p = str('path');
      if (!p) throw new QaError(`${where}: goto needs a path`);
      if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) throw new QaError(`${where}: goto takes a path relative to the target, not a URL`);
      return { do: 'goto', path: p };
    }
    case 'click': return { do: 'click', target: locator(a.target, where) };
    case 'fill': {
      const value = str('value');
      const valueEnv = str('valueEnv');
      if (value === undefined && !valueEnv) throw new QaError(`${where}: fill needs a value or a valueEnv`);
      return { do: 'fill', target: locator(a.target, where), ...(valueEnv ? { valueEnv } : { value }) };
    }
    case 'select': {
      const option = str('option');
      if (!option) throw new QaError(`${where}: select needs an option`);
      return { do: 'select', target: locator(a.target, where), option };
    }
    case 'check': return { do: 'check', target: locator(a.target, where), checked: a.checked !== false };
    case 'press': {
      const key = str('key');
      if (!key) throw new QaError(`${where}: press needs a key`);
      return { do: 'press', key };
    }
    case 'wait': {
      const ms = Number(a.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 5000) throw new QaError(`${where}: wait takes 0–5000 ms`);
      return { do: 'wait', ms };
    }
    default: {
      const ek = a.kind;
      if (typeof ek !== 'string' || !(EXPECT_KINDS as readonly string[]).includes(ek)) {
        throw new QaError(`${where}: expect kind must be one of ${EXPECT_KINDS.join(', ')}`);
      }
      const out: QaAction = { do: 'expect', kind: ek as (typeof EXPECT_KINDS)[number] };
      if (a.target !== undefined) out.target = locator(a.target, where);
      if (typeof a.equals === 'string' || typeof a.equals === 'number') out.equals = a.equals;
      if (typeof a.contains === 'string') out.contains = a.contains;
      return out;
    }
  }
}

export function parseSentenceActions(v: unknown, sentence: string, where: string): QaAction[] {
  if (!Array.isArray(v) || v.length === 0) throw new QaError(`${where}: needs at least one action`);
  const actions = v.map((x, i) => parseAction(x, `${where}, action ${i + 1}`));
  if (isCheckSentence(sentence) && !actions.some((x) => x.do === 'expect')) {
    throw new QaError(`${where}: "${sentence}" is a check — its actions must include an expect`);
  }
  return actions;
}

/** A whole cache: one action list per sentence, in order. */
export function parseCache(v: unknown, sentences: readonly string[]): QaAction[][] {
  if (!Array.isArray(v)) throw new QaError('cache must be an array with one action list per sentence');
  if (v.length !== sentences.length) throw new QaError(`cache has ${v.length} lists for ${sentences.length} sentences`);
  return v.map((list, i) => parseSentenceActions(list, sentences[i], `sentence ${i + 1}`));
}

/** What a check verifies: kind + expected value, independent of how the element is found. */
function assertionKey(a: QaAction): string | null {
  if (a.do !== 'expect') return null;
  return JSON.stringify([a.kind, a.equals === undefined ? null : String(a.equals), a.contains ?? null]);
}

/**
 * May `after` replace `before` for this sentence? For a check sentence, the multiset of
 * {kind, equals, contains} of its expects must be IDENTICAL: locators may change, the checked
 * thing may not. Any other sentence may be repaired freely (it asserts nothing).
 */
export function validateRepair(sentence: string, before: readonly QaAction[], after: readonly QaAction[]): { ok: true } | { ok: false; reason: string } {
  if (after.length === 0) return { ok: false, reason: 'a repair must keep at least one action' };
  const keys = (xs: readonly QaAction[]) => xs.map(assertionKey).filter((k): k is string => k !== null).sort();
  const was = keys(before);
  const now = keys(after);
  if (!isCheckSentence(sentence) && was.length === 0) return { ok: true };
  if (was.length !== now.length || was.some((k, i) => k !== now[i])) {
    const fmt = (ks: string[]) => ks.map((k) => { const [kind, eq, co] = JSON.parse(k) as [string, string | null, string | null]; return `${kind}${eq !== null ? ` = "${eq}"` : ''}${co !== null ? ` contains "${co}"` : ''}`; }).join('; ') || 'nothing';
    return { ok: false, reason: `a repair may change how a step is done, never what it checks — it checked ${fmt(was)}, the repair checks ${fmt(now)}` };
  }
  return { ok: true };
}
