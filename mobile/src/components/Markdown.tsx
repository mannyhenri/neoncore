import React from 'react';
import { View, Text, StyleSheet, type TextStyle } from 'react-native';
import { theme } from '../theme';

/**
 * A small markdown renderer for agent transcripts.
 *
 * Deliberately NOT react-native-markdown-display: that library still sets
 * `defaultProps` on function components, which React 19 removed — and we're on React 19
 * now. It would also need heavy restyling to match the terminal palette. This covers the
 * subset that actually shows up in transcripts (fenced code, inline code, bold, italic,
 * headings, lists, blockquotes, rules, links) in ~1/10th the surface area, with zero deps,
 * which also keeps the app OTA-updatable — a native dep would force a new binary.
 *
 * Unsupported syntax degrades to plain text rather than throwing.
 */

type Props = { children: string; selectable?: boolean; style?: TextStyle };

// ── inline: `code`, **bold**, *italic*/_italic_, ~~strike~~, [text](url) ────────────
// One pass, longest-delimiter-first so ** wins over *. Code spans win outright: their
// contents are literal, so `**x**` inside backticks must NOT come out bold.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let i = 0;

  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));

    const tok = m[0];
    const key = `${keyBase}-i${i++}`;

    if (tok.startsWith('`')) {
      out.push(
        <Text key={key} style={styles.codeInline}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('**')) {
      out.push(
        <Text key={key} style={styles.bold}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('~~')) {
      out.push(
        <Text key={key} style={styles.strike}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      out.push(
        <Text key={key} style={styles.link}>
          {label}
        </Text>,
      );
    } else {
      // *italic* or _italic_
      out.push(
        <Text key={key} style={styles.italic}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function Markdown({ children, selectable = false, style }: Props) {
  const src = children ?? '';
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── fenced code block ────────────────────────────────────────────────────
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (absent if the model got cut off — fine)
      out.push(
        <View key={`k${key++}`} style={styles.codeBlock}>
          {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
          <Text style={styles.codeText} selectable={selectable}>
            {body.join('\n')}
          </Text>
        </View>,
      );
      continue;
    }

    // ── heading ──────────────────────────────────────────────────────────────
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(
        <Text
          key={`k${key++}`}
          selectable={selectable}
          style={[styles.heading, level === 1 && styles.h1, level === 2 && styles.h2]}
        >
          {renderInline(h[2], `k${key}`)}
        </Text>,
      );
      i++;
      continue;
    }

    // ── horizontal rule ──────────────────────────────────────────────────────
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(<View key={`k${key++}`} style={styles.rule} />);
      i++;
      continue;
    }

    // ── blockquote ───────────────────────────────────────────────────────────
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(
        <View key={`k${key++}`} style={styles.quote}>
          <Text style={[styles.text, styles.quoteText, style]} selectable={selectable}>
            {renderInline(q[1], `k${key}`)}
          </Text>
        </View>,
      );
      i++;
      continue;
    }

    // ── list item (bullet or ordered) ────────────────────────────────────────
    const li = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      const indent = Math.min(Math.floor(li[1].length / 2), 3);
      const marker = li[2] ? '•' : `${li[3]}.`;
      out.push(
        <View key={`k${key++}`} style={[styles.li, { paddingLeft: 4 + indent * 14 }]}>
          <Text style={styles.liMarker}>{marker}</Text>
          <Text style={[styles.text, styles.liText, style]} selectable={selectable}>
            {renderInline(li[4], `k${key}`)}
          </Text>
        </View>,
      );
      i++;
      continue;
    }

    // ── blank line → paragraph break ─────────────────────────────────────────
    if (line.trim() === '') {
      out.push(<View key={`k${key++}`} style={styles.gap} />);
      i++;
      continue;
    }

    // ── paragraph: greedily consume until a blank line or a block starts ──────
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^(\s*)(?:[-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <Text key={`k${key++}`} style={[styles.text, style]} selectable={selectable}>
        {renderInline(para.join('\n'), `k${key}`)}
      </Text>,
    );
  }

  return <View>{out}</View>;
}

const mono = 'Menlo';

const styles = StyleSheet.create({
  text: { color: theme.text, fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '700', color: theme.text },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: theme.textDim },
  link: { color: theme.blue, textDecorationLine: 'underline' },

  codeInline: {
    fontFamily: mono,
    fontSize: 13,
    color: theme.teal,
    backgroundColor: theme.bg,
  },
  codeBlock: {
    marginVertical: 6,
    padding: 8,
    backgroundColor: theme.bg,
    borderRadius: 8,
    borderLeftWidth: 2,
    borderLeftColor: theme.accent,
  },
  codeLang: {
    color: theme.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  codeText: { fontFamily: mono, fontSize: 12, lineHeight: 17, color: theme.textDim },

  heading: { color: theme.text, fontSize: 15, fontWeight: '700', marginTop: 8, marginBottom: 2 },
  h1: { fontSize: 18 },
  h2: { fontSize: 16 },

  rule: { height: 1, backgroundColor: theme.border, marginVertical: 8 },

  quote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.border,
    paddingLeft: 8,
    marginVertical: 4,
  },
  quoteText: { color: theme.textDim, fontStyle: 'italic' },

  li: { flexDirection: 'row', gap: 6, marginVertical: 1 },
  liMarker: { color: theme.accentSoft, fontSize: 14, lineHeight: 20 },
  liText: { flex: 1 },

  gap: { height: 6 },
});
