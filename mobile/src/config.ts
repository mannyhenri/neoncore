import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'neoncore.serverUrl';

/** Normalize user input into a clean base URL (adds http://, strips trailing slash). */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

export async function loadServerUrl(): Promise<string | null> {
  return AsyncStorage.getItem(KEY);
}

export async function saveServerUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(KEY, url);
}

export async function clearServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
