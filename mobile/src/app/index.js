import { useCallback, useRef, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { ACCENT, API_URL } from '../config';

// The LaunchDay web app, full screen. Its own bottom tab bar handles navigation.
export default function LaunchDayScreen() {
  const web = useRef(null);
  const canGoBack = useRef(false);
  const [failed, setFailed] = useState(false);

  // Android back button navigates inside the web app first.
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []));

  // Links to other sites (product websites, store pages) open outside the app.
  const onShouldStartLoad = ({ url }) => {
    if (url.startsWith(API_URL) || url.startsWith('about:')) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  };

  if (failed) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>Can't reach LaunchDay</Text>
        <Text style={styles.muted}>Make sure the server is running at {API_URL} and your phone is on the same Wi-Fi.</Text>
        <Pressable style={styles.button} onPress={() => setFailed(false)}><Text style={styles.buttonText}>Try again</Text></Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
      <WebView
        ref={web}
        source={{ uri: API_URL }}
        onNavigationStateChange={(nav) => { canGoBack.current = nav.canGoBack; }}
        onShouldStartLoadWithRequest={onShouldStartLoad}
        onError={() => setFailed(true)}
        sharedCookiesEnabled
        startInLoadingState
        renderLoading={() => <View style={StyleSheet.absoluteFill} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8, backgroundColor: '#fff' },
  title: { fontSize: 17, fontWeight: '700', color: '#18181b' },
  muted: { color: '#71717a', textAlign: 'center' },
  button: { marginTop: 8, backgroundColor: ACCENT, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '700' },
});
