/**
 * snapshot — what a cartridge needs to decide its next action: an ARIA snapshot of the page, its
 * links, buttons and fields each with a suggested QaAction locator, console errors, failed requests
 * and a screenshot. The page's text is DATA for the agent, never instructions.
 */
import { openSession, specProblem } from './session.mjs';

/** The interactive elements of the page, each with a locator the interpreter accepts. */
async function inventory(page) {
  return page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const labelOf = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.textContent); }
      const wrap = el.closest('label'); if (wrap) return clean(wrap.textContent);
      return clean(el.getAttribute('aria-label'));
    };
    const links = [...document.querySelectorAll('a[href]')].filter(visible).map((a) => {
      const text = clean(a.textContent) || clean(a.getAttribute('aria-label'));
      return { text, href: a.getAttribute('href'), locator: text ? { role: 'link', name: text } : { css: `a[href="${a.getAttribute('href')}"]` } };
    });
    const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(visible).map((b) => {
      const name = clean(b.textContent) || clean(b.getAttribute('value')) || clean(b.getAttribute('aria-label'));
      return { name, locator: name ? { role: 'button', name } : { css: b.id ? `#${CSS.escape(b.id)}` : b.tagName.toLowerCase() } };
    });
    const fields = [...document.querySelectorAll('input:not([type=submit]):not([type=button]):not([type=hidden]), select, textarea')].filter(visible).map((f) => {
      const label = labelOf(f);
      const type = f.tagName === 'INPUT' ? (f.getAttribute('type') || 'text') : f.tagName.toLowerCase();
      const locator = label ? { label } : f.getAttribute('placeholder') ? { placeholder: f.getAttribute('placeholder') } : f.id ? { css: `#${CSS.escape(f.id)}` } : { css: `[name="${f.getAttribute('name')}"]` };
      return { label, type, name: f.getAttribute('name') || '', locator, ...(type === 'password' ? { sensitive: true } : {}) };
    });
    return { links, buttons, fields };
  });
}

export async function snapshotPage(session, outDir) {
  const { page } = session;
  let aria = '';
  try { aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }); } catch { aria = ''; }
  let title = '';
  try { title = await page.title(); } catch { /* closed */ }
  const inv = await inventory(page).catch(() => ({ links: [], buttons: [], fields: [] }));
  const screenshot = await session.screenshot(`snapshot-${Date.now()}.png`);
  return { url: page.url(), title, aria, ...inv, console: [...session.consoleErrors], network: [...session.network], screenshot };
}

/** Open `url` (on the allow-list) and snapshot it. */
export async function snapshot({ url, allowHosts, outDir, state, denyActions }) {
  const base = (() => { try { return new URL(url); } catch { return null; } })();
  const problem = !base ? 'url must be absolute' : specProblem({ baseUrl: base.origin, allowHosts, denyActions });
  if (problem) return { status: 'blocked', error: problem };
  const session = await openSession({ baseUrl: base.origin, allowHosts }, outDir, { trace: false, state });
  let status = 'passed';
  let error;
  try {
    const res = await session.page.goto(url, { waitUntil: 'load', timeout: 15_000 });
    if (res && res.status() >= 400) { status = 'failed'; error = `${url} answered HTTP ${res.status()}`; }
  } catch (err) { status = 'failed'; error = err.message; }
  const snap = await snapshotPage(session, outDir);
  await session.close({ statePath: state });
  return { status, ...(error ? { error } : {}), ...snap };
}

