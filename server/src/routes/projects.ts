import { Router } from 'express';
import { asyncRoute } from '../lib/async-route.js';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { setProjectCartridges, getProjectCartridges } from '../lib/resolve-agent.js';
import type { Project } from '../types.js';
import { projectTotalCostUsd } from '../lib/goal-cost.js';
import { createFeature, deleteFeatureCascade, pilotSummary } from './goals.js';
import { buildProjectSpec, renderSpecMarkdown, renderRoadmapMarkdown, renderRoadmapHtml, renderArchitectureMarkdown, architecturePage } from '../lib/project-spec.js';
import {
  changelogFor, addEntry, updateEntry, deleteEntry, getEntry, cutRelease, renderChangelogMarkdown, CHANGE_KINDS,
} from '../lib/project-changelog.js';
import { publishProjectDocs, docsChanged, DOCS_DIR } from '../lib/project-docs.js';
import {
  MAX_ARCHITECTURE_CHARS, importsFor, createImportRow, buildImportPrompt, setImportPrompt, failImport, getImport, normalizeParts,
} from '../lib/project-import.js';
import { guardBusy } from '../lib/queue-if-busy.js';
import { sendCommandToAgent, noChannel, inboxPending, whenInboxSettles } from '../lib/send-command.js';
import { cartridgeExists } from '../lib/cartridge-exists.js';
import { deleteProjectCascade } from '../lib/project-delete.js';

const router = Router();

function estimateTokens(inputChars: number, outputChars: number): number {
  return Math.round((inputChars + outputChars) / 4);
}

function normalizeProject(row: Record<string, unknown>, extra?: Partial<Project>): Project {
  return {
    cartridges: extra?.cartridges ?? [],
    id: row.id as string,
    goalId: (row.goal_id as string) || null,
    name: row.name as string,
    description: (row.description as string) || '',
    primaryRepo: (row.primary_repo as string) || '',
    color: (row.color as string) || '#a855f7',
    architecture: (row.architecture as string) || '',
    // The page itself is served by GET /:id/docs/architecture?format=html — too big for every list row.
    hasArchitecturePage: !!String(row.architecture_html || '').trim(),
    docsAutoPublish: !!row.docs_auto_publish,
    docsPublishedAt: (row.docs_published_at as string) || '',
    docsPublishError: (row.docs_publish_error as string) || '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...extra,
  };
}

function withComputedFields(row: Record<string, unknown>): Project {
  const projectId = row.id as string;
  // The cartridges a project owns, and the live cartridge rows behind them. Surfaced on every
  // read so a client never has to make a second call to know what a project is made of — and
  // so no UI is tempted to re-derive it from primary_repo, which is now only a seed.
  const cartridges = getProjectCartridges(projectId);

  const goalRow = row.goal_id
    ? (db.prepare('SELECT name FROM goals WHERE id = ?').get(row.goal_id) as { name: string } | undefined)
    : undefined;

  const stepRows = db.prepare(`
    SELECT ws.dispatched_prompt, ws.result
    FROM workflow_steps ws
    JOIN workflows w ON ws.workflow_id = w.id
    WHERE w.project_id = ?
  `).all(projectId) as { dispatched_prompt: string; result: string }[];

  const inputChars = stepRows.reduce((s, r) => s + (r.dispatched_prompt?.length || 0), 0);
  const outputChars = stepRows.reduce((s, r) => s + (r.result?.length || 0), 0);

  const { runCount } = db.prepare(`
    SELECT COUNT(*) as runCount FROM workflows WHERE project_id = ? AND template_id IS NOT NULL
  `).get(projectId) as { runCount: number };

  const lastRun = db.prepare(`
    SELECT status, started_at FROM workflows WHERE project_id = ? AND template_id IS NOT NULL ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { status: string; started_at: string } | undefined;

  const { activeRunCount } = db.prepare(`
    SELECT COUNT(*) as activeRunCount FROM workflows WHERE project_id = ? AND status = 'running' AND template_id IS NOT NULL
  `).get(projectId) as { activeRunCount: number };

  // The project's features and how far along they are — what the project list shows at a glance.
  // Features that already existed when the project was taken on are its baseline, not its progress.
  const all = (db.prepare("SELECT id, status, origin FROM goals WHERE project_id = ?").all(projectId) as { id: string; status: string; origin: string }[]);
  const features = all.filter((f) => f.origin !== 'imported');
  let featuresDone = 0, featuresActive = 0, featuresNeedYou = 0;
  // The same reading as the dashboard's feature list (lib/featureStatus.ts): a feature is DONE when
  // it is marked done — a finished pipeline is waiting for you to read its report first.
  for (const f of features) {
    const p = pilotSummary(f.id);
    if (f.status === 'achieved') featuresDone++;
    else if (p && p.phase !== 'cancelled') {
      featuresActive++;
      if (['clarifying', 'proposed', 'staffing', 'paused', 'completed'].includes(p.phase) || p.awaitingReview || p.plannerFailed) featuresNeedYou++;
    }
  }

  return normalizeProject(row, {
    cartridges,
    goalName: goalRow?.name,
    runCount,
    tokensUsed: estimateTokens(inputChars, outputChars),
    // Every repo the project owns, not just the first one: a project is now the set of repos its
    // features run in.
    costUsd: projectTotalCostUsd(projectId, (row.primary_repo as string) || ''),
    lastRunStatus: lastRun?.status || null,
    lastRunAt: lastRun?.started_at || null,
    activeRunCount,
    featureCount: features.length,
    featuresExisting: all.length - features.length,
    featuresDone,
    featuresActive,
    featuresNeedYou,
  });
}

router.get('/', (req, res) => {
  const goalId = req.query.goalId as string | undefined;
  const rows = goalId
    ? db.prepare('SELECT * FROM projects WHERE goal_id = ? ORDER BY created_at DESC').all(goalId) as Record<string, unknown>[]
    : db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];

  res.json(rows.map(withComputedFields));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const workflows = db.prepare(`
    SELECT id, name, status, started_at, completed_at, run_number
    FROM workflows WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.params.id) as Record<string, unknown>[];

  res.json({ project: withComputedFields(row), workflows });
});

router.post('/', (req, res) => {
  const { name, description, goalId, primaryRepo, color, cartridges } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO projects (id, goal_id, name, description, primary_repo, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, goalId || null, name.trim(), description?.trim() || '', primaryRepo?.trim() || '', color || '#a855f7', now, now);

  // Tie the cartridges at CREATION. A project without them is a name with no work attached,
  // and asking the user to come back and link them later is how they stay unlinked. The
  // primaryRepo field still seeds the set so older clients keep working unchanged.
  const initial = Array.isArray(cartridges) && cartridges.length
    ? (cartridges as string[])
    : (primaryRepo?.trim() ? [primaryRepo.trim()] : []);
  if (initial.length) setProjectCartridges(id, initial);

  const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(withComputedFields(created));
});

router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const { name, description, goalId, primaryRepo, color, cartridges, architecture, docsAutoPublish } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE projects SET name = ?, description = ?, goal_id = ?, primary_repo = ?, color = ?, updated_at = ?,
                        architecture = ?, docs_auto_publish = ?
    WHERE id = ?
  `).run(
    name?.trim() || row.name,
    description?.trim() ?? row.description,
    goalId !== undefined ? goalId || null : row.goal_id,
    primaryRepo?.trim() ?? row.primary_repo,
    color || row.color,
    now,
    typeof architecture === 'string' ? architecture.trim().slice(0, MAX_ARCHITECTURE_CHARS) : row.architecture,
    docsAutoPublish !== undefined ? (docsAutoPublish ? 1 : 0) : row.docs_auto_publish,
    req.params.id,
  );

  // Only when the caller SENDS cartridges — an absent field means "leave them alone", while an
  // empty array means "this project owns none". Collapsing those would silently unlink every
  // project edited by a client that does not know about cartridges yet.
  if (Array.isArray(cartridges)) setProjectCartridges(req.params.id, cartridges as string[]);

  docsChanged(req.params.id);
  // Turning sync on publishes straight away — "keep the docs in sync" starts with docs that are.
  if (docsAutoPublish && !row.docs_auto_publish) publishProjectDocs(req.params.id).catch((err) => {
    db.prepare('UPDATE projects SET docs_publish_error = ? WHERE id = ?').run(String(err instanceof Error ? err.message : err).slice(0, 500), req.params.id);
  });
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json(withComputedFields(updated));
});

router.delete('/:id', (req, res) => {
  // A project's features are defined BY the project — they go with it (their pilots are stopped
  // first). `?keepFeatures=1` leaves them unfiled instead, for a person who is reorganising.
  const features = db.prepare('SELECT id FROM goals WHERE project_id = ?').all(req.params.id) as { id: string }[];
  if (req.query.keepFeatures === '1') {
    db.prepare("UPDATE goals SET project_id = '' WHERE project_id = ?").run(req.params.id);
  } else {
    for (const f of features) deleteFeatureCascade(f.id);
  }
  // Cascade through lib so the cartridge mappings go too — deleting the project row alone left
  // them orphaned, invisibly, because every read joins through `projects`.
  deleteProjectCascade(req.params.id);
  res.status(204).send();
});

/**
 * Add features to a project's list — one, or many at once (a pasted list). Each lands at the end,
 * in the order given, with nothing started: a feature is scoped when you pick it up.
 *
 * Body: { features: [{ name, description? }] } or { names: ["…", "…"] }.
 */
router.post('/:id/features', (req, res) => {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const body = (req.body ?? {}) as { features?: unknown; names?: unknown };
  const items: { name: string; description: string }[] = [];
  if (Array.isArray(body.features)) {
    for (const f of body.features) {
      if (!f || typeof f !== 'object') continue;
      const name = String((f as Record<string, unknown>).name ?? '').trim();
      if (name) items.push({ name, description: String((f as Record<string, unknown>).description ?? '').trim() });
    }
  } else if (Array.isArray(body.names)) {
    for (const n of body.names) {
      const name = String(n ?? '').trim();
      if (name) items.push({ name, description: '' });
    }
  }
  if (items.length === 0) return res.status(400).json({ error: 'name at least one feature' });
  if (items.length > 100) return res.status(400).json({ error: 'at most 100 features at a time' });
  const tx = db.transaction(() => items.map((f) => createFeature({ projectId: req.params.id, name: f.name, description: f.description })));
  const ids = tx();
  docsChanged(req.params.id);
  res.status(201).json({ ids });
});

/** The order the features are to be built in. Body: { ids: [...] } — every id must be this project's. */
router.put('/:id/features/order', (req, res) => {
  const ids = Array.isArray((req.body ?? {}).ids) ? ((req.body as { ids: unknown[] }).ids).map(String) : null;
  if (!ids) return res.status(400).json({ error: 'ids required' });
  const mine = new Set((db.prepare('SELECT id FROM goals WHERE project_id = ? ORDER BY position, created_at').all(req.params.id) as { id: string }[]).map((r) => r.id));
  const foreign = ids.filter((id) => !mine.has(id));
  if (foreign.length) return res.status(400).json({ error: `not features of this project: ${foreign.join(', ')}` });
  const upd = db.prepare('UPDATE goals SET position = ? WHERE id = ?');
  const tx = db.transaction(() => {
    ids.forEach((id, i) => upd.run(i, id));
    // Anything not named keeps its relative order, after the ones that were.
    const rest = [...mine].filter((id) => !ids.includes(id));
    rest.forEach((id, i) => upd.run(ids.length + i, id));
  });
  tx();
  docsChanged(req.params.id);
  res.json({ ok: true });
});

router.get('/:id/learnings', (req, res) => {
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Project not found' });

  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
  const learnings = db.prepare(
    `SELECT id, project_id, workflow_id, workflow_name, content, tags, created_at
     FROM project_learnings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(req.params.id, limit) as Record<string, unknown>[];

  res.json(learnings.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    content: r.content,
    tags: JSON.parse((r.tags as string) || '[]'),
    createdAt: r.created_at,
  })));
});

// ── the project as the single place: spec, roadmap, changelog, architecture, docs ───────────
//
// See docs/PROJECT-SPEC.md. Everything below is derived from the records or written by a person;
// the documents are the same ones published into the repo (lib/project-docs.ts).

/** The living spec: every feature's intent beside the evidence for each of its acceptance criteria. */
router.get('/:id/spec', (req, res) => {
  const spec = buildProjectSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: 'Project not found' });
  res.json(spec);
});

/**
 * One document, rendered: spec | roadmap | changelog | architecture, as Markdown (the default) or —
 * for the roadmap — a self-contained HTML page. `?download=1` names the file for saving.
 */
router.get('/:id/docs/:doc', (req, res) => {
  const spec = buildProjectSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: 'Project not found' });
  const doc = req.params.doc;
  const html = req.query.format === 'html';
  let body: string;
  let file: string;
  if (doc === 'spec') { body = renderSpecMarkdown(spec); file = 'SPEC.md'; }
  else if (doc === 'roadmap') { body = html ? renderRoadmapHtml(spec) : renderRoadmapMarkdown(spec); file = html ? 'ROADMAP.html' : 'ROADMAP.md'; }
  else if (doc === 'changelog') { body = renderChangelogMarkdown(spec.project.name, changelogFor(req.params.id)); file = 'CHANGELOG.md'; }
  else if (doc === 'architecture' && html) {
    body = architecturePage(req.params.id);
    if (!body) return res.status(404).json({ error: 'no architecture page yet — generate it in the Architecture tab' });
    file = 'ARCHITECTURE.html';
    // Written by a cartridge and served from this origin: no scripts, nothing loaded from elsewhere.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  }
  else if (doc === 'architecture') { body = renderArchitectureMarkdown(spec, { placeholder: true }); file = 'ARCHITECTURE.md'; }
  else return res.status(404).json({ error: `unknown document "${doc}" — spec, roadmap, changelog or architecture` });
  const slug = spec.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  res.type(html && (doc === 'roadmap' || doc === 'architecture') ? 'html' : 'text/markdown; charset=utf-8');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${slug}-${file}"`);
  res.send(body);
});

/**
 * The architecture page, for the Architecture tab: JSON, so it travels through the authenticated
 * client (an iframe pointed at a URL could not send the fleet token). The tab renders it sandboxed.
 */
router.get('/:id/architecture', (req, res) => {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  res.json({ html: architecturePage(req.params.id) });
});

/** Write docs/product/ into the project's main repo now. */
router.post('/:id/docs/publish', asyncRoute(async (req, res) => {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json(await publishProjectDocs(req.params.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE projects SET docs_publish_error = ? WHERE id = ?').run(msg.slice(0, 500), req.params.id);
    res.status(409).json({ error: msg, dir: DOCS_DIR });
  }
}));

// ── the changelog ──────────────────────────────────────────────────────────────

router.get('/:id/changelog', (req, res) => {
  res.json({ kinds: CHANGE_KINDS, entries: changelogFor(req.params.id) });
});

router.post('/:id/changelog', (req, res) => {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  try {
    const e = addEntry(req.params.id, req.body ?? {});
    docsChanged(req.params.id);
    res.status(201).json(e);
  } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

router.put('/:id/changelog/:entryId', (req, res) => {
  const e = getEntry(req.params.entryId);
  if (!e || e.projectId !== req.params.id) return res.status(404).json({ error: 'entry not found' });
  const updated = updateEntry(e.id, req.body ?? {});
  docsChanged(req.params.id);
  res.json(updated);
});

router.delete('/:id/changelog/:entryId', (req, res) => {
  const e = getEntry(req.params.entryId);
  if (!e || e.projectId !== req.params.id) return res.status(404).json({ error: 'entry not found' });
  deleteEntry(e.id);
  docsChanged(req.params.id);
  res.status(204).send();
});

/** Cut a release: every unreleased entry ships in `version`. */
router.post('/:id/changelog/release', (req, res) => {
  try {
    const shipped = cutRelease(req.params.id, String((req.body ?? {}).version ?? ''));
    if (shipped === 0) return res.status(409).json({ error: 'there is nothing unreleased to ship' });
    docsChanged(req.params.id);
    res.json({ shipped, entries: changelogFor(req.params.id) });
  } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

// ── ✦ Generate with AI: documents for a codebase new to NeonCore (lib/project-import.ts) ──

router.get('/:id/imports', (req, res) => {
  res.json(importsFor(req.params.id));
});

/**
 * Generate with AI: ask a cartridge to read the project's repos and propose any of `parts` —
 * architecture, features (with their spec), changelog (from git history), backlog. All four when absent.
 */
router.post('/:id/imports', (req, res) => {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const agentId = String((req.body ?? {}).agentId ?? '').trim();
  if (!agentId) return res.status(400).json({ error: 'pick the cartridge that reads the codebase' });
  if (!cartridgeExists(agentId)) return res.status(400).json({ error: 'that cartridge no longer exists' });
  const imp = createImportRow(req.params.id, agentId, normalizeParts((req.body ?? {}).parts));
  const prompt = buildImportPrompt(imp);
  // Through the busy guard like every other dispatch: a busy cartridge gets it after its current work.
  const guard = guardBusy({ kind: 'prompt', targets: [agentId], payload: { agentId, text: prompt, includeMemory: false } });
  if ('error' in guard) { failImport(imp.id, guard.error); return res.status(409).json({ error: guard.error }); }
  setImportPrompt(imp.id, prompt, !guard.queued);
  if (guard.queued) return res.status(202).json({ import: getImport(imp.id), queued: true });
  const cmd = sendCommandToAgent(agentId, prompt, false, undefined, { standard: false });
  if (noChannel(cmd)) {
    failImport(imp.id, 'the cartridge did not receive the request — is it connected?');
    return res.status(502).json({ error: 'the cartridge did not receive the request', import: getImport(imp.id) });
  }
  if (inboxPending(cmd)) {
    void whenInboxSettles(cmd!.id)?.then((out) => { if (!out.ok) failImport(imp.id, `the cartridge's inbox refused the request (${out.detail})`); });
  }
  res.status(202).json({ import: getImport(imp.id), queued: false });
});

export default router;
