/**
 * Rendering the morning paper, server-side.
 *
 * The digest step used to hand an agent a prose description of the layout and ask it to write
 * the HTML. That cannot produce the same paper twice — the type, the spacing and the running
 * order drifted between mornings, and "it should look the same every single time" is not
 * something a prompt can promise.
 *
 * So the agent sends DATA and gets the page back. The template lives in lib/digest-template.ts,
 * in this repository, under test, and every run goes through the same function.
 */
import express from 'express';
import { renderDigestHtml, type DigestData } from '../lib/digest-template.js';

const router = express.Router();

/** Coerce whatever arrived into the shape the renderer expects. A missing list is an empty one. */
function coerce(body: Record<string, unknown>): DigestData {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    date: String(body.date ?? ''),
    throughLine: String(body.throughLine ?? ''),
    itemCount: Number(body.itemCount ?? 0),
    actOnIt: arr(body.actOnIt) as DigestData['actOnIt'],
    worthKnowing: arr(body.worthKnowing) as DigestData['worthKnowing'],
    aiNoise: arr(body.aiNoise) as DigestData['aiNoise'],
    background: arr(body.background) as DigestData['background'],
    dropped: arr(body.dropped) as DigestData['dropped'],
  };
}

/**
 * POST /api/digest/render — digest data in, the finished page out as text/html.
 *
 * Returns HTML rather than JSON so the caller can write the body straight to a file; wrapping
 * it in JSON would mean every caller needs a parser to save a document.
 */
router.post('/render', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!body.date) return res.status(400).json({ error: 'date is required — the paper is dated' });
  try {
    res.type('html').send(renderDigestHtml(coerce(body)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
