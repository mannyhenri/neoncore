/**
 * Atlassian Document Format (ADF), the rich-text format of Jira Cloud's REST API v3: what
 * descriptions and comment bodies are. Only what the simulator and the seed need: plain text in,
 * plain text out, mentions kept.
 */

/** Plain text (paragraphs split on blank lines, lines on \n) → an ADF doc. */
export function textToAdf(text) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
    })),
  };
}

/** An ADF doc (or node) → plain text. Mentions become "@Name", hard breaks newlines. */
export function adfToText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.text ?? '');
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return String(node.attrs?.text ?? `@${node.attrs?.id ?? ''}`);
  const inner = (node.content ?? []).map(adfToText).join('');
  if (node.type === 'doc') return (node.content ?? []).map(adfToText).join('\n\n');
  return inner;
}

/** Is `body` a well-formed ADF document (what Jira requires of a comment body)? */
export function isAdfDoc(body) {
  return !!body && typeof body === 'object' && body.type === 'doc' && body.version === 1 && Array.isArray(body.content);
}
