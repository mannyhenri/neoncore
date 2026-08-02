/**
 * Project memory on a phone — the same four knowledge files and the same note CRUD the web
 * panel offers.
 *
 * Why it exists: project memory is what the next agent reads before it starts. Being able to
 * correct a wrong line only from a desk means the wrong line stays there until someone gets
 * back to one, and every dispatch in between inherits it. Capture and correction are exactly
 * the operations that want to be available away from the desk.
 *
 * Session history and journal search are deliberately absent — browsing is desk work. That
 * decision is recorded in NOT_ON_MOBILE in server/test/mobile-memory-parity.test.ts so it
 * reads as a choice rather than an omission, and so the parity test fails if the web gains an
 * editing operation this screen does not.
 *
 * Styled with the shared primitives. This was the only screen in the app with no StyleSheet at
 * all — every rule inline, every colour retyped — which is precisely why it drifted furthest
 * from the rest: nothing in it was reusable, so nothing in it was reused.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet,
  ScrollView, Text, TextInput, View,
} from 'react-native';
import { theme } from '../theme';
import { api, type ProjectNote } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import { Card, Chip, ActionButton, PrimaryButton, Adaptive } from '../components/ui';

/** Mirrors KNOWLEDGE_FILES in dashboard/src/components/ProjectMemoryPanel.tsx. The parity
 *  test asserts this list matches the web's, so a file added there fails here until added. */
const KNOWLEDGE_FILES = ['progress.md', 'decisions.md', 'gotchas.md', 'details.md'] as const;
type Tab = 'notes' | (typeof KNOWLEDGE_FILES)[number];

export function ProjectMemoryScreen({ project: projectProp }: { project?: string }) {
  const { baseUrl, agents } = useNeonCore();
  // Project memory is keyed by REPO — which is exactly what a project owns now. So the choice
  // is "which cartridge", not "which project", and it is explicit rather than guessed: silently
  // defaulting to the first live agent meant editing one repo's memory while believing you were
  // editing another's.
  const repos = [...new Set(agents.map((a) => a.repoName).filter(Boolean))].sort();
  const [picked, setPicked] = useState('');
  const project = projectProp || picked || repos[0] || '';
  const [tab, setTab] = useState<Tab>('notes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [notes, setNotes] = useState<ProjectNote[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const [fileText, setFileText] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (!baseUrl || !project) return;
    setBusy(true);
    try {
      if (tab === 'notes') {
        setNotes(await api.getProjectNotes(baseUrl, project));
      } else {
        // A file that has never been written 404s; an empty editor is the correct rendering
        // of "nothing here yet", not an error to shout about.
        const doc = await api.getKnowledgeFile(baseUrl, project, tab).catch(() => null);
        setFileText(doc?.content ?? '');
        setDirty(false);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load project memory');
    } finally {
      setBusy(false);
    }
  }, [baseUrl, project, tab]);

  useEffect(() => { void load(); }, [load]);

  /** Every mutation reloads, so what you see is the server's state and not the optimistic
   *  guess this screen made — the phone is the least trustworthy copy in the system. */
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'request failed'); }
    finally { setBusy(false); }
  }

  const saveNote = () => run(async () => {
    const text = draft.trim();
    if (!text) return;
    if (editingId) await api.updateProjectNote(baseUrl, project, editingId, text);
    else await api.createProjectNote(baseUrl, project, text);
    setDraft('');
    setEditingId(null);
  });

  if (!project) {
    return <View style={s.pad}><Text style={s.dim}>Pick a cartridge to see its project memory.</Text></View>;
  }

  return (
    // A text editor is always ONE column — two columns of prose to edit would be worse,
    // not better. It just stops stretching.
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Adaptive style={s.flex}>
      {repos.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.repoBar} contentContainerStyle={s.repoChips}>
          {repos.map((r) => (
            <Chip key={r} label={r} on={project === r} onPress={() => setPicked(r)} />
          ))}
        </ScrollView>
      )}

      <View style={[s.chipRow, s.tabRow]}>
        {(['notes', ...KNOWLEDGE_FILES] as Tab[]).map((t) => (
          <Chip key={t} label={t.replace('.md', '')} on={tab === t} onPress={() => setTab(t)} />
        ))}
      </View>

      {error !== '' ? <Text style={s.err}>{error}</Text> : null}
      {busy && <ActivityIndicator style={s.spinner} color={theme.accent} />}

      {tab === 'notes' ? (
        <ScrollView style={s.flex} contentContainerStyle={s.scrollPad}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={editingId ? 'edit note…' : 'new note…'}
            placeholderTextColor={theme.textFaint}
            multiline
            style={[s.input, s.noteInput]}
          />
          <View style={s.actions}>
            <PrimaryButton
              label={editingId ? 'Save note' : 'Add note'}
              onPress={() => void saveNote()}
              disabled={busy || draft.trim() === ''}
            />
            {editingId && (
              <ActionButton label="Cancel" onPress={() => { setEditingId(null); setDraft(''); }} />
            )}
          </View>

          {notes.length === 0 && !busy && <Text style={s.emptyNotes}>No notes yet</Text>}

          {notes.map((n) => (
            <Card key={n.id} style={s.noteCard}>
              <Text style={s.noteText}>{n.content}</Text>
              <View style={s.actions}>
                <ActionButton
                  label="Edit"
                  tone="accent"
                  onPress={() => { setEditingId(n.id); setDraft(n.content); }}
                />
                <ActionButton
                  label="Delete"
                  tone="danger"
                  onPress={() => void run(() => api.deleteProjectNote(baseUrl, project, n.id))}
                />
              </View>
            </Card>
          ))}
        </ScrollView>
      ) : (
        <View style={[s.flex, s.filePane]}>
          <TextInput
            value={fileText}
            onChangeText={(t) => { setFileText(t); setDirty(true); }}
            multiline
            placeholder={`${tab} is empty — write the first line`}
            placeholderTextColor={theme.textFaint}
            style={[s.input, s.fileInput]}
          />
          <View style={s.saveRow}>
            <PrimaryButton
              label={dirty ? `Save ${tab}` : 'Saved'}
              disabled={busy || !dirty}
              onPress={() => void run(async () => {
                await api.updateKnowledgeFile(baseUrl, project, tab, fileText);
                setDirty(false);
              })}
            />
          </View>
        </View>
      )}
      </Adaptive>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: 16 },
  dim: { color: theme.textDim, fontSize: 13 },
  repoBar: { maxHeight: 40, flexGrow: 0 },
  // A HORIZONTAL scroller must not wrap — flexWrap on its content container fights the scroll
  // axis and collapses the row. The tab row below it does wrap, which is why they differ.
  repoChips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12 },
  tabRow: { paddingVertical: 10 },
  err: { color: theme.danger, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 },
  spinner: { marginVertical: 6 },
  scrollPad: { paddingHorizontal: 12, paddingBottom: 24 },
  input: {
    color: theme.text,
    backgroundColor: theme.bgCard,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 13,
    textAlignVertical: 'top',
  },
  noteInput: { minHeight: 70 },
  fileInput: { flex: 1, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  emptyNotes: { color: theme.textFaint, fontStyle: 'italic', marginTop: 20, textAlign: 'center' },
  // Cards inside a padded ScrollView must not re-apply the primitive's own horizontal margin.
  noteCard: { marginHorizontal: 0, marginTop: 10, marginVertical: 0 },
  noteText: { color: theme.text, fontSize: 13, lineHeight: 19 },
  filePane: { paddingHorizontal: 12, paddingBottom: 12 },
  saveRow: { marginTop: 10 },
});
