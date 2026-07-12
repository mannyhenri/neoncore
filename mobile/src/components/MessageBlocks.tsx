import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../theme';
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
            return (
              <Text key={i} style={styles.text} selectable={expanded}>
                {(b as { text?: string }).text || ''}
              </Text>
            );
          case 'thinking':
            return (
              <Text key={i} style={styles.thinking} selectable={expanded}>
                {((b as { thinking?: string; text?: string }).thinking ||
                  (b as { text?: string }).text ||
                  '')}
              </Text>
            );
          case 'tool_use':
            return (
              <View key={i} style={styles.tool}>
                <Text style={styles.toolLabel}>⚙ {(b as { name?: string }).name || 'tool'}</Text>
                <Text style={styles.toolBody} numberOfLines={clamp} selectable={expanded}>
                  {safeJson((b as { input?: unknown }).input)}
                </Text>
              </View>
            );
          case 'tool_result':
            return (
              <View key={i} style={[styles.tool, (b as { is_error?: boolean }).is_error && styles.toolError]}>
                <Text style={styles.toolLabel}>↳ result</Text>
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
        <Text style={styles.expandHint}>{expanded ? 'tap to collapse' : 'tap to see full message'}</Text>
      )}
    </View>
  );
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
  text: { color: theme.text, fontSize: 14, lineHeight: 20 },
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
  toolLabel: { color: theme.blue, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  toolBody: { color: theme.textDim, fontSize: 12, fontFamily: 'monospace' },
  expandHint: { color: theme.textFaint, fontSize: 11, marginTop: 8, fontStyle: 'italic' },
});
