import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../theme';
import { ToolIcon, ResultIcon } from './Icons';
import { Markdown } from './Markdown';
import { parseBlocks, type TranscriptEvent } from '../types';

/** Lines of a tool body shown before it is clamped. Tap the message to see it all. */
const CLAMP_LINES = 6;

/**
 * Render one transcript event as its typed content blocks, styled by role/type.
 * When `expanded`, tool bodies drop their line clamp and text becomes selectable —
 * this is the "see the whole thing, like in the terminal" view.
 */
export function MessageBlocks({ ev, expanded = false }: { ev: TranscriptEvent; expanded?: boolean }) {
  const blocks = parseBlocks(ev.content);
  const roleColor =
    ev.role === 'assistant' ? theme.accentSoft : ev.role === 'user' ? theme.teal : theme.textDim;
  const clamp = expanded ? undefined : CLAMP_LINES;

  // Only advertise "tap to expand" when there is actually more to reveal.
  const clampable = blocks.some((b) => {
    if (b.type !== 'tool_use' && b.type !== 'tool_result') return false;
    const body =
      b.type === 'tool_use'
        ? safeJson((b as { input?: unknown }).input)
        : typeof (b as { content?: unknown }).content === 'string'
          ? ((b as { content?: string }).content as string)
          : safeJson((b as { content?: unknown }).content);
    return body.split('\n').length > CLAMP_LINES || body.length > 300;
  });

  return (
    <View style={styles.wrap}>
      <Text style={[styles.role, { color: roleColor }]}>
        {ev.role.toUpperCase()}
        {ev.model ? ` · ${ev.model}` : ''}
      </Text>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            // Agents write markdown. Rendering it raw meant you read the syntax
            // (**bold**, backticks, fences) instead of the formatting.
            return (
              <Markdown key={i} selectable={expanded}>
                {(b as { text?: string }).text || ''}
              </Markdown>
            );
          case 'thinking':
            return (
              <Markdown key={i} selectable={expanded} style={styles.thinking}>
                {((b as { thinking?: string; text?: string }).thinking ||
                  (b as { text?: string }).text ||
                  '')}
              </Markdown>
            );
          case 'tool_use':
            return (
              <View key={i} style={styles.tool}>
                <View style={styles.toolHead}>
                  <ToolIcon size={13} color={theme.blue} strokeWidth={2} />
                  <Text style={styles.toolLabel}>{(b as { name?: string }).name || 'tool'}</Text>
                </View>
                <Text style={styles.toolBody} numberOfLines={clamp} selectable={expanded}>
                  {safeJson((b as { input?: unknown }).input)}
                </Text>
              </View>
            );
          case 'tool_result':
            return (
              <View key={i} style={[styles.tool, (b as { is_error?: boolean }).is_error && styles.toolError]}>
                <View style={styles.toolHead}>
                  <ResultIcon
                    size={13}
                    color={(b as { is_error?: boolean }).is_error ? theme.danger : theme.blue}
                    strokeWidth={2}
                  />
                  <Text
                    style={[
                      styles.toolLabel,
                      (b as { is_error?: boolean }).is_error && { color: theme.danger },
                    ]}
                  >
                    result
                  </Text>
                </View>
                <Text style={styles.toolBody} numberOfLines={clamp} selectable={expanded}>
                  {typeof (b as { content?: unknown }).content === 'string'
                    ? ((b as { content?: string }).content as string)
                    : safeJson((b as { content?: unknown }).content)}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={i} style={styles.textDim}>
                [{b.type}]
              </Text>
            );
        }
      })}
      {clampable && (
        <Text style={styles.expandHint}>
          {expanded ? 'tap to collapse' : 'tap to see full message'} · hold to copy
        </Text>
      )}
    </View>
  );
}

/**
 * Flatten an event to the text a human would want on their clipboard.
 *
 * Prose wins when there is any: an assistant turn that says something *and* calls a
 * tool should copy the sentence, not the tool's JSON envelope. Only when a message is
 * nothing but tool traffic do the tool bodies become the payload — otherwise
 * long-pressing a bare tool_result would copy an empty string.
 */
export function messageToText(ev: TranscriptEvent): string {
  const blocks = parseBlocks(ev.content);

  const prose = blocks
    .filter((b) => b.type === 'text' || b.type === 'thinking')
    .map((b) =>
      (b as { thinking?: string; text?: string }).thinking ||
      (b as { text?: string }).text ||
      '',
    )
    .filter(Boolean);
  if (prose.length) return prose.join('\n\n');

  return blocks
    .map((b) => {
      if (b.type === 'tool_use') {
        const name = (b as { name?: string }).name || 'tool';
        return `${name}\n${safeJson((b as { input?: unknown }).input)}`;
      }
      if (b.type === 'tool_result') {
        const c = (b as { content?: unknown }).content;
        return typeof c === 'string' ? c : safeJson(c);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function safeJson(v: unknown): string {
  if (v == null) return '';
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginVertical: 6,
    padding: 12,
    backgroundColor: theme.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  role: { fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 6 },
  textDim: { color: theme.textDim, fontSize: 13, fontStyle: 'italic' },
  thinking: { color: theme.textDim, fontSize: 13, lineHeight: 19, fontStyle: 'italic' },
  tool: {
    marginTop: 6,
    padding: 8,
    backgroundColor: theme.bg,
    borderRadius: 8,
    borderLeftWidth: 2,
    borderLeftColor: theme.blue,
  },
  toolError: { borderLeftColor: theme.danger },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3 },
  toolLabel: { color: theme.blue, fontSize: 11, fontWeight: '600' },
  toolBody: { color: theme.textDim, fontSize: 12, fontFamily: 'monospace' },
  expandHint: { color: theme.textFaint, fontSize: 11, marginTop: 8, fontStyle: 'italic' },
});
