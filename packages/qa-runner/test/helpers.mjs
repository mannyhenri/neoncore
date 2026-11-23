import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DENY } from '../src/index.mjs';

export const tmp = (name = 'qa') => mkdtempSync(join(tmpdir(), `qa-runner-${name}-`));

/** "send email" → "Send email": the label each default deny pattern is tried with. */
export const denyLabel = (p) => p.charAt(0).toUpperCase() + p.slice(1);

/** A page with one of everything the interpreter can act on, and every deny-listed button. */
const KITCHEN = `<!doctype html><html><head><title>Kitchen sink</title></head><body>
<a href="/next">Next page</a>
<label for="name">Name</label><input id="name">
<label for="pw">Secret</label><input id="pw" type="password" oninput="console.error('typed: ' + this.value)">
<label for="color">Colour</label><select id="color"><option>Red</option><option>Blue</option></select>
<label><input type="checkbox" id="agree"> Agree</label>
<button onclick="document.getElementById('out').textContent='clicked'">Go</button>
<input id="keys" placeholder="Type here" onkeydown="if (event.key === 'Enter') document.getElementById('out').textContent = 'entered'">
<p id="out" data-testid="out"></p>
<p id="hidden" style="display:none">Hidden text</p>
<ul><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>
${DEFAULT_DENY.map((p) => `<button onclick="document.getElementById('out').textContent='did ${p}'">${denyLabel(p)}</button>`).join('\n')}
</body></html>`;

export function startKitchen() {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'text/html' });
    if (req.url === '/next') return res.end('<!doctype html><title>Next</title><h1>Next</h1>');
    if (req.url === '/offsite') return res.end('<!doctype html><title>Offsite</title><img src="http://blocked.example.invalid/x.png" alt=""><p>offsite</p>');
    return res.end(KITCHEN);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve({ baseUrl, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

export const spec = (baseUrl, sentences, cache, extra = {}) => ({ baseUrl, allowHosts: ['127.0.0.1'], sentences, cache, ...extra });
