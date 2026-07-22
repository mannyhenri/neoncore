import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator, Linking,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';

// Tool to launch in the new folder → the relay-terminal launcher for each engine (server side).
const TOOLS: { value: string; label: string }[] = [
  { value: 'claude-cli', label: 'Claude' },
  { value: 'gridlight-cli', label: 'Gridlight' },
  { value: 'codex-cli', label: 'Codex' },
];

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Create a new repo from the phone. The server host does the work: mkdir under its configured
 * projects folder → git init + commit → gh repo create + push (under the active gh account) →
 * add to the launch allowlist → launch the chosen agent. Kept simple for mobile: no folder
 * picker or owner selection — those default server-side.
 */
export function NewRepoModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { baseUrl } = useNeonCore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [launch, setLaunch] = useState(true);
  const [tool, setTool] = useState(TOOLS[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ repoUrl: string; path: string; launchError: string | null } | null>(null);

  const nameValid = NAME_RE.test(name);

  const reset = () => {
    setName(''); setDescription(''); setIsPrivate(true); setLaunch(true);
    setTool(TOOLS[0].value); setError(''); setResult(null);
  };
  const close = () => { reset(); onClose(); };

  const create = async () => {
    if (!nameValid) return;
    setBusy(true); setError('');
    try {
      const res = await api.createRepo(baseUrl, {
        name,
        description: description.trim() || undefined,
        isPrivate,
        agentType: launch ? tool : 'none',
      });
      setResult({ repoUrl: res.repoUrl, path: res.path, launchError: res.launchError });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create repo');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>New repo</Text>
            <TouchableOpacity onPress={close}><Text style={styles.close}>Done</Text></TouchableOpacity>
          </View>

          {result ? (
            <View style={styles.body}>
              <Text style={styles.okLine}>✓ Repo created and pushed</Text>
              <Text style={styles.pathText} numberOfLines={2}>{result.path}</Text>
              <TouchableOpacity onPress={() => Linking.openURL(result.repoUrl).catch(() => {})}>
                <Text style={styles.link} numberOfLines={2}>{result.repoUrl}</Text>
              </TouchableOpacity>
              {launch ? (
                result.launchError
                  ? <Text style={styles.warn}>Repo ready, but the agent didn't launch: {result.launchError}</Text>
                  : <Text style={styles.sub}>Launching the agent — the cartridge will appear shortly.</Text>
              ) : null}
              <TouchableOpacity style={styles.runBtn} onPress={close}>
                <Text style={styles.runBtnText}>DONE</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Text style={styles.sub}>
                Created on the server host under its projects folder, under your active GitHub account.
              </Text>

              <Text style={styles.label}>REPO NAME</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="my-quick-example"
                placeholderTextColor={theme.textFaint}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {name && !nameValid ? (
                <Text style={styles.warn}>Only letters, numbers, dots, dashes, underscores.</Text>
              ) : null}

              <Text style={styles.label}>DESCRIPTION (OPTIONAL)</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="A quick example for…"
                placeholderTextColor={theme.textFaint}
                style={styles.input}
              />

              <Text style={styles.label}>VISIBILITY</Text>
              <View style={styles.segment}>
                {[{ v: true, l: 'Private' }, { v: false, l: 'Public' }].map((o) => (
                  <TouchableOpacity
                    key={o.l}
                    style={[styles.segBtn, isPrivate === o.v && styles.segBtnOn]}
                    onPress={() => setIsPrivate(o.v)}
                  >
                    <Text style={[styles.segText, isPrivate === o.v && styles.segTextOn]}>{o.l}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.launchRow}>
                <TouchableOpacity style={styles.checkRow} onPress={() => setLaunch((v) => !v)}>
                  <View style={[styles.check, launch && styles.checkOn]}>
                    {launch ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                  <Text style={styles.checkLabel}>Launch agent after create</Text>
                </TouchableOpacity>
              </View>
              {launch ? (
                <View style={styles.segment}>
                  {TOOLS.map((t) => (
                    <TouchableOpacity
                      key={t.value}
                      style={[styles.segBtn, tool === t.value && styles.segBtnOn]}
                      onPress={() => setTool(t.value)}
                    >
                      <Text style={[styles.segText, tool === t.value && styles.segTextOn]}>{t.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {error ? <Text style={styles.err}>{error}</Text> : null}

              <TouchableOpacity
                style={[styles.runBtn, (busy || !nameValid) && styles.runBtnOff]}
                onPress={create}
                disabled={busy || !nameValid}
              >
                {busy ? <ActivityIndicator color="#0d0f12" /> : <Text style={styles.runBtnText}>CREATE & PUSH</Text>}
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28, maxHeight: '88%',
    borderTopWidth: 1, borderColor: theme.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 18, fontWeight: '800' },
  close: { color: theme.accentSoft, fontSize: 15, fontWeight: '700' },
  body: { paddingBottom: 12, paddingTop: 8 },
  sub: { color: theme.textFaint, fontSize: 12, marginBottom: 6 },
  label: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 14, marginBottom: 6 },
  input: {
    color: theme.text, fontSize: 14, backgroundColor: theme.bgCard, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border, paddingHorizontal: 12, paddingVertical: 10,
  },
  segment: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  segBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 9,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  segBtnOn: { borderColor: theme.accent, backgroundColor: theme.bgCard },
  segText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  segTextOn: { color: theme.accentSoft },
  launchRow: { marginTop: 16 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  check: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: theme.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bgElevated,
  },
  checkOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  checkMark: { color: '#0d0f12', fontSize: 13, fontWeight: '900' },
  checkLabel: { color: theme.textDim, fontSize: 13 },
  err: { color: theme.danger, fontSize: 13, marginTop: 12 },
  warn: { color: theme.amber, fontSize: 12, marginTop: 6 },
  okLine: { color: theme.teal, fontSize: 15, fontWeight: '800', marginBottom: 8 },
  pathText: { color: theme.textFaint, fontSize: 12, marginBottom: 6 },
  link: { color: theme.accentSoft, fontSize: 14, fontWeight: '600', marginBottom: 4 },
  runBtn: { marginTop: 18, backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  runBtnOff: { opacity: 0.4 },
  runBtnText: { color: '#0d0f12', fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
