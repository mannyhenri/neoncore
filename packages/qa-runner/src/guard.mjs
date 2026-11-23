/**
 * GUARDRAILS (docs/plans/qa-section.md § Runner CLI). Enforced in the browser, not asked for in a
 * prompt: an agent that decides to click "Delete" is refused here, whatever it was told.
 */

/** Clicks refused unless the spec says allowDestructive. Patterns, matched case-insensitively. */
export const DEFAULT_DENY = ['delete', 'remove', 'pay', 'purchase', 'send email', 'unsubscribe'];

/**
 * A request host ("host" or "host:port") is allowed when an allow-list entry covers it: an entry
 * with a port covers that host on that port only, one without a port covers the host on any port;
 * either also covers its subdomains. The SAME rule as the server (server/src/lib/qa/store.ts
 * hostAllowed), which writes entries like "localhost:4061".
 */
export function hostAllowed(host, allowHosts) {
  const split = (v) => {
    const s = String(v || '').toLowerCase().trim();
    const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(s.includes(']') || (s.match(/:/g) || []).length === 1 ? s : `[${s}]`);
    return m ? { name: m[1], port: m[2] || '' } : { name: s, port: '' };
  };
  const h = split(host);
  return (allowHosts || []).some((raw) => {
    const a = split(raw);
    if (!a.name) return false;
    if (a.port && a.port !== h.port) return false;
    return h.name === a.name || h.name.endsWith(`.${a.name}`);
  });
}

/** Host of a URL — hostname, plus the port when one is given — or '' for data:, about:, blob: and the like. */
export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? u.host : '';
  } catch { return ''; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The deny pattern a label matches, or null. Whole words, so "Payroll" is not "pay". */
export function deniedBy(label, denyActions = DEFAULT_DENY) {
  const text = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  for (const raw of denyActions) {
    const p = String(raw || '').toLowerCase().trim();
    if (!p) continue;
    if (new RegExp(`(^|[^a-z0-9])${escapeRe(p).replace(/\\? /g, '\\s+')}($|[^a-z0-9])`, 'i').test(text)) return raw;
  }
  return null;
}

/** Replace every secret value with ••• in a string. */
export function maskString(s, secrets) {
  let out = String(s);
  for (const v of secrets) if (v) out = out.split(v).join('•••');
  return out;
}

/** Deep-mask a JSON-able value. */
export function maskDeep(value, secrets) {
  if (!secrets.size) return value;
  if (typeof value === 'string') return maskString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, secrets)]));
  return value;
}
