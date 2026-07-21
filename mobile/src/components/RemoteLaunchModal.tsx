import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, TextInput,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Machine } from '../types';

// Agent types the runner can launch (it spawns the relay, which defaults to claude).
const AGENT_TYPES = ['claude', 'gridlight', 'codex'];
const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * Launch a cartridge on another computer running the runner daemon. Pick a machine → a repo
 * from its allowlist → an agent type → Launch. Mirrors the web MachineLauncher.
 */
export function RemoteLaunchModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { baseUrl } = useNeonCore();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null); // `${machineId}:${path}`
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');

  const load = useCallback(async () => {
    const m = await api.getMachines(baseUrl).catch(() => [] as Machine[]);
    setMachines(m);
  }, [baseUrl]);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    load().finally(() => setLoading(false));
    // Poll while open so a machine coming online shows without reopening.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [visible, load]);

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 4000);
  };

  const launch = async (m: Machine, repoPath: string, repoName: string, agentType: string) => {
    setBusy(true);
    try {
      await api.launchOnMachine(baseUrl, m.id, repoPath, agentType);
      flash(`Launching ${agentType} in ${repoName} on ${m.hostname}…`);
      setExpanded(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Launch failed');
    } finally {
      setBusy(false);
    }
  };

  // Push a new folder list to the runner; it validates against its own disk and re-registers.
  // Reload shortly after so the (async) result shows.
  const setRepos = async (m: Machine, repos: { path: string; name?: string }[]) => {
    setBusy(true);
    try {
      await api.setMachineRepos(baseUrl, m.id, repos);
      flash('Updated exposed folders');
      setTimeout(load, 1200);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };
  const removeRepo = (m: Machine, path: string) =>
    setRepos(m, m.repos.filter((r) => r.path !== path).map((r) => ({ path: r.path, name: r.name })));
  const addRepo = (m: Machine) => {
    const p = newPath.trim();
    if (!p) return;
    setNewPath('');
    setRepos(m, [...m.repos.map((r) => ({ path: r.path, name: r.name })), { path: p }]);
  };
  const scanFolder = async (m: Machine) => {
    const root = newPath.trim();
    if (!root) return;
    setNewPath('');
    setBusy(true);
    try {
      await api.scanMachineFolder(baseUrl, m.id, root);
      flash(`Scanning ${root} on ${m.hostname}…`);
      setTimeout(load, 1500);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Launch on machine</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>Done</Text>
            </TouchableOpacity>
          </View>

          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          {loading ? (
            <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
          ) : machines.length === 0 ? (
            <Text style={styles.empty}>
              No machines registered.{'\n'}Run the runner daemon on a computer (agent/runner) to
              launch a cartridge there remotely.
            </Text>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
              {machines.map((m) => {
                const online = m.status === 'online';
                const editing = editingId === m.id;
                return (
                  <View key={m.id} style={styles.machine}>
                    <View style={styles.machineHead}>
                      <View style={[styles.dot, { backgroundColor: online ? theme.teal : theme.textFaint }]} />
                      <Text style={styles.machineName} numberOfLines={1}>{m.hostname || m.id.slice(0, 8)}</Text>
                      {online && (
                        <TouchableOpacity onPress={() => { setEditingId(editing ? null : m.id); setExpanded(null); setNewPath(''); }}>
                          <Text style={styles.editToggle}>{editing ? 'Done' : 'Edit folders'}</Text>
                        </TouchableOpacity>
                      )}
                      <Text style={styles.machineOs}>{OS_LABEL[m.platform] || m.platform}</Text>
                    </View>

                    {!online ? (
                      <Text style={styles.sub}>Offline</Text>
                    ) : editing ? (
                      <View style={styles.editWrap}>
                        {m.repos.length === 0 && <Text style={styles.sub}>No folders yet — add one below.</Text>}
                        {m.repos.map((repo) => (
                          <View key={repo.path} style={styles.editRow}>
                            <Text style={styles.editRepoName} numberOfLines={1}>{repo.name}</Text>
                            <TouchableOpacity disabled={busy} onPress={() => removeRepo(m, repo.path)}>
                              <Text style={styles.removeX}>✕</Text>
                            </TouchableOpacity>
                          </View>
                        ))}
                        <View style={styles.addRow}>
                          <TextInput
                            value={newPath}
                            onChangeText={setNewPath}
                            placeholder={m.platform === 'win32' ? 'C:\\code\\project' : '/path/to/project'}
                            placeholderTextColor={theme.textFaint}
                            style={styles.addInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="done"
                            onSubmitEditing={() => addRepo(m)}
                          />
                          <TouchableOpacity style={styles.addBtn} disabled={busy || !newPath.trim()} onPress={() => addRepo(m)}>
                            <Text style={styles.addBtnText}>Add</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.scanBtn} disabled={busy || !newPath.trim()} onPress={() => scanFolder(m)}>
                            <Text style={styles.scanBtnText}>Scan</Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.editHint}>Add = this folder. Scan = every git repo under it. Missing paths are ignored.</Text>
                      </View>
                    ) : m.repos.length === 0 ? (
                      <Text style={styles.sub}>No folders — tap “Edit folders”.</Text>
                    ) : (
                      m.repos.map((repo) => {
                        const rid = `${m.id}:${repo.path}`;
                        const open = expanded === rid;
                        return (
                          <View key={rid}>
                            <TouchableOpacity
                              style={styles.repoRow}
                              onPress={() => setExpanded(open ? null : rid)}
                            >
                              <Text style={styles.repoName} numberOfLines={1}>{repo.name}</Text>
                              <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
                            </TouchableOpacity>
                            {open && (
                              <View style={styles.agentWrap}>
                                {AGENT_TYPES.map((t) => (
                                  <TouchableOpacity
                                    key={t}
                                    style={styles.agentChip}
                                    disabled={busy}
                                    onPress={() => launch(m, repo.path, repo.name, t)}
                                  >
                                    <Text style={styles.agentChipText}>{t}</Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })
                    )}
                  </View>
                );
              })}
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
    backgroundColor: theme.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: 16, paddingTop: 14, maxHeight: '82%',
    borderTopWidth: 1, borderColor: theme.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.text, fontSize: 18, fontWeight: '800' },
  close: { color: theme.accentSoft, fontSize: 15, fontWeight: '700' },
  notice: { color: theme.teal, fontSize: 13, paddingVertical: 6 },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40, lineHeight: 20, paddingHorizontal: 20 },

  machine: {
    backgroundColor: theme.bgCard, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, padding: 12, marginTop: 10,
  },
  machineHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  machineName: { color: theme.text, fontSize: 15, fontWeight: '700', flex: 1 },
  machineOs: { color: theme.textFaint, fontSize: 11 },
  editToggle: { color: theme.accentSoft, fontSize: 11, fontWeight: '700', marginRight: 10 },
  sub: { color: theme.textFaint, fontSize: 12, marginTop: 8, marginLeft: 16 },

  editWrap: { marginTop: 8, marginLeft: 16, gap: 6 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  editRepoName: { color: theme.textDim, fontSize: 13, flex: 1 },
  removeX: { color: theme.danger, fontSize: 14, fontWeight: '700', paddingHorizontal: 6 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addInput: {
    flex: 1, backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: theme.text, fontSize: 13,
  },
  addBtn: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.accent,
  },
  addBtnText: { color: theme.accentSoft, fontSize: 13, fontWeight: '700' },
  scanBtn: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border,
  },
  scanBtnText: { color: theme.textDim, fontSize: 13, fontWeight: '700' },
  editHint: { color: theme.textFaint, fontSize: 10, marginTop: 2 },

  repoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, marginLeft: 16, borderTopWidth: 1, borderTopColor: theme.border,
  },
  repoName: { color: theme.textDim, fontSize: 14, flex: 1 },
  chevron: { color: theme.textFaint, fontSize: 13, marginLeft: 8 },
  agentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginLeft: 16, marginBottom: 10 },
  agentChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.accent,
  },
  agentChipText: { color: theme.accentSoft, fontSize: 13, fontWeight: '600' },
});
