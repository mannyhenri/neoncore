import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { theme } from '../theme';
import { useNeonCore } from '../NeonCoreProvider';

/**
 * Fleet management on the phone.
 *
 * Mirrors the web ServerPicker, with one difference that matters on mobile: an
 * unreachable server is the NORMAL state here, not an error. Machines sleep, you leave
 * Wi-Fi, you are on cellular. So the sheet distinguishes "asleep" (expected, keeps showing
 * last known cartridges) from "token rejected" (needs you), rather than painting both red
 * and training you to ignore it.
 */
export function FleetSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { servers, serverStatuses, addServer, forgetServer, hideServer, setToken } = useNeonCore();
  const [url, setUrl] = useState('');
  const [token, setTokenText] = useState('');
  const [tokenOpen, setTokenOpen] = useState(false);

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    await addServer(trimmed, token.trim() || undefined);
    setUrl('');
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.backdropTap} activeOpacity={1} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.title}>Fleet</Text>

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {servers.map((server) => {
                const status = serverStatuses.find((s) => s.url === server.url);
                const dotColor = status?.authFailed
                  ? theme.amber
                  : status?.reachable ? theme.accent : theme.textFaint;
                return (
                  <View key={server.url} style={styles.row}>
                    <View style={[styles.dot, { backgroundColor: dotColor }]} />
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {server.name}
                        {server.manual === false && <Text style={styles.faint}>  found</Text>}
                        {server.hidden && <Text style={styles.faint}>  hidden</Text>}
                      </Text>
                      <Text style={styles.rowUrl} numberOfLines={1}>{server.url}</Text>
                      {status?.authFailed && (
                        <Text style={styles.warn}>Token rejected — not a network problem</Text>
                      )}
                      {!status?.reachable && !status?.authFailed && !!status?.lastOkAt && (
                        <Text style={styles.faint}>Asleep — showing last known cartridges</Text>
                      )}
                    </View>
                    <TouchableOpacity onPress={() => hideServer(server.url, !server.hidden)} style={styles.action}>
                      <Text style={styles.actionText}>{server.hidden ? 'show' : 'hide'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => forgetServer(server.url)} style={styles.action}>
                      <Text style={[styles.actionText, { color: theme.textFaint }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
              {servers.length === 0 && <Text style={styles.faint}>No servers yet.</Text>}
            </ScrollView>

            <View style={styles.addRow}>
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="studio.local:4040"
                placeholderTextColor={theme.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
                onSubmitEditing={submit}
              />
              <TouchableOpacity onPress={submit} style={styles.addBtn}>
                <Text style={styles.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>

            {tokenOpen ? (
              <View style={styles.addRow}>
                <TextInput
                  value={token}
                  onChangeText={setTokenText}
                  placeholder="fleet token"
                  placeholderTextColor={theme.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  style={styles.input}
                />
                <TouchableOpacity
                  onPress={async () => { await setToken(token.trim() || null); setTokenOpen(false); }}
                  style={styles.addBtn}
                >
                  <Text style={styles.addBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => setTokenOpen(true)}>
                <Text style={styles.link}>Set fleet token for all servers…</Text>
              </TouchableOpacity>
            )}

            <Text style={styles.help}>
              Servers found through gossip appear on their own. Forgetting one only hides it
              until the next discovery — use hide to keep it out for good.
            </Text>

            <TouchableOpacity onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: theme.border,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border, marginBottom: 10 },
  title: { color: theme.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  list: { maxHeight: 260 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: theme.text, fontSize: 13, fontWeight: '600' },
  rowUrl: { color: theme.textFaint, fontSize: 11 },
  faint: { color: theme.textFaint, fontSize: 11 },
  warn: { color: theme.amber, fontSize: 11 },
  action: { paddingHorizontal: 6, paddingVertical: 4 },
  actionText: { color: theme.textDim, fontSize: 12 },
  addRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: {
    flex: 1, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.border,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.text, fontSize: 13,
  },
  addBtn: { paddingHorizontal: 14, justifyContent: 'center', backgroundColor: theme.border, borderRadius: 8 },
  addBtnText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  link: { color: theme.textFaint, fontSize: 12, marginTop: 10 },
  help: { color: theme.textFaint, fontSize: 10, lineHeight: 14, marginTop: 10 },
  close: { marginTop: 14, alignItems: 'center', paddingVertical: 10, backgroundColor: theme.bg, borderRadius: 8 },
  closeText: { color: theme.text, fontSize: 14, fontWeight: '600' },
});
