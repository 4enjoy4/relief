/* FauxCode profile: Mobile development — pulse-mobile */
(function () {
'use strict';
const SRC = {};

/* ---------- src/sync/sync.engine.ts (base for genLargeTsClass) ---------- */
SRC.SYNC_ENGINE = `import { useStore } from '../state/store';
import { MutationQueue, QueuedMutation } from './mutation.queue';
import { ConflictResolver, ConflictOutcome } from './conflict.resolver';
import { ApiClient } from '../api/client';
import type { SyncCheckpoint, SyncResult } from '../api/types';

// MOB-512: offline-first sync. Mutations are queued locally, flushed when the
// network comes back, and conflicts are resolved server-wins unless the client
// has a good reason. The client usually thinks it has a good reason.

export interface SyncLogger {
  debug(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
}

const MAX_BATCH = 50;
const FLUSH_COOLDOWN_MS = 2_000;

export class SyncEngine {
  private flushing = false;
  private lastFlushAt = 0;
  private checkpoint: SyncCheckpoint | null = null;

  constructor(
    private readonly queue: MutationQueue,
    private readonly resolver: ConflictResolver,
    private readonly api: ApiClient,
    private readonly logger: SyncLogger,
  ) {}

  enqueue(mutation: QueuedMutation): void {
    this.queue.push(mutation);
    useStore.getState().setPendingCount(this.queue.size());
    this.logger.debug({ kind: mutation.kind, id: mutation.id }, 'mutation queued');
  }

  onReconnect(): void {
    // NetInfo fires this several times per reconnect. It is enthusiastic.
    if (Date.now() - this.lastFlushAt < FLUSH_COOLDOWN_MS) {
      return;
    }
    void this.flush();
  }

  async flush(): Promise<SyncResult> {
    if (this.flushing) {
      return { status: 'busy', applied: 0, conflicts: 0 };
    }
    this.flushing = true;
    const traceId = 'sync-' + Date.now().toString(36);
    let applied = 0;
    let conflicts = 0;

    try {
      const batch = this.queue.peek(MAX_BATCH);
      if (!batch.length) {
        return { status: 'idle', applied, conflicts };
      }
      const response = await this.api.pushMutations(batch, this.checkpoint);
      for (const outcome of response.outcomes) {
        if (outcome.status === 'applied') {
          this.queue.ack(outcome.id);
          applied += 1;
          continue;
        }
        const resolved: ConflictOutcome = this.resolver.resolve(outcome, batch);
        if (resolved.retry) {
          this.queue.requeue(outcome.id, resolved.payload);
        } else {
          this.queue.ack(outcome.id);
        }
        conflicts += 1;
      }
      this.checkpoint = response.checkpoint;
      useStore.getState().markSynced(response.checkpoint.serverTime);
      this.logger.debug({ traceId, applied, conflicts }, 'flush complete');
      return { status: 'ok', applied, conflicts };
    } catch (error) {
      this.logger.warn({ traceId, error }, 'flush failed, will retry on next reconnect');
      return { status: 'failed', applied, conflicts };
    } finally {
      this.flushing = false;
      this.lastFlushAt = Date.now();
      useStore.getState().setPendingCount(this.queue.size());
    }
  }

  private stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (input[key] !== undefined) {
        out[key] = input[key];
      }
    }
    return out;
  }
}
`;

/* ---------- android OfflineStoreModule.kt (base for genLargeKotlinClass) ---------- */
SRC.OFFLINE_STORE = `package com.pulse

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

// MOB-512: durable mutation queue backed by SQLite. AsyncStorage was tried first.
// AsyncStorage has been thanked for its service.

private class OfflineDbHelper(context: Context) :
  SQLiteOpenHelper(context, "pulse_offline.db", null, 2) {

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE mutations (" +
        "id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, " +
        "created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
    )
    db.execSQL("CREATE INDEX idx_mutations_created ON mutations (created_at)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion < 2) {
      db.execSQL("ALTER TABLE mutations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    }
  }
}

class OfflineStoreModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val helper = OfflineDbHelper(reactContext)
  private val tag = "OfflineStore"

  override fun getName(): String = "OfflineStore"

  @ReactMethod
  fun put(id: String, kind: String, payload: String, promise: Promise) {
    try {
      helper.writableDatabase.execSQL(
        "INSERT OR REPLACE INTO mutations (id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
        arrayOf(id, kind, payload, System.currentTimeMillis()),
      )
      emitChange("put", id)
      promise.resolve(null)
    } catch (e: Exception) {
      Log.w(tag, "put failed for " + id, e)
      promise.reject("E_STORE_PUT", e)
    }
  }

  @ReactMethod
  fun list(limit: Int, promise: Promise) {
    try {
      val cursor = helper.readableDatabase.rawQuery(
        "SELECT id, kind, payload, created_at, attempts FROM mutations ORDER BY created_at ASC LIMIT ?",
        arrayOf(limit.toString()),
      )
      val rows = Arguments.createArray()
      cursor.use {
        while (it.moveToNext()) {
          val row = Arguments.createMap()
          row.putString("id", it.getString(0))
          row.putString("kind", it.getString(1))
          row.putString("payload", it.getString(2))
          row.putDouble("createdAt", it.getLong(3).toDouble())
          row.putInt("attempts", it.getInt(4))
          rows.pushMap(row)
        }
      }
      promise.resolve(rows)
    } catch (e: Exception) {
      promise.reject("E_STORE_LIST", e)
    }
  }

  @ReactMethod
  fun remove(id: String, promise: Promise) {
    val deleted = helper.writableDatabase.delete("mutations", "id = ?", arrayOf(id))
    emitChange("remove", id)
    promise.resolve(deleted)
  }

  @ReactMethod
  fun bumpAttempts(id: String, promise: Promise) {
    helper.writableDatabase.execSQL("UPDATE mutations SET attempts = attempts + 1 WHERE id = ?", arrayOf(id))
    promise.resolve(null)
  }

  @ReactMethod
  fun count(promise: Promise) {
    val cursor = helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM mutations", null)
    cursor.use {
      it.moveToFirst()
      promise.resolve(it.getInt(0))
    }
  }

  private fun emitChange(op: String, id: String) {
    val params = Arguments.createMap()
    params.putString("op", op)
    params.putString("id", id)
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("OfflineStoreChanged", params)
  }
}
`;

/* ---------- src/screens/HomeScreen.tsx ---------- */
SRC.HOME_SCREEN = `import React, { useCallback, useEffect, useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useStore } from '../state/store';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { ActivityCard } from '../components/ActivityCard';
import { RingChart } from '../components/RingChart';
import { tokens } from '../theme/tokens';
import type { Activity } from '../api/types';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const DAILY_STEP_GOAL = 10_000;

export function HomeScreen(): JSX.Element {
  const navigation = useNavigation<Nav>();
  const { isOnline } = useNetworkStatus();
  const activities = useStore((s) => s.activities);
  const todaySteps = useStore((s) => s.todaySteps);
  const pendingCount = useStore((s) => s.pendingCount);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const refreshing = useStore((s) => s.refreshing);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const progress = useMemo(() => Math.min(1, todaySteps / DAILY_STEP_GOAL), [todaySteps]);

  const syncLabel = useMemo(() => {
    if (!isOnline) {
      return pendingCount > 0 ? pendingCount + ' changes waiting for network' : 'Offline';
    }
    if (!lastSyncedAt) return 'Never synced';
    return 'Synced ' + formatRelative(lastSyncedAt);
  }, [isOnline, pendingCount, lastSyncedAt]);

  const openActivity = useCallback(
    (activity: Activity) => navigation.navigate('ActivityDetail', { activityId: activity.id }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Activity }) => <ActivityCard activity={item} onPress={openActivity} />,
    [openActivity],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <RingChart progress={progress} size={148} strokeWidth={14} />
        <View style={styles.headerText}>
          <Text style={styles.steps}>{todaySteps.toLocaleString()}</Text>
          <Text style={styles.caption}>of {DAILY_STEP_GOAL.toLocaleString()} steps</Text>
          <Text style={[styles.sync, !isOnline && styles.syncOffline]}>{syncLabel}</Text>
        </View>
      </View>

      <FlatList
        data={activities}
        keyExtractor={(a) => a.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={tokens.color.accent} />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>No workouts yet. The couch counts as a rest day.</Text>
        }
      />
    </View>
  );
}

function formatRelative(iso: string): string {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + ' min ago';
  const hours = Math.round(diffMin / 60);
  return hours + (hours === 1 ? ' hour ago' : ' hours ago');
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tokens.color.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: tokens.space.lg,
    gap: tokens.space.lg,
  },
  headerText: { flex: 1 },
  steps: { fontSize: 36, fontWeight: '700', color: tokens.color.text },
  caption: { fontSize: 14, color: tokens.color.textMuted, marginTop: 2 },
  sync: { fontSize: 12, color: tokens.color.textMuted, marginTop: tokens.space.sm },
  syncOffline: { color: tokens.color.warning },
  // 300 because the tab bar covers the last card otherwise. Ask design, not me.
  list: { paddingHorizontal: tokens.space.md, paddingBottom: 300 },
  empty: { textAlign: 'center', color: tokens.color.textMuted, marginTop: tokens.space.xl },
});
`;

/* ---------- src/screens/ActivityDetailScreen.tsx ---------- */
SRC.ACTIVITY_DETAIL = `import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { useStore } from '../state/store';
import { syncEngine } from '../sync/mutation.queue';
import { tokens } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { HeartRateSample } from '../api/types';

type DetailRoute = RouteProp<RootStackParamList, 'ActivityDetail'>;

export function ActivityDetailScreen(): JSX.Element {
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation();
  const activity = useStore((s) => s.activities.find((a) => a.id === route.params.activityId));
  const upsertActivity = useStore((s) => s.upsertActivity);
  const removeActivity = useStore((s) => s.removeActivity);
  const [note, setNote] = useState(activity ? activity.note : '');

  const zones = useMemo(() => (activity ? summarizeZones(activity.heartRate) : null), [activity]);

  const saveNote = useCallback(() => {
    if (!activity) return;
    const updatedAt = new Date().toISOString();
    upsertActivity({ ...activity, note, updatedAt, pending: true });
    syncEngine.enqueue({
      id: 'note-' + activity.id + '-' + Date.now(),
      kind: 'activity.note',
      payload: { activityId: activity.id, note, updatedAt },
      createdAt: Date.now(),
      attempts: 0,
    });
  }, [activity, note, upsertActivity]);

  const confirmDelete = useCallback(() => {
    if (!activity) return;
    Alert.alert('Delete workout?', 'The steps still happened. The record will not.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          removeActivity(activity.id);
          syncEngine.enqueue({
            id: 'delete-' + activity.id,
            kind: 'activity.delete',
            payload: { activityId: activity.id },
            createdAt: Date.now(),
            attempts: 0,
          });
          navigation.goBack();
        },
      },
    ]);
  }, [activity, removeActivity, navigation]);

  if (!activity) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>This workout is no longer on this device.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{activity.title}</Text>
      <Text style={styles.muted}>{new Date(activity.startedAt).toLocaleString()}</Text>

      <View style={styles.statRow}>
        <Stat label="Duration" value={formatDuration(activity.durationSec)} />
        <Stat label="Distance" value={(activity.distanceM / 1000).toFixed(2) + ' km'} />
        <Stat label="Avg HR" value={zones ? zones.avg + ' bpm' : '—'} />
      </View>

      {zones && (
        <View style={styles.zones}>
          <ZoneBar label="Easy" pct={zones.easy} color={tokens.color.zoneEasy} />
          <ZoneBar label="Moderate" pct={zones.moderate} color={tokens.color.zoneModerate} />
          <ZoneBar label="Hard" pct={zones.hard} color={tokens.color.zoneHard} />
        </View>
      )}

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={styles.input}
        multiline
        value={note}
        onChangeText={setNote}
        onBlur={saveNote}
        placeholder="How did it feel?"
        placeholderTextColor={tokens.color.textMuted}
      />
      {activity.pending && <Text style={styles.pending}>Waiting to sync</Text>}

      <Pressable style={styles.deleteButton} onPress={confirmDelete}>
        <Text style={styles.deleteText}>Delete workout</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

function ZoneBar({ label, pct, color }: { label: string; pct: number; color: string }): JSX.Element {
  return (
    <View style={styles.zoneRow}>
      <Text style={styles.zoneLabel}>{label}</Text>
      <View style={styles.zoneTrack}>
        <View style={[styles.zoneFill, { width: Math.round(pct * 100) + '%', backgroundColor: color }]} />
      </View>
      <Text style={styles.zonePct}>{Math.round(pct * 100)}%</Text>
    </View>
  );
}

function summarizeZones(samples: HeartRateSample[]): { avg: number; easy: number; moderate: number; hard: number } {
  if (!samples.length) return { avg: 0, easy: 0, moderate: 0, hard: 0 };
  let easy = 0;
  let moderate = 0;
  let hard = 0;
  let total = 0;
  for (const s of samples) {
    total += s.bpm;
    if (s.bpm < 120) easy += 1;
    else if (s.bpm < 155) moderate += 1;
    else hard += 1;
  }
  const n = samples.length;
  return { avg: Math.round(total / n), easy: easy / n, moderate: moderate / n, hard: hard / n };
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + ' min';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tokens.color.background },
  content: { padding: tokens.space.lg, gap: tokens.space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: tokens.color.text },
  muted: { color: tokens.color.textMuted, fontSize: 13 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: tokens.space.md },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontWeight: '600', color: tokens.color.text },
  zones: { gap: tokens.space.sm, marginTop: tokens.space.md },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm },
  zoneLabel: { width: 72, color: tokens.color.textMuted, fontSize: 12 },
  zoneTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: tokens.color.surface },
  zoneFill: { height: 8, borderRadius: 4 },
  zonePct: { width: 40, textAlign: 'right', color: tokens.color.textMuted, fontSize: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: tokens.color.text, marginTop: tokens.space.lg },
  input: {
    minHeight: 96,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface,
    color: tokens.color.text,
    padding: tokens.space.md,
    textAlignVertical: 'top',
  },
  pending: { color: tokens.color.warning, fontSize: 12 },
  deleteButton: { marginTop: tokens.space.xl, alignItems: 'center', padding: tokens.space.md },
  deleteText: { color: tokens.color.danger, fontWeight: '600' },
});
`;

/* ---------- src/navigation/RootNavigator.tsx ---------- */
SRC.ROOT_NAV = `import React from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import type { LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useColorScheme } from 'react-native';
import { HomeScreen } from '../screens/HomeScreen';
import { ActivityDetailScreen } from '../screens/ActivityDetailScreen';
import { tokens } from '../theme/tokens';

export type RootStackParamList = {
  Home: undefined;
  ActivityDetail: { activityId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Deep links: pulse://activity/<id> from push notifications, https from the
// marketing site. Marketing has opinions about the URL scheme. Noted.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['pulse://', 'https://app.pulse.internal'],
  config: {
    screens: {
      Home: '',
      ActivityDetail: 'activity/:activityId',
    },
  },
};

export function RootNavigator(): JSX.Element {
  const scheme = useColorScheme();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: tokens.color.accent,
      background: tokens.color.background,
      card: tokens.color.surface,
      text: tokens.color.text,
    },
  };

  return (
    <NavigationContainer theme={theme} linking={linking}>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerShadowVisible: false,
          headerTintColor: tokens.color.text,
          headerStyle: { backgroundColor: tokens.color.background },
          contentStyle: { backgroundColor: tokens.color.background },
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Today' }} />
        <Stack.Screen
          name="ActivityDetail"
          component={ActivityDetailScreen}
          options={{ title: 'Workout', headerBackTitle: 'Today' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
`;

const support = [
  ['src/sync/mutation.queue.ts', 'MutationQueue', 'offline mutation queue'],
  ['src/sync/conflict.resolver.ts', 'ConflictResolver', 'conflict resolution'],
  ['src/api/client.ts', 'ApiClient', 'network retry'],
  ['src/state/store.ts', 'ActivityStore', 'activity state'],
  ['src/notifications/push.service.ts', 'PushService', 'push notification'],
  ['src/auth/biometric.service.ts', 'BiometricService', 'biometric session'],
  ['src/storage/checkpoint.store.ts', 'CheckpointStore', 'sync checkpoint'],
  ['src/telemetry/mobile.metrics.ts', 'MobileMetrics', 'mobile telemetry'],
].map(([path, name, subject], i) => [path, genLargeTsClass('export class ' + name + ' {\n}\n', name, subject,
  ['validate', 'normalize', 'persist', 'publish', 'reconcile', 'compact'], 180), i < 3]);

const files = [
  ['src/sync/sync.engine.ts', genLargeTsClass(SRC.SYNC_ENGINE, 'SyncEngine', 'offline sync', ['validateMutation', 'normalizeBatch', 'persistCheckpoint', 'publishDelta', 'reconcileConflict', 'compactQueue'], 1200), true],
  ['android/app/src/main/java/com/pulse/OfflineStoreModule.kt', genLargeKotlinClass(SRC.OFFLINE_STORE, 'OfflineStoreModule', 'offline store', ['validateRow', 'encodeRow', 'persistRow', 'evictStale', 'emitChange'], 650), true],
  ['src/screens/HomeScreen.tsx', SRC.HOME_SCREEN, true],
  ['src/screens/ActivityDetailScreen.tsx', SRC.ACTIVITY_DETAIL, true],
  ['src/navigation/RootNavigator.tsx', SRC.ROOT_NAV],
  ...support,
  ['ios/Pulse/OfflineStore.swift', genLargeSwiftClass('import Foundation\n\nfinal class OfflineStore {\n}\n', 'OfflineStore', 'offline persistence', ['validate', 'encode', 'persist', 'restore', 'compact'], 240), true],
  ['src/api/types.ts', 'export interface SyncCheckpoint { cursor: string; revision: number; syncedAt: string; }\nexport interface SyncResult { accepted: number; conflicts: number; checkpoint: SyncCheckpoint; }\nexport interface Activity { id: string; title: string; duration: number; pending: boolean; }\n'],
  ['src/theme/tokens.ts', "export const tokens = {\n  color: { background: '#111318', surface: '#20242c', text: '#f1f3f5', textMuted: '#9aa4b2', accent: '#71b7ff', warning: '#e6b85c', danger: '#ef767a' },\n  space: { sm: 8, md: 16, lg: 24, xl: 32 },\n  radius: { sm: 4, md: 8 }\n};\n"],
  ['src/sync/__tests__/sync.engine.spec.ts', genSpec('SyncEngine', '../sync.engine', ['queues mutations while offline', 'retries an expired connection', 'preserves ordering after reconnect', 'compacts acknowledged mutations'])],
  ['src/sync/__tests__/conflict.resolver.spec.ts', genSpec('ConflictResolver', '../conflict.resolver', ['keeps the newest revision', 'rejects missing checkpoints', 'merges disjoint fields'])],
  ['package.json', genPackageJson('pulse-mobile', '4.2.0', [['react', '^18.3.0'], ['react-native', '^0.75.0'], ['@react-navigation/native', '^6.1.0']], [['start','react-native start'], ['android','react-native run-android'], ['ios','react-native run-ios'], ['test','jest'], ['lint','eslint src']])],
  ['android/app/build.gradle.kts', 'plugins {\n  id("com.android.application")\n  id("org.jetbrains.kotlin.android")\n}\nandroid {\n  namespace = "com.pulse"\n  compileSdk = 35\n  defaultConfig {\n    applicationId = "com.pulse"\n    minSdk = 26\n    targetSdk = 35\n    versionCode = 42\n    versionName = "4.2.0"\n  }\n}\n'],
  ['ios/Podfile', "platform :ios, '15.0'\nrequire_relative '../node_modules/react-native/scripts/react_native_pods'\ntarget 'Pulse' do\n  config = use_native_modules!\n  use_react_native!(:path => config[:reactNativePath])\nend\n"],
  ['metro.config.js', "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), {});\n"],
  ['tsconfig.json', genTsconfig()],
  ['.gitignore', genGitignore('mobile')],
  ['README.md', genReadme('pulse-mobile', 'Activity tracking with offline sync, native storage and push notifications.', ['React Native', 'Kotlin Android module', 'Swift iOS module'])],
];

PROFILES.register(makeProfile({
  id: 'mobile', label: 'Mobile development', stack: 'React Native · Kotlin · Swift',
  desc: 'Android and iOS: offline sync, activity screens, native storage, push and biometrics.',
  project: 'pulse-mobile', version: '4.2.0', primaryLang: 'ts', checker: 'tsc', pkg: 'npm',
  build: 'cd android && ./gradlew assembleDebug', test: 'npm test', lint: 'npm run lint', dev: 'npx react-native start',
  ports: [[8081, 'Metro bundler', 'node'], [5037, 'Android debug bridge', 'adb']],
  jobs: ['metro', 'gradle', 'xcodebuild', 'pod', 'adb', 'detox', 'fastlane', 'jest', 'typecheck', 'eslint'],
  suites: [['src/sync/__tests__/sync.engine.spec.ts', 16, 16], ['src/sync/__tests__/conflict.resolver.spec.ts', 9, 9]],
  debug: {conf: 'Android · Hermes', vars: [['queue.length','14'], ['isOnline','false'], ['lastRevision','402']], watch: [['pendingMutations','14'], ['retryBudget','3']], stack: ['SyncEngine.flush  sync.engine.ts:58', 'NetInfo.listener  network.ts:31']},
}, files));
})();
