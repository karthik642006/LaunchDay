import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

// A single full-screen LaunchDay web app; it has its own bottom tab bar.
// The native Startups screen is kept in src/screens/Startups.js but not routed.
export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
