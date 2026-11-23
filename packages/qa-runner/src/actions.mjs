/**
 * THE QaAction INTERPRETER (docs/plans/qa-section.md § The cached action format). A cached test is
 * data, never code: each action is one of the kinds below, and this file is the only thing that
 * turns one into browser input.
 */
import { deniedBy, DEFAULT_DENY, hostAllowed, hostOf } from './guard.mjs';

export const ACTION_KINDS = ['goto', 'click', 'fill', 'select', 'check', 'press', 'wait', 'expect'];
export const EXPECT_KINDS = ['visible', 'hidden', 'text', 'url', 'value', 'count'];
export const LOCATOR_KEYS = ['role', 'name', 'label', 'text', 'placeholder', 'testId', 'css'];
export const MAX_WAIT_MS = 5000;
/** How long an action or an expectation waits for the page before it fails. */
export const STEP_TIMEOUT_MS = 5000;

/** A step was refused by a guardrail — the run is `blocked`, not merely failed. */
export class GuardError extends Error {
  constructor(message) { super(message); this.name = 'GuardError'; }
}

/** A sentence that checks rather than acts. */
export function isCheckSentence(sentence) {
  return /^\s*(?:\d+[.)]\s*)?(check|verify|ensure|confirm|expect|assert)\b/i.test(String(sentence || ''));
}

/** Why an action is malformed, or null. Validated before anything runs. */
export function invalidAction(a) {
  if (!a || typeof a !== 'object') return 'an action must be an object';
  if (!ACTION_KINDS.includes(a.do)) return `unknown action "${a.do}" (one of ${ACTION_KINDS.join(', ')})`;
  const needsTarget = ['click', 'fill', 'select', 'check'].includes(a.do);
  if (needsTarget && !validLocator(a.target)) return `"${a.do}" needs a target locator (${LOCATOR_KEYS.join(', ')})`;
  if (a.target !== undefined && !validLocator(a.target)) return `"${a.do}" has an invalid target`;
  switch (a.do) {
    case 'goto': return typeof a.path === 'string' && a.path ? null : '"goto" needs a path';
    case 'fill':
      if (a.valueEnv !== undefined && typeof a.valueEnv !== 'string') return '"fill" valueEnv must be an env NAME';
      return a.value !== undefined || a.valueEnv ? null : '"fill" needs value or valueEnv';
    case 'select': return typeof a.option === 'string' ? null : '"select" needs an option';
    case 'check': return typeof a.checked === 'boolean' ? null : '"check" needs checked: true|false';
    case 'press': return typeof a.key === 'string' && a.key ? null : '"press" needs a key';
    case 'wait': return Number.isFinite(a.ms) && a.ms >= 0 ? null : '"wait" needs ms ≥ 0';
    case 'expect':
      if (!EXPECT_KINDS.includes(a.kind)) return `unknown expect kind "${a.kind}" (one of ${EXPECT_KINDS.join(', ')})`;
      if (['visible', 'hidden', 'value', 'count'].includes(a.kind) && !a.target) return `expect "${a.kind}" needs a target`;
      if (['url', 'value', 'count'].includes(a.kind) && a.equals === undefined && a.contains === undefined) return `expect "${a.kind}" needs equals or contains`;
      if (a.kind === 'text' && a.equals === undefined && a.contains === undefined) return 'expect "text" needs equals or contains';
      return null;
    default: return null;
  }
}

function validLocator(t) {
  return !!t && typeof t === 'object' && LOCATOR_KEYS.some((k) => typeof t[k] === 'string' && t[k] !== '');
}

/** A Playwright locator for a QaAction Locator. The most specific key wins. */
export function locate(page, t) {
  let loc;
  if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.role) loc = page.getByRole(t.role, t.name ? { name: t.name, exact: true } : {});
  else if (t.label) loc = page.getByLabel(t.label, { exact: true });
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder, { exact: true });
  else if (t.text) loc = page.getByText(t.text, { exact: true });
  else if (t.name) loc = page.getByRole('button', { name: t.name, exact: true }).or(page.getByRole('link', { name: t.name, exact: true }));
  else loc = page.locator(t.css);
  return loc.first();
}

/** A short human description of a locator, for errors. */
export function describeLocator(t = {}) {
  return LOCATOR_KEYS.filter((k) => t[k]).map((k) => `${k}=${JSON.stringify(t[k])}`).join(' ');
}

const poll = async (check, timeout = STEP_TIMEOUT_MS) => {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await check();
    if (last.ok || Date.now() >= until) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
};

const matches = (actual, a) => (a.equals !== undefined ? String(actual).trim() === String(a.equals).trim() : String(actual).includes(String(a.contains)));
const wanted = (a) => (a.equals !== undefined ? `equal ${JSON.stringify(a.equals)}` : `contain ${JSON.stringify(a.contains)}`);

/**
 * Perform one action. Throws Error (a failed step) or GuardError (a refused step).
 * ctx: { baseUrl, allowHosts, denyActions, allowDestructive, env (allowed env names or null), secrets: Set }
 */
export async function perform(page, a, ctx) {
  const bad = invalidAction(a);
  if (bad) throw new Error(bad);
  switch (a.do) {
    case 'goto': {
      const url = new URL(a.path, ctx.baseUrl).toString();
      if (!hostAllowed(hostOf(url), ctx.allowHosts)) throw new GuardError(`refused: ${url} is not on the allow-list`);
      const res = await page.goto(url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS * 2 });
      if (res && res.status() >= 400) throw new Error(`${a.path} answered HTTP ${res.status()}`);
      return;
    }
    case 'click': {
      const loc = locate(page, a.target);
      const declared = [a.target.name, a.target.text, a.target.label, a.target.testId].filter(Boolean).join(' ');
      let shown = '';
      try { await loc.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }); } catch { throw new Error(`no element ${describeLocator(a.target)} to click`); }
      try { shown = [await loc.innerText({ timeout: 1000 }), await loc.getAttribute('aria-label', { timeout: 1000 }), await loc.getAttribute('value', { timeout: 1000 })].filter(Boolean).join(' '); } catch { /* label only */ }
      const hit = deniedBy(declared, ctx.denyActions) || deniedBy(shown, ctx.denyActions);
      if (hit && !ctx.allowDestructive) throw new GuardError(`refused: "${(shown || declared).trim()}" is a destructive action (deny-list "${hit}"); set allowDestructive to allow it`);
      await loc.click({ timeout: STEP_TIMEOUT_MS });
      await page.waitForLoadState('load', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      return;
    }
    case 'fill': {
      let value = a.value;
      if (a.valueEnv) {
        if (ctx.env && !ctx.env.includes(a.valueEnv)) throw new Error(`env ${a.valueEnv} is not one this spec may read`);
        value = process.env[a.valueEnv];
        if (value === undefined) throw new Error(`env ${a.valueEnv} is not set`);
        if (value) ctx.secrets.add(value);
      }
      const loc = locate(page, a.target);
      try { await loc.fill(String(value), { timeout: STEP_TIMEOUT_MS }); } catch { throw new Error(`no field ${describeLocator(a.target)} to fill`); }
      return;
    }
    case 'select': {
      const loc = locate(page, a.target);
      try { await loc.selectOption({ label: a.option }, { timeout: STEP_TIMEOUT_MS }); } catch {
        try { await loc.selectOption(a.option, { timeout: STEP_TIMEOUT_MS }); } catch { throw new Error(`no option "${a.option}" in ${describeLocator(a.target)}`); }
      }
      return;
    }
    case 'check': {
      const loc = locate(page, a.target);
      try { await loc.setChecked(a.checked, { timeout: STEP_TIMEOUT_MS }); } catch { throw new Error(`could not ${a.checked ? 'check' : 'uncheck'} ${describeLocator(a.target)}`); }
      return;
    }
    case 'press': {
      await page.keyboard.press(a.key);
      await page.waitForLoadState('load', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      return;
    }
    case 'wait': {
      await page.waitForTimeout(Math.min(MAX_WAIT_MS, a.ms));
      return;
    }
    case 'expect': return expectOn(page, a, ctx);
    default: throw new Error(`unknown action "${a.do}"`);
  }
}

async function expectOn(page, a, ctx) {
  const what = a.target ? describeLocator(a.target) : 'the page';
  switch (a.kind) {
    case 'visible': {
      const r = await poll(async () => ({ ok: await locate(page, a.target).isVisible().catch(() => false) }));
      if (!r.ok) throw new Error(`expected ${what} to be visible`);
      if (a.equals !== undefined || a.contains !== undefined) return expectOn(page, { ...a, kind: 'text' }, ctx);
      return;
    }
    case 'hidden': {
      const r = await poll(async () => ({ ok: !(await locate(page, a.target).isVisible().catch(() => false)) }));
      if (!r.ok) throw new Error(`expected ${what} to be hidden`);
      return;
    }
    case 'text': {
      const r = await poll(async () => {
        const actual = a.target ? await locate(page, a.target).innerText({ timeout: 500 }).catch(() => null) : await page.locator('body').innerText().catch(() => '');
        return { ok: actual !== null && matches(actual, a), actual };
      });
      if (!r.ok) throw new Error(`expected the text of ${what} to ${wanted(a)}, ${r.actual === null ? 'but it was not found' : `was ${JSON.stringify(String(r.actual).slice(0, 200))}`}`);
      return;
    }
    case 'url': {
      const rel = () => { const u = new URL(page.url()); const b = new URL(ctx.baseUrl); return u.origin === b.origin ? u.pathname + u.search : u.toString(); };
      const r = await poll(async () => { const actual = rel(); return { ok: matches(actual, a), actual }; });
      if (!r.ok) throw new Error(`expected the URL to ${wanted(a)}, was ${JSON.stringify(r.actual)}`);
      return;
    }
    case 'value': {
      const r = await poll(async () => { const actual = await locate(page, a.target).inputValue({ timeout: 500 }).catch(() => null); return { ok: actual !== null && matches(actual, a), actual }; });
      if (!r.ok) throw new Error(`expected the value of ${what} to ${wanted(a)}, ${r.actual === null ? 'but it was not found' : `was ${JSON.stringify(r.actual)}`}`);
      return;
    }
    case 'count': {
      const all = () => {
        const t = a.target;
        if (t.testId) return page.getByTestId(t.testId);
        if (t.role) return page.getByRole(t.role, t.name ? { name: t.name, exact: true } : {});
        if (t.label) return page.getByLabel(t.label, { exact: true });
        if (t.placeholder) return page.getByPlaceholder(t.placeholder, { exact: true });
        if (t.text) return page.getByText(t.text, { exact: true });
        return page.locator(t.css);
      };
      const r = await poll(async () => { const actual = await all().count(); return { ok: matches(actual, a), actual }; });
      if (!r.ok) throw new Error(`expected the count of ${what} to ${wanted(a)}, was ${r.actual}`);
      return;
    }
    default: throw new Error(`unknown expect kind "${a.kind}"`);
  }
}

export { DEFAULT_DENY };
