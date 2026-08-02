import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { theme } from '../theme';
import { api } from '../api';
import { normalizeUrl, saveServerUrl } from '../config';

export function ConnectScreen({ onConnected }: { onConnected: (url: string) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async () => {
    const url = normalizeUrl(input);
    if (!url) {
      setError('Enter your NeonCore server URL');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const health = await api.health(url);
      if (health?.status !== 'ok') throw new Error('Server did not report healthy');
      await saveServerUrl(url);
      onConnected(url);
    } catch (e) {
      setError(`Could not reach ${url}\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.inner}>
        <Text style={styles.logo}>NEON<Text style={{ color: theme.accent }}>CORE</Text></Text>
        <Text style={styles.sub}>Connect to your orchestrator</Text>

        <Text style={styles.label}>SERVER URL</Text>
        <TextInput
          value={input}
          onChangeText={setInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.x.x:4040"
          placeholderTextColor={theme.textFaint}
          style={styles.input}
          onSubmitEditing={connect}
        />
        <Text style={styles.hint}>
          Find this on the server's startup banner (the "Network:" line).
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity style={styles.btn} onPress={connect} disabled={busy}>
          {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>CONNECT</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  logo: { fontSize: 40, fontWeight: '800', color: theme.text, letterSpacing: 2, textAlign: 'center' },
  sub: { color: theme.textDim, textAlign: 'center', marginTop: 6, marginBottom: 40 },
  label: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  input: {
    backgroundColor: theme.bgCard,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: theme.text,
    fontSize: 16,
  },
  hint: { color: theme.textFaint, fontSize: 12, marginTop: 8 },
  error: { color: theme.danger, fontSize: 13, marginTop: 16 },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 28,
  },
  btnText: { color: theme.bg, fontWeight: '800', letterSpacing: 1 },
});
