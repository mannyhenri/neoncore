const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro config for the bare React Native app (replaces Expo's metro preset).
 * @type {import('@react-native/metro-config').MetroConfig}
 */
module.exports = mergeConfig(getDefaultConfig(__dirname), {});
