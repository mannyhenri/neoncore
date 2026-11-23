/**
 * THE TEXT OF AN UPLOADED DOCUMENT — what "Plan from a document" hands a cartridge.
 *
 * A planning document arrives as whatever the person wrote it in: Markdown or plain text, Word
 * (.docx), a PDF, sometimes RTF / ODT / an old .doc or an HTML export. The cartridge that turns it
 * into epics and features may be on another machine, so it gets the TEXT (served by the import's
 * /document route), not a file path. Extraction happens once, here, when the document is uploaded:
 *
 *   .md .markdown .txt .csv .json   as written (UTF-8)
 *   .html .htm                      tags stripped, block ends kept as line breaks
 *   .docx                           word/document.xml read straight from the zip (`unzip`); headings
 *                                   become Markdown headings, list items "- ", tables " | " rows,
 *                                   so the document's structure (epic → feature) survives
 *   .pdf                            `pdftotext -layout`
 *   .rtf .odt .doc                  `textutil` (macOS)
 *
 * A format that needs a tool this machine does not have is refused with the tool's name, never
 * passed on as binary noise.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 400_000;
export const DOCUMENT_TYPES = ['.md', '.markdown', '.txt', '.csv', '.json', '.html', '.htm', '.docx', '.pdf', '.rtf', '.odt', '.doc'] as const;

export class DocumentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const extOf = (name: string) => (name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Collapse runs of blank lines and trailing spaces; keep the line structure. */
function tidy(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function htmlToText(html: string): string {
  return tidy(decodeEntities(html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|ul|ol)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')));
}

/**
 * word/document.xml → Markdown-ish text. Each <w:p> is a line; its style names a heading level
 * ("Heading1", "Title") or a list item (numbering properties); table cells are joined with " | ".
 */
export function docxXmlToText(xml: string): string {
  const body = xml.replace(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, (_m, tbl: string) =>
    tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (tr) => {
      const cells = [...tr.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => runsOf(c[0]).replace(/\n+/g, ' ').trim());
      return `<w:p><w:r><w:t>${cells.join(' | ').replace(/[<&]/g, (ch) => (ch === '<' ? '&lt;' : '&amp;'))}</w:t></w:r></w:p>`;
    }));
  const lines: string[] = [];
  for (const m of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const p = m[1] ?? '';
    const text = runsOf(p).trim();
    if (!text) { lines.push(''); continue; }
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? '';
    const heading = /^Title$/i.test(style) ? 1 : Number(style.match(/^Heading(\d)$/i)?.[1] ?? 0);
    if (heading) lines.push(`${'#'.repeat(Math.min(heading, 6))} ${text}`);
    else if (/<w:numPr>/.test(p) || /^List/i.test(style)) lines.push(`- ${text}`);
    else lines.push(text);
  }
  return tidy(lines.join('\n'));
}

/** The visible text of some WordprocessingML: its <w:t> runs, tabs and line breaks, in order. */
function runsOf(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
    out += m[1] !== undefined ? m[1] : m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return decodeEntities(out);
}

function withTempFile<T>(name: string, data: Buffer, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'neoncore-doc-'));
  const path = join(dir, `upload${extOf(name)}`);
  try {
    writeFileSync(path, data);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(tool: string, args: string[], what: string): string {
  try {
    return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new DocumentError(`reading a ${what} needs \`${tool}\`, which this machine does not have — save the document as .docx, .md or .txt instead`, 415);
    throw new DocumentError(`the ${what} could not be read (${String(e.stderr || e.message).trim().split('\n')[0]})`, 422);
  }
}

/** The document's text, ready for a cartridge to read. Throws DocumentError on an unusable upload. */
export function documentText(name: string, data: Buffer): { text: string; truncated: boolean } {
  if (data.length === 0) throw new DocumentError('the document is empty');
  if (data.length > MAX_DOCUMENT_BYTES) throw new DocumentError(`the document is ${Math.round(data.length / 1024 / 1024)} MB — the limit is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`, 413);
  const ext = extOf(name);
  let text: string;
  switch (ext) {
    case '.md': case '.markdown': case '.txt': case '.csv': case '.json':
      text = tidy(data.toString('utf8').replace(/^﻿/, ''));
      break;
    case '.html': case '.htm':
      text = htmlToText(data.toString('utf8'));
      break;
    case '.docx':
      text = withTempFile(name, data, (p) => docxXmlToText(run('unzip', ['-p', p, 'word/document.xml'], 'Word document')));
      break;
    case '.pdf':
      text = withTempFile(name, data, (p) => tidy(run('pdftotext', ['-layout', '-enc', 'UTF-8', p, '-'], 'PDF')));
      break;
    case '.rtf': case '.odt': case '.doc':
      text = withTempFile(name, data, (p) => tidy(run('textutil', ['-convert', 'txt', '-stdout', p], `${ext.slice(1).toUpperCase()} document`)));
      break;
    default:
      throw new DocumentError(`"${name}" is not a document NeonCore can read — use ${DOCUMENT_TYPES.join(' ')}`, 415);
  }
  if (!text) throw new DocumentError('no text could be read from the document — if it is a scan, export it with its text first', 422);
  const truncated = text.length > MAX_DOCUMENT_CHARS;
  return { text: truncated ? text.slice(0, MAX_DOCUMENT_CHARS) : text, truncated };
}
