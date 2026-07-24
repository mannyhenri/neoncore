/**
 * Bare React Native entry point.
 *
 * Replaces Expo's `expo/AppEntry.js`. The app name registered here must match the
 * `moduleName` the native AppDelegate boots ("NeonCore"), and the `name` in app.json.
 */
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
