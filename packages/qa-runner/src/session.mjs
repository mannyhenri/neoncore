/**
 * One browser session: Chromium with the guardrails installed and the evidence recorders attached
 * (console errors, failed or refused network requests, a trace).
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DENY, hostAllowed, hostOf } from './guard.mjs';

/** Check a spec's shape and guardrails before a browser is started. Returns an error string or null. */
export function specProblem(spec) {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  let base;
  try { base = new URL(spec.baseUrl); } catch { return 'spec.baseUrl must be an absolute http(s) URL'; }
  if (!/^https?:$/.test(base.protocol)) return 'spec.baseUrl must be http(s)';
  if (!Array.isArray(spec.allowHosts) || spec.allowHosts.length === 0) return 'spec.allowHosts must list at least one host';
  if (!hostAllowed(base.host, spec.allowHosts)) return `refused: ${base.host} is not on the allow-list`;
  if (spec.denyActions !== undefined && !Array.isArray(spec.denyActions)) return 'spec.denyActions must be an array';
  if (spec.env !== undefined && !Array.isArray(spec.env)) return 'spec.env must be an array of env names';
  return null;
}

export function contextFor(spec) {
  return {
    baseUrl: spec.baseUrl,
    allowHosts: spec.allowHosts,
    denyActions: spec.denyActions && spec.denyActions.length ? spec.denyActions : DEFAULT_DENY,
    allowDestructive: spec.allowDestructive === true,
    env: Array.isArray(spec.env) ? spec.env : null,
    secrets: new Set(),
  };
}

export async function openSession(spec, outDir, { trace = true, state } = {}) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: spec.headless !== false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(state && existsSync(state) ? { storageState: state } : {}),
  });
  const consoleErrors = [];
  const network = [];
  // Guardrail: nothing leaves the allow-list — not a page, not an image, not a fetch.
  await context.route('**/*', (route) => {
    const req = route.request();
    const host = hostOf(req.url());
    if (host && !hostAllowed(host, spec.allowHosts)) {
      network.push({ url: req.url(), status: 0, method: req.method(), blocked: true });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  context.on('requestfailed', (req) => {
    if (network.some((n) => n.blocked && n.url === req.url())) return;
    network.push({ url: req.url(), status: 0, method: req.method(), error: req.failure()?.errorText || 'failed' });
  });
  context.on('response', (res) => {
    if (res.status() >= 400) network.push({ url: res.url(), status: res.status(), method: res.request().method() });
  });
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`));

  return {
    browser, context, page, consoleErrors, network,
    async screenshot(name) {
      const path = join(outDir, name);
      try { await page.screenshot({ path, fullPage: true, timeout: 5000 }); return path; } catch { return undefined; }
    },
    async close({ tracePath, statePath } = {}) {
      if (statePath) await context.storageState({ path: statePath }).catch(() => {});
      if (trace && tracePath) await context.tracing.stop({ path: tracePath }).catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
