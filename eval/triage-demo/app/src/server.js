/** Ledgerly's HTTP API (README: "API"). `node src/server.js` listens on PORT (default 3000). */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { INVOICES } from './data.js';
import { summary } from './invoice.js';
import { weeklyPay } from './timesheet.js';
import { createSession, userFor } from './auth/session.js';

export const PAGE_SIZE = 5;

/** Page `page` (1-based) of the invoice list, oldest first. */
export function invoicePage(page) {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  const items = INVOICES.slice(start, start + PAGE_SIZE - 1).map(summary);
  return { page: p, pageSize: PAGE_SIZE, total: INVOICES.length, items };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/invoices') return send(res, 200, invoicePage(url.searchParams.get('page')));
      const one = /^\/invoices\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && one) {
        const inv = INVOICES.find((i) => i.id === Number(one[1]));
        return inv ? send(res, 200, summary(inv)) : send(res, 404, { error: 'no such invoice' });
      }
      if (req.method === 'POST' && url.pathname === '/timesheets') {
        const body = await readJson(req);
        try { return send(res, 200, weeklyPay(body.hours, Number(body.rate))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readJson(req);
        if (!body.user) return send(res, 400, { error: 'user is required' });
        return send(res, 200, createSession(String(body.user)));
      }
      if (req.method === 'GET' && url.pathname === '/me') {
        const user = userFor(String(req.headers['x-session'] ?? ''));
        return user ? send(res, 200, { user }) : send(res, 401, { error: 'please sign in' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`Ledgerly API on http://localhost:${port}`));
}
