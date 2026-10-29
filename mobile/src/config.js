import Constants from 'expo-constants';

// In Expo Go the bundle is served from your PC, so the LaunchDay server (port 3000) is on the
// same host. Set EXPO_PUBLIC_API_URL (e.g. in mobile/.env) to point somewhere else, such as
// your deployed HTTPS server.
// With `expo start --tunnel` the host is an *.exp.direct address that only serves the bundle,
// so EXPO_PUBLIC_API_URL must be set.
function devServerHost() {
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.platform?.hostUri;
  const host = hostUri ? hostUri.split(':')[0] : null;
  return host && !host.endsWith('.exp.direct') ? host : null;
}

const host = devServerHost();

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || (host ? `http://${host}:3000` : 'http://localhost:3000')).replace(/\/$/, '');

export const ACCENT = '#ff6154';
