/**
 * THE MORNING PAPER. One fixed template, so it looks the same every day.
 *
 * The digest used to be written by an agent from a prose description of five sections. Prose
 * cannot pin a layout: two runs of the same workflow produced two different papers, with the
 * type, the spacing and the order all drifting. A masthead you have to re-recognise every
 * morning is not a masthead.
 *
 * So the agent's job is now DATA and the layout is code. Same principle the workflow report
 * already follows — write the data first, render the document from it — and the same reason:
 * two hand-written documents drift, one rendered from the other cannot.
 *
 * ── WHY THIS IS NOT A COMPLETION REPORT ──────────────────────────────────────────────
 * Every template got a Workflow Completion Report step, this one included, so a digest run
 * produced the digest AND a generic report about having produced the digest. For a workflow
 * whose entire output IS a document, that is one document too many. The digest is the report;
 * see REPORT_EXEMPT_TEMPLATES below.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The exemption registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Templates whose OWN output is the deliverable, so a generic completion report on top of it
 * is a second document nobody asked for.
 *
 * This is a registry rather than a one-off DELETE because `addReportSteps` runs on every boot
 * and would put the step back by morning. Kept deliberately short: the completion report is
 * right for a workflow that CHANGES something and has to account for it. It is wrong only
 * where the run's product is already a document the reader opens.
 */
export const REPORT_EXEMPT_TEMPLATES: readonly string[] = [
  'Daily AI Research Digest',
];

// ─────────────────────────────────────────────────────────────────────────────
// The section registry — the paper's running order
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestSection {
  id: 'act-on-it' | 'worth-knowing' | 'ai-noise' | 'background' | 'dropped';
  heading: string;
  /** Shown in place of the items when the day had none. The section never disappears. */
  emptyNote: string;
}

/**
 * ORDER IS THE PAPER. Front page first, back page last, every day, whether or not a section
 * had anything in it — a section that vanishes on a quiet day moves everything below it and
 * the reader has to re-find the page.
 *
 * AI NOISE sits after WORTH KNOWING and before BACKGROUND on purpose: it is what people are
 * SAYING, which is softer evidence than what shipped but more interesting than a funding
 * round. It is ranked by score, never by the order the scan happened to collect it in.
 */
export const DIGEST_SECTIONS: readonly DigestSection[] = [
  { id: 'act-on-it',     heading: 'ACT ON IT',     emptyNote: 'Nothing today needs you to do anything.' },
  { id: 'worth-knowing', heading: 'WORTH KNOWING', emptyNote: 'Nothing new worth filing.' },
  { id: 'ai-noise',      heading: 'AI NOISE',      emptyNote: 'Reddit was quiet, or the scan found nothing worth repeating.' },
  { id: 'background',    heading: 'BACKGROUND',    emptyNote: 'No background items today.' },
  { id: 'dropped',       heading: 'WHAT WAS DROPPED', emptyNote: 'Nothing was dropped.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// The data the agent produces
// ─────────────────────────────────────────────────────────────────────────────

export interface ActItem { title: string; why: string; action: string; url: string }
export interface KnowItem { title: string; what: string; url: string }
export interface BackgroundItem { title: string; url: string }
export interface DroppedItem { title: string; why: string }

/** One Reddit thread. `score` is what ranks it — "by number of most popular" was the ask. */
export interface NoiseItem {
  subreddit: string;
  title: string;
  score: number;
  comments: number;
  url: string;
  /** One line on why it matters, so the section is not just a leaderboard. */
  takeaway: string;
}

export interface DigestData {
  date: string;
  throughLine: string;
  itemCount: number;
  actOnIt: ActItem[];
  worthKnowing: KnowItem[];
  aiNoise: NoiseItem[];
  background: BackgroundItem[];
  dropped: DroppedItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Everything from the agent is untrusted text. A headline is not markup. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered, so a `javascript:` href cannot ride in on a source URL. */
function safeHref(url: unknown): string | null {
  const s = String(url ?? '').trim();
  return /^https?:\/\//i.test(s) ? esc(s) : null;
}

function link(url: unknown, text: string): string {
  const href = safeHref(url);
  return href
    ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : text;
}

const num = (n: number) => Number(n || 0).toLocaleString('en-US');

function sectionShell(s: DigestSection, body: string, empty: boolean): string {
  return `<section class="sec" id="${s.id}">
  <h2>${esc(s.heading)}</h2>
  ${empty ? `<p class="quiet">${esc(s.emptyNote)}</p>` : body}
</section>`;
}

function renderSection(s: DigestSection, d: DigestData): string {
  switch (s.id) {
    case 'act-on-it': {
      const items = d.actOnIt || [];
      return sectionShell(s, `<ol class="lede">${items.map((i) => `<li>
    <h3>${link(i.url, esc(i.title))}</h3>
    <p class="do">${esc(i.action)}</p>
    <p class="why">${esc(i.why)}</p>
  </li>`).join('\n')}</ol>`, items.length === 0);
    }
    case 'worth-knowing': {
      const items = d.worthKnowing || [];
      return sectionShell(s, `<ul class="cols">${items.map((i) => `<li>
    <h4>${link(i.url, esc(i.title))}</h4>
    <p>${esc(i.what)}</p>
  </li>`).join('\n')}</ul>`, items.length === 0);
    }
    case 'ai-noise': {
      // Ranked HERE, not trusted from the input: "by number of most popular" is the ask, and
      // the scan collects in whatever order it happened to search.
      const items = [...(d.aiNoise || [])].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      return sectionShell(s, `<ol class="noise">${items.map((i, n) => `<li>
    <span class="rank">${n + 1}</span>
    <div>
      <h4>${link(i.url, esc(i.title))}</h4>
      <p class="meta"><b>${esc(i.subreddit)}</b> · ${num(i.score)} points · ${num(i.comments)} comments</p>
      <p>${esc(i.takeaway)}</p>
    </div>
  </li>`).join('\n')}</ol>`, items.length === 0);
    }
    case 'background': {
      const items = d.background || [];
      return sectionShell(s, `<ul class="brief">${items.map((i) =>
        `<li>${link(i.url, esc(i.title))}</li>`).join('\n')}</ul>`, items.length === 0);
    }
    case 'dropped': {
      const items = d.dropped || [];
      // Collapsed: the filtering stays auditable without taking space on the page.
      return `<section class="sec" id="dropped">
  <details><summary>${esc(s.heading)} (${items.length})</summary>
  ${items.length === 0 ? `<p class="quiet">${esc(s.emptyNote)}</p>`
    : `<ul class="brief">${items.map((i) =>
        `<li><b>${esc(i.title)}</b> — ${esc(i.why)}</li>`).join('\n')}</ul>`}
  </details>
</section>`;
    }
  }
}

/**
 * The paper. Deterministic: same data in, byte-identical HTML out — no timestamps, no random
 * ids, no "generated at" line, because those are exactly what make two mornings differ.
 */
export function renderDigestHtml(d: DigestData): string {
  const body = DIGEST_SECTIONS.map((s) => renderSection(s, d)).join('\n\n');
  const dateLabel = esc(d.date);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Daily — ${dateLabel}</title>
<style>
:root {
  --paper:#f7f4ed; --ink:#14120f; --dim:#5d574c; --rule:#cfc7b6; --accent:#8c2f1e;
  --tint:#efe9dc;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper:#15140f; --ink:#ece6d8; --dim:#9d968a; --rule:#332f26; --accent:#d9805f; --tint:#1e1c15;
  }
}
:root[data-theme="dark"] {
  --paper:#15140f; --ink:#ece6d8; --dim:#9d968a; --rule:#332f26; --accent:#d9805f; --tint:#1e1c15;
}
* { box-sizing:border-box; }
body {
  background:var(--paper); color:var(--ink); margin:0;
  font:16px/1.55 Georgia,"Iowan Old Style","Times New Roman",serif;
}
.wrap { max-width:860px; margin:0 auto; padding-block:28px; padding-left:16px; padding-right:16px; }
.masthead { text-align:center; border-bottom:3px double var(--rule); padding-bottom:12px; margin-bottom:6px; }
.masthead h1 {
  margin:0; font-size:clamp(34px,8vw,58px); letter-spacing:.06em; text-transform:uppercase;
  font-weight:700; line-height:1;
}
.dateline {
  display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;
  font:600 11px/1.4 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  text-transform:uppercase; letter-spacing:.12em; color:var(--dim);
  border-bottom:1px solid var(--rule); padding:8px 0 10px; margin-bottom:22px;
}
.through { font-size:19px; font-style:italic; margin:0 0 26px; text-wrap:balance; }
.sec { margin-bottom:30px; }
.sec h2 {
  font:700 12px/1 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  text-transform:uppercase; letter-spacing:.16em; color:var(--accent);
  border-bottom:1px solid var(--rule); padding-bottom:6px; margin:0 0 14px;
}
h3 { font-size:22px; margin:0 0 4px; line-height:1.2; text-wrap:balance; }
h4 { font-size:16px; margin:0 0 3px; line-height:1.3; }
p { margin:0 0 6px; }
a { color:inherit; text-decoration:underline; text-underline-offset:2px; text-decoration-color:var(--accent); }
ol.lede { list-style:none; padding:0; margin:0; display:grid; gap:18px; }
ol.lede > li { border-left:3px solid var(--accent); padding-left:14px; }
.do {
  font:700 11px/1.4 ui-sans-serif,-apple-system,sans-serif; text-transform:uppercase;
  letter-spacing:.1em; color:var(--accent);
}
.why { color:var(--dim); }
ul.cols { list-style:none; padding:0; margin:0; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
ul.cols > li { border-top:1px solid var(--rule); padding-top:8px; }
ul.cols p { color:var(--dim); font-size:15px; }
ol.noise { list-style:none; padding:0; margin:0; display:grid; gap:12px; counter-reset:n; }
ol.noise > li { display:flex; gap:12px; align-items:baseline; background:var(--tint); padding:10px 12px; border-radius:3px; }
.rank { font:700 20px/1 ui-sans-serif,sans-serif; color:var(--accent); min-width:1.4em; font-variant-numeric:tabular-nums; }
.meta { font:12px/1.4 ui-sans-serif,-apple-system,sans-serif; color:var(--dim); font-variant-numeric:tabular-nums; }
ol.noise p:last-child { font-size:15px; }
ul.brief { list-style:none; padding:0; margin:0; display:grid; gap:6px; font-size:15px; }
ul.brief > li { border-bottom:1px dotted var(--rule); padding-bottom:6px; }
.quiet { color:var(--dim); font-style:italic; }
details { border-top:1px solid var(--rule); padding-top:10px; }
summary {
  cursor:pointer; font:700 12px/1 ui-sans-serif,sans-serif; text-transform:uppercase;
  letter-spacing:.16em; color:var(--accent);
}
summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
details > *:not(summary) { margin-top:12px; }
.colophon { border-top:3px double var(--rule); margin-top:34px; padding-top:10px;
  font:11px/1.5 ui-sans-serif,sans-serif; color:var(--dim); text-transform:uppercase; letter-spacing:.1em; }
@media print { body { background:#fff; color:#000; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead"><h1>AI Daily</h1></header>
  <div class="dateline"><span>${dateLabel}</span><span>${num(d.itemCount)} items</span></div>
  <p class="through">${esc(d.throughLine)}</p>

${body}

  <p class="colophon">NeonCore · Daily AI Research Digest · rendered from digest.json</p>
</div>
</body>
</html>`;
}
