import React, { useEffect, useState } from 'react';
import { View, StyleSheet, StatusBar, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { theme } from './src/theme';
import { loadServers, saveServers, type ServerEntry } from './src/config';
import { registerForPush, usePushNavigation } from './src/push';
import { api } from './src/api';
import { NeonCoreProvider } from './src/NeonCoreProvider';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { CartridgeListScreen } from './src/screens/CartridgeListScreen';
import { CartridgeDetailScreen } from './src/screens/CartridgeDetailScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { QueueScreen } from './src/screens/QueueScreen';
import { WorkflowsScreen } from './src/screens/WorkflowsScreen';
import { WorkflowRunDetailScreen } from './src/screens/WorkflowRunDetailScreen';
import { GoalsScreen } from './src/screens/GoalsScreen';
import { GoalDetailScreen } from './src/screens/GoalDetailScreen';
import { TasksScreen } from './src/screens/TasksScreen';
import { TabBar, MORE_TABS, type TabName, type PrimaryTab } from './src/components/TabBar';
import { TokensScreen } from './src/screens/TokensScreen';
import { ProjectMemoryScreen } from './src/screens/ProjectMemoryScreen';
import { MoreSheet } from './src/components/MoreSheet';
import { BrandHeader } from './src/components/BrandHeader';
import type { Agent, Goal, Workflow } from './src/types';

type Route =
  | { name: 'list' }
  | { name: 'detail'; agent: Agent }
  | { name: 'approvals' }
  | { name: 'workflows' }
  | { name: 'queue' }
  | { name: 'goals' }
  | { name: 'goalDetail'; goal: Goal }
  | { name: 'memory'; project: string; agent: Agent }
  | { name: 'tasks' }
  | { name: 'tokens' }
  | { name: 'workflowRun'; run: Workflow };

/**
 * Screens that own the whole surface: no brand bar, no tab bar, their own back control.
 *
 * A list rather than two inline comparisons repeated in two places — those had to agree,
 * and a third pushed screen is exactly the moment one of them gets forgotten and a detail
 * screen renders with a tab bar under it.
 */
const PUSHED: Route['name'][] = ['detail', 'workflowRun', 'goalDetail', 'memory'];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  // Sheet visibility is route-adjacent but not a ROUTE: opening More must not become a back
  // destination, and closing it must not navigate anywhere.
  const [moreOpen, setMoreOpen] = useState(false);

  // loadServers migrates a pre-federation install (a single stored URL) on first run, so
  // upgrading never drops the server this phone was already set up with.
  useEffect(() => {
    loadServers().then((list) => {
      setServers(list);
      setBooting(false);
    });
  }, []);

  // The server this phone was set up with. Push registration and deep links are
  // single-server concerns — a notification arrives from one machine, not the fleet.
  const serverUrl = servers[0]?.url ?? null;

  // Once we know the server, register this device for push so it can tell us when a
  // workflow finishes. Idempotent server-side, so re-running on url change is fine.
  useEffect(() => {
    if (serverUrl) registerForPush(serverUrl);
  }, [serverUrl]);

  // Tapping a push deep-links to the right place: workflow/decision pushes open that run,
  // approval pushes open the Approvals screen.
  usePushNavigation(serverUrl, {
    onOpenWorkflow: (workflowId) => {
      if (!serverUrl) return;
      api.getWorkflowV2(serverUrl, workflowId)
        .then((data) => setRoute({ name: 'workflowRun', run: data.workflow }))
        .catch(() => {});
    },
    onOpenApprovals: () => setRoute({ name: 'approvals' }),
  });

  return (
    // Two stacked SafeAreaViews so the top and bottom insets can be painted
    // different colors. The bottom strip (home indicator) takes the SAME color as
    // the tab bar / input bar, so those bars read as running to the screen edge
    // instead of floating above a band of page background.
    // (react-native-safe-area-context would be the tidier tool. The original reason
    // for avoiding it — keeping this pure JS so it could ship over EAS Update — died
    // with the Expo eject; there are no OTA updates now, so adding the dependency is
    // a normal call to make rather than something the release path forbids.)
    <>
      <SafeAreaView style={styles.safeTop} />
      <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
      {booting ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : servers.length === 0 ? (
        <ConnectScreen
          onConnected={(url) => {
            const first: ServerEntry[] = [{ url, name: url.replace(/^https?:\/\//, ''), serverId: '', token: null, manual: true }];
            setServers(first);
            saveServers(first).catch(() => {});
            setRoute({ name: 'list' });
          }}
        />
      ) : (
        <NeonCoreProvider servers={servers} onServersChange={setServers}>
          {/* Persistent brand bar on the tab screens (pushed detail screens own their surface). */}
          {!PUSHED.includes(route.name) && <BrandHeader />}
          <View style={styles.body}>
            {route.name === 'list' && (
              <CartridgeListScreen onOpen={(agent) => setRoute({ name: 'detail', agent })} />
            )}
            {route.name === 'detail' && (
              <CartridgeDetailScreen
                agent={route.agent}
                onBack={() => setRoute({ name: 'list' })}
                onOpenMemory={(project) => setRoute({ name: 'memory', project, agent: route.agent })}
              />
            )}
            {route.name === 'memory' && (
              <ProjectMemoryScreen
                project={route.project}
                onBack={() => setRoute({ name: 'detail', agent: route.agent })}
              />
            )}
            {route.name === 'approvals' && <ApprovalsScreen />}
            {route.name === 'workflows' && (
              <WorkflowsScreen onOpenRun={(run) => setRoute({ name: 'workflowRun', run })} />
            )}
            {route.name === 'queue' && <QueueScreen />}
            {route.name === 'goals' && (
              <GoalsScreen onOpen={(goal) => setRoute({ name: 'goalDetail', goal })} />
            )}
            {route.name === 'goalDetail' && (
              <GoalDetailScreen goal={route.goal} onBack={() => setRoute({ name: 'goals' })} />
            )}
            {route.name === 'tasks' && <TasksScreen />}
            {route.name === 'tokens' && <TokensScreen />}
            {route.name === 'workflowRun' && (
              <WorkflowRunDetailScreen run={route.run} onBack={() => setRoute({ name: 'workflows' })} />
            )}
          </View>

          {/* The More pile. A sheet rather than an overflow menu because this file's tab bar
              already learned that a destination you cannot READ is one nobody opens. */}
          <MoreSheet
            open={moreOpen}
            active={route.name as TabName}
            items={MORE_TABS}
            onSelect={(t) => { setMoreOpen(false); setRoute({ name: t } as Route); }}
            onClose={() => setMoreOpen(false)}
          />

          {!PUSHED.includes(route.name) && (
            <TabBar
              active={route.name as TabName}
              onSelect={(t: PrimaryTab) => {
                if (t === 'more') { setMoreOpen(true); return; }
                setMoreOpen(false);
                setRoute({ name: t } as Route);
              }}
            />
          )}
        </NeonCoreProvider>
      )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  // Takes only the top inset (flex:0), painted in the page background.
  safeTop: { flex: 0, backgroundColor: theme.bg },
  // Takes the rest. Its bottom inset padding is painted in the bar color, which is
  // what closes the gap under the tab bar / input bar.
  safe: {
    flex: 1,
    backgroundColor: theme.bgElevated,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  // The page itself keeps the normal background; only the inset strip is elevated.
  body: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
});
