import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Linking, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { ACCENT, API_URL } from '../config';

// Native startup listings from MongoDB via GET /api/startups (cursor-paginated).
async function fetchStartups({ q, cursor }) {
  const params = new URLSearchParams({ limit: '20' });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  let res;
  try {
    res = await fetch(`${API_URL}/api/startups?${params}`);
  } catch {
    throw new Error(`Can't reach the server at ${API_URL}. Is it running, and is your phone on the same Wi-Fi?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server error (${res.status}).`);
  return body;
}

export default function StartupsScreen() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('loading'); // loading | refreshing | more | idle
  const [error, setError] = useState(null);
  const request = useRef(0);

  const load = useCallback(async (mode, q, after) => {
    const id = ++request.current;
    setState(mode);
    try {
      const data = await fetchStartups({ q, cursor: after });
      if (id !== request.current) return;
      setItems((prev) => (after ? [...prev, ...data.startups] : data.startups));
      setCursor(data.nextCursor);
      setError(null);
    } catch (e) {
      if (id === request.current) setError(e.message);
    } finally {
      if (id === request.current) setState('idle');
    }
  }, []);

  useEffect(() => { load('loading', ''); }, [load]);

  const search = () => load('loading', query.trim());
  const refresh = () => load('refreshing', query.trim());
  const loadMore = () => { if (cursor && state === 'idle') load('more', query.trim(), cursor); };

  return (
    <View style={styles.screen}>
      <TextInput
        style={styles.search}
        placeholder="Search startups…"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={search}
        returnKeyType="search"
        maxLength={60}
      />
      {state === 'loading' ? (
        <ActivityIndicator style={styles.center} color={ACCENT} size="large" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => <StartupCard startup={item} />}
          contentContainerStyle={items.length ? styles.list : styles.emptyList}
          refreshControl={<RefreshControl refreshing={state === 'refreshing'} onRefresh={refresh} colors={[ACCENT]} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={state === 'more' ? <ActivityIndicator style={{ margin: 16 }} color={ACCENT} /> : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{error ? 'Something went wrong' : 'No startups yet'}</Text>
              <Text style={styles.muted}>{error || 'Listings added to MongoDB will show up here. Pull down to refresh.'}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function StartupCard({ startup }) {
  const website = /^https?:\/\//i.test(startup.website || '') ? startup.website : null;
  return (
    <Pressable style={styles.card} disabled={!website} onPress={() => Linking.openURL(website)}>
      {startup.logo ? (
        <Image source={{ uri: startup.logo }} style={styles.logo} />
      ) : (
        <View style={[styles.logo, styles.logoFallback]}><Text style={styles.logoText}>{(startup.name || '?')[0].toUpperCase()}</Text></View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>{startup.name}</Text>
        {!!startup.tagline && <Text style={styles.muted} numberOfLines={2}>{startup.tagline}</Text>}
        <View style={styles.tags}>
          {[startup.category, startup.stage, startup.location].filter(Boolean).map((t) => (
            <Text key={t} style={styles.tag}>{t}</Text>
          ))}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f7f8' },
  center: { flex: 1 },
  search: { margin: 12, marginBottom: 4, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e4e4e7', fontSize: 16 },
  list: { padding: 12, gap: 10 },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  empty: { alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: '#18181b' },
  card: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#ececef' },
  logo: { width: 52, height: 52, borderRadius: 10 },
  logoFallback: { backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  name: { fontSize: 16, fontWeight: '700', color: '#18181b' },
  muted: { color: '#71717a', fontSize: 14, textAlign: 'left' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  tag: { fontSize: 12, color: '#3f3f46', backgroundColor: '#f4f4f5', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: 'hidden' },
});
