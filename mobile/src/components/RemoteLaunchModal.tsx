import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { useNeonCore } from '../NeonCoreProvider';
import type { Machine } from '../types';

// Agent types the runner can launch (it spawns the relay, which defaults to claude).
const AGENT_TYPES = ['claude', 'gridlight', 'gemini', 'codex'];
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
                return (
                  <View key={m.id} style={styles.machine}>
                    <View style={styles.machineHead}>
                      <View style={[styles.dot, { backgroundColor: online ? theme.teal : theme.textFaint }]} />
                      <Text style={styles.machineName} numberOfLines={1}>{m.hostname || m.id.slice(0, 8)}</Text>
                      <Text style={styles.machineOs}>{OS_LABEL[m.platform] || m.platform}</Text>
                    </View>

                    {!online ? (
                      <Text style={styles.sub}>Offline</Text>
                    ) : m.repos.length === 0 ? (
                      <Text style={styles.sub}>No repos configured</Text>
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
  sub: { color: theme.textFaint, fontSize: 12, marginTop: 8, marginLeft: 16 },

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
