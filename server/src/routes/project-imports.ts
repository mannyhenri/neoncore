/**
 * /api/project-imports — answering and applying "Generate with AI" requests (lib/project-import.ts).
 *
 * Two audiences, as with the feature pipeline: the cartridge SUBMITS (through the MCP tool
 * `neoncore_submit_project_import` or the curl fallback) — which stores a proposal and creates
 * nothing; the person APPLIES what they ticked. Starting an import is POST /api/projects/:id/imports.
 */
import { Router } from 'express';
import { getImport, importPrompt, importDocument, submitImport, applyImport, ImportError } from '../lib/project-import.js';
import { docsChanged } from '../lib/project-docs.js';

const router = Router();

function fail(res: import('express').Response, err: unknown) {
  if (err instanceof ImportError) return res.status(err.status).json({ error: err.message });
  throw err;
}

router.get('/:id', (req, res) => {
  const imp = getImport(req.params.id);
  if (!imp) return res.status(404).json({ error: 'import request not found' });
  res.json(imp);
});

/** What the cartridge was asked, verbatim. */
router.get('/:id/prompt', (req, res) => {
  if (!getImport(req.params.id)) return res.status(404).json({ error: 'import request not found' });
  res.json({ prompt: importPrompt(req.params.id) });
});

/** The uploaded document a plan is read from, as text — what the cartridge fetches when it was too long for the prompt. */
router.get('/:id/document', (req, res) => {
  const doc = importDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'this request has no document' });
  res.type('text/markdown; charset=utf-8').send(doc.text);
});

/** Where the cartridge submits. Stores a proposal; creates nothing. */
router.post('/:id/submit', (req, res) => {
  const body = (req.body ?? {}) as { result?: unknown };
  try {
    const imp = submitImport(req.params.id, body.result !== undefined ? body.result : body);
    res.json({ ok: true, status: imp.status, notes: imp.notes });
  } catch (err) { fail(res, err); }
});

/** THE ONLY PATH from the proposal to the project: the architecture, features, backlog items and changelog entries the person kept. */
router.post('/:id/apply', (req, res) => {
  try {
    const out = applyImport(req.params.id, req.body ?? {});
    docsChanged(out.imp.projectId);
    res.json(out);
  } catch (err) { fail(res, err); }
});

export default router;
