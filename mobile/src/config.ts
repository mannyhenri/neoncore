import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'neoncore.serverUrl';

// EAS project id — required by expo-notifications to mint an Expo push token in a
// production build. Mirrors app.json → expo.extra.eas.projectId.
export const EAS_PROJECT_ID = '58c8efd5-84b8-4476-8f92-fca6bf3bf691';

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
