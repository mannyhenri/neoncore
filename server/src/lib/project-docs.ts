/**
 * THE PROJECT'S DOCS, IN ITS REPO — docs/product/ in the project's main repo.
 *
 *   docs/product/README.md          the spec: every feature, its status, how it measures up
 *   docs/product/features/<slug>.md one feature: intent, acceptance criteria + evidence, delivery
 *   docs/product/ROADMAP.md         Now / Next / Later / Done (and ROADMAP.html, to send or print)
 *   docs/product/CHANGELOG.md       what shipped, by release
 *   docs/product/ARCHITECTURE.md    how the product is built (when the project has it)
 *   docs/product/ARCHITECTURE.html  the same as a page with diagrams (when it was generated)
 *
 * The docs live WITH the code, so a pull request, a code review or an agent reading the repo sees
 * the same spec the dashboard shows — and every stage of a feature's pipeline is told where it is.
 * Everything is generated from the records (lib/project-spec.ts, lib/project-changelog.ts); the files
 * say so at the top, and are rewritten rather than merged.
 *
 * Written through lib/repo-access.ts — directly for a repo on this machine, through the machine's
 * runner for a repo elsewhere. Nothing is committed: the files show up as changes for a person (or a
 * workflow) to commit with the work. A file is written only when its content changed, so a publish
 * does not churn the working tree under an agent that is busy in the repo.
 *
 * Published when a person clicks Publish, or — with the project's "keep in sync" on — at the moments
 * the spec changes meaning: a plan accepted, a pipeline finished, a feature marked done, the list
 * edited, a generated proposal applied, the changelog edited. Not on every stage tick.
 */
import db from '../db.js';
import { repoAccessFor } from './repo-access.js';
import {
  buildProjectSpec, renderSpecMarkdown, renderFeatureMarkdown, renderRoadmapMarkdown, renderRoadmapHtml, renderArchitectureMarkdown, architecturePage, GENERATED_NOTE,
} from './project-spec.js';
import { changelogFor, renderChangelogMarkdown } from './project-changelog.js';

export const DOCS_DIR = 'docs/product';
const MANIFEST = `${DOCS_DIR}/.neoncore-manifest.json`;

export interface PublishResult {
  repo: string;
  dir: string;
  written: string[];
  unchanged: string[];
  retired: string[];
  at: string;
}

/** Every file the docs consist of right now, path → content. */
export function projectDocFiles(projectId: string): { repo: string; files: Map<string, string> } | null {
  const spec = buildProjectSpec(projectId);
  if (!spec) return null;
  const files = new Map<string, string>();
  files.set(`${DOCS_DIR}/README.md`, renderSpecMarkdown(spec, { featureLinks: true }));
  for (const f of spec.features) files.set(`${DOCS_DIR}/features/${f.slug}.md`, renderFeatureMarkdown(f, spec.project));
  files.set(`${DOCS_DIR}/ROADMAP.md`, renderRoadmapMarkdown(spec));
  files.set(`${DOCS_DIR}/ROADMAP.html`, renderRoadmapHtml(spec));
  files.set(`${DOCS_DIR}/CHANGELOG.md`, renderChangelogMarkdown(spec.project.name, changelogFor(projectId)));
  const architecture = renderArchitectureMarkdown(spec);
  if (architecture) files.set(`${DOCS_DIR}/ARCHITECTURE.md`, architecture);
  const page = architecturePage(projectId);
  if (page) files.set(`${DOCS_DIR}/ARCHITECTURE.html`, page);
  return { repo: spec.project.mainRepo, files };
}

/** The "Last generated <date>" line changes daily; it alone is not a change worth writing. */
const comparable = (s: string) => s.replace(/(Last generated|As of) \d{4}-\d\d-\d\d/g, '$1');

export async function publishProjectDocs(projectId: string): Promise<PublishResult> {
  const docs = projectDocFiles(projectId);
  if (!docs) throw new Error('project not found');
  if (!docs.repo) throw new Error('the project has no repo yet — add one to publish its docs into it');
  const a = repoAccessFor(docs.repo);
  const paths = [...docs.files.keys()];
  const current = await a.readFiles([...paths, MANIFEST]);
  const existing = new Map(current.filter((f) => f.exists).map((f) => [f.path, f.content]));

  // Files a previous publish wrote that are no longer part of the docs (a feature removed or renamed):
  // replaced by a one-line stub, so a link to it explains itself instead of showing stale content.
  let previous: string[] = [];
  try { previous = (JSON.parse(existing.get(MANIFEST) ?? '{}') as { files?: string[] }).files ?? []; } catch { /* none */ }
  const retired = previous.filter((p) => !docs.files.has(p) && p.startsWith(`${DOCS_DIR}/features/`));
  const retiredNow: string[] = [];
  for (const p of retired) {
    const stub = `# Removed\n\n> ${GENERATED_NOTE}\n\nThis feature was renamed or removed from the project's list. See [the spec](../README.md).\n`;
    const prior = (await a.readFiles([p]))[0];
    if (prior?.exists && prior.content !== stub) { await a.writeFile(p, stub); retiredNow.push(p); }
  }

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [p, content] of docs.files) {
    const prior = existing.get(p);
    if (prior !== undefined && comparable(prior) === comparable(content)) { unchanged.push(p); continue; }
    await a.writeFile(p, content);
    written.push(p);
  }
  const manifest = `${JSON.stringify({ generatedBy: 'NeonCore', project: projectId, files: paths.sort() }, null, 2)}\n`;
  if (existing.get(MANIFEST) !== manifest) await a.writeFile(MANIFEST, manifest);

  const at = new Date().toISOString();
  db.prepare("UPDATE projects SET docs_published_at = ?, docs_publish_error = '' WHERE id = ?").run(at, projectId);
  return { repo: docs.repo, dir: DOCS_DIR, written, unchanged, retired: retiredNow, at };
}

// ── keep in sync ──────────────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Changes arrive in bursts (accepting a plan writes several rows); one publish per burst. */
export const AUTO_PUBLISH_DELAY_MS = 4000;

/** Publish soon, if the project keeps its docs in sync. Safe to call from anywhere, as often as needed. */
export function docsChanged(projectId: string | null | undefined): void {
  if (!projectId) return;
  const p = db.prepare('SELECT docs_auto_publish FROM projects WHERE id = ?').get(projectId) as { docs_auto_publish?: number } | undefined;
  if (!p?.docs_auto_publish) return;
  const prev = timers.get(projectId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(projectId);
    publishProjectDocs(projectId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare('UPDATE projects SET docs_publish_error = ? WHERE id = ?').run(msg.slice(0, 500), projectId);
      console.warn(`[project-docs] ${projectId.slice(0, 8)}: publish failed: ${msg}`);
    });
  }, AUTO_PUBLISH_DELAY_MS);
  t.unref?.();
  timers.set(projectId, t);
}

/** The project a feature belongs to — for callers that only hold a goal id. */
export function docsChangedForGoal(goalId: string): void {
  const g = db.prepare('SELECT project_id FROM goals WHERE id = ?').get(goalId) as { project_id?: string } | undefined;
  docsChanged(g?.project_id);
}
