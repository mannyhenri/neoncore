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
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, Text, TextInput, View,
} from 'react-native';
import { theme } from '../theme';
import { api, type ProjectNote } from '../api';
import { useNeonCore } from '../NeonCoreProvider';

/** Mirrors KNOWLEDGE_FILES in dashboard/src/components/ProjectMemoryPanel.tsx. The parity
 *  test asserts this list matches the web's, so a file added there fails here until added. */
const KNOWLEDGE_FILES = ['progress.md', 'decisions.md', 'gotchas.md', 'details.md'] as const;
type Tab = 'notes' | (typeof KNOWLEDGE_FILES)[number];

export function ProjectMemoryScreen({ project: projectProp }: { project?: string }) {
  const { baseUrl, agents } = useNeonCore();
  // Default to the repo of the first live cartridge, so the screen is useful on open rather
  // than demanding a selection the phone has no good way to make.
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
    return <View style={{ padding: 16 }}><Text style={{ color: theme.textDim }}>Pick a cartridge to see its project memory.</Text></View>;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {repos.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 40, paddingHorizontal: 10 }}>
          {repos.map((r) => (
            <Pressable
              key={r}
              onPress={() => setPicked(r)}
              style={{
                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginRight: 6,
                backgroundColor: project === r ? theme.accent : theme.bgElevated,
              }}
            >
              <Text style={{ color: project === r ? '#fff' : theme.textDim, fontSize: 12 }}>{r}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 10 }}>
        {(['notes', ...KNOWLEDGE_FILES] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={{
              paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
              backgroundColor: tab === t ? theme.accent : theme.bgElevated,
            }}
          >
            <Text style={{ color: tab === t ? '#fff' : theme.textDim, fontSize: 12 }}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {error !== '' && <Text style={{ color: theme.danger ?? '#f87171', fontSize: 12, paddingHorizontal: 12 }}>{error}</Text>}
      {busy && <ActivityIndicator style={{ marginVertical: 6 }} />}

      {tab === 'notes' ? (
        <ScrollView style={{ flex: 1, paddingHorizontal: 12 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={editingId ? 'edit note…' : 'new note…'}
            placeholderTextColor="#6b7280"
            multiline
            style={{
              color: theme.text, backgroundColor: theme.bgCard, borderRadius: 8,
              padding: 10, minHeight: 70, textAlignVertical: 'top',
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Pressable
              onPress={() => void saveNote()}
              disabled={busy || draft.trim() === ''}
              style={{ backgroundColor: theme.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, opacity: draft.trim() ? 1 : 0.4 }}
            >
              <Text style={{ color: '#fff', fontSize: 13 }}>{editingId ? 'Save note' : 'Add note'}</Text>
            </Pressable>
            {editingId && (
              <Pressable
                onPress={() => { setEditingId(null); setDraft(''); }}
                style={{ backgroundColor: theme.bgElevated, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}
              >
                <Text style={{ color: theme.text, fontSize: 13 }}>Cancel</Text>
              </Pressable>
            )}
          </View>

          {notes.length === 0 && !busy && (
            <Text style={{ color: theme.textFaint, fontStyle: 'italic', marginTop: 16 }}>No notes yet</Text>
          )}
          {notes.map((n) => (
            <View key={n.id} style={{ backgroundColor: theme.bgCard, borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>{n.content}</Text>
              <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
                <Pressable onPress={() => { setEditingId(n.id); setDraft(n.content); }}>
                  <Text style={{ color: theme.accent, fontSize: 12 }}>Edit</Text>
                </Pressable>
                <Pressable onPress={() => void run(() => api.deleteProjectNote(baseUrl, project, n.id))}>
                  <Text style={{ color: theme.danger ?? '#f87171', fontSize: 12 }}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 12 }}>
          <TextInput
            value={fileText}
            onChangeText={(t) => { setFileText(t); setDirty(true); }}
            multiline
            placeholder={`${tab} is empty — write the first line`}
            placeholderTextColor="#6b7280"
            style={{
              flex: 1, color: theme.text, backgroundColor: theme.bgCard, borderRadius: 8,
              padding: 10, textAlignVertical: 'top', fontSize: 13,
            }}
          />
          <Pressable
            onPress={() => void run(async () => {
              await api.updateKnowledgeFile(baseUrl, project, tab, fileText);
              setDirty(false);
            })}
            disabled={busy || !dirty}
            style={{
              backgroundColor: theme.accent, paddingVertical: 10, borderRadius: 6,
              alignItems: 'center', marginVertical: 10, opacity: dirty ? 1 : 0.4,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13 }}>{dirty ? `Save ${tab}` : 'Saved'}</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
