import React, { useEffect, useState } from 'react';
import { View, StyleSheet, StatusBar, ActivityIndicator, SafeAreaView, Platform } from 'react-native';
import { theme } from './src/theme';
import { loadServers, saveServers, type ServerEntry } from './src/config';
import { registerForPush, usePushNavigation } from './src/push';
import { api } from './src/api';
import { useUpdates } from './src/ota';
import { NeonCoreProvider } from './src/NeonCoreProvider';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { NeedsYouScreen, type FeatureRef } from './src/screens/NeedsYouScreen';
import { ProjectsScreen, type ProjectRef } from './src/screens/ProjectsScreen';
import { ProjectScreen } from './src/screens/ProjectScreen';
import { FeatureScreen } from './src/screens/FeatureScreen';
import { InProgressScreen } from './src/screens/InProgressScreen';
import { AgentsScreen } from './src/screens/AgentsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { CartridgeDetailScreen } from './src/screens/CartridgeDetailScreen';
import { ProjectMemoryScreen } from './src/screens/ProjectMemoryScreen';
import { WorkflowRunDetailScreen } from './src/screens/WorkflowRunDetailScreen';
import { TabBar, type TabName } from './src/components/TabBar';
import { BrandHeader } from './src/components/BrandHeader';
import type { Agent, Workflow } from './src/types';

/**
 * The phone keeps the ball rolling on projects under way: four tabs (Needs you · Projects ·
 * In progress · Settings) and the screens they open on top — a project, a feature, a run, a
 * cartridge. A pushed screen remembers the route it came from, so Back returns there.
 */
type Route =
  | { name: TabName }
  | { name: 'project'; project: ProjectRef; from: Route }
  | { name: 'feature'; feature: FeatureRef; from: Route }
  | { name: 'workflowRun'; run: Workflow; from: Route }
  | { name: 'agent'; agent: Agent; from: Route }
  | { name: 'memory'; project: string; agent: Agent; from: Route };

/** Screens that own the whole surface: no brand bar, no tab bar, their own back control. */
export const PUSHED: Route['name'][] = ['project', 'feature', 'workflowRun', 'agent', 'memory'];
const isTab = (r: Route): r is { name: TabName } => !PUSHED.includes(r.name);
/** The tab a route belongs to — the one lit while a pushed screen is open under it. */
const tabOf = (r: Route): TabName => (isTab(r) ? r.name : tabOf((r as { from: Route }).from));

export default function App() {
  const [booting, setBooting] = useState(true);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [route, setRoute] = useState<Route>({ name: 'needs' });

  // loadServers migrates a pre-federation install (a single stored URL) on first run.
  useEffect(() => {
    loadServers().then((list) => { setServers(list); setBooting(false); });
  }, []);

  // The server this phone was set up with: push, deep links and updates come from it.
  const serverUrl = servers[0]?.url ?? null;
  const serverToken = servers[0]?.token ?? null;

  useEffect(() => { if (serverUrl) registerForPush(serverUrl); }, [serverUrl]);
  // Over-the-air updates: newer JavaScript published on the server, used from the next launch.
  useUpdates(serverUrl, serverToken);

  const push = (next: (from: Route) => Route) => setRoute((cur) => next(cur));
  const back = () => setRoute((cur) => (isTab(cur) ? cur : (cur as { from: Route }).from));
  const openFeature = (feature: FeatureRef) => push((from) => ({ name: 'feature', feature, from }));
  const openRunById = (base: string, workflowId: string) => {
    api.getWorkflowV2(base, workflowId).then((data) => push((from) => ({ name: 'workflowRun', run: data.workflow, from }))).catch(() => {});
  };

  // A push opens its run; an approval push opens Needs you, where permission requests are.
  usePushNavigation(serverUrl, {
    onOpenWorkflow: (workflowId) => { if (serverUrl) openRunById(serverUrl, workflowId); },
    onOpenApprovals: () => setRoute({ name: 'needs' }),
  });

  return (
    // Two stacked SafeAreaViews so the top and bottom insets take different colours: the
    // bottom strip matches the tab bar, which then reads as running to the screen edge.
    <>
      <SafeAreaView style={styles.safeTop} />
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
        {booting ? (
          <View style={styles.center}><ActivityIndicator color={theme.accent} /></View>
        ) : servers.length === 0 ? (
          <ConnectScreen
            onConnected={(url) => {
              const first: ServerEntry[] = [{ url, name: url.replace(/^https?:\/\//, ''), serverId: '', token: null, manual: true }];
              setServers(first);
              saveServers(first).catch(() => {});
              setRoute({ name: 'needs' });
            }}
          />
        ) : (
          <NeonCoreProvider servers={servers} onServersChange={setServers}>
            {isTab(route) && <BrandHeader />}
            <View style={styles.body}>
              {route.name === 'needs' && <NeedsYouScreen onOpenFeature={openFeature} onOpenRun={openRunById} />}
              {route.name === 'projects' && <ProjectsScreen onOpen={(project) => push((from) => ({ name: 'project', project, from }))} />}
              {route.name === 'agents' && <AgentsScreen onOpenAgent={(agent) => push((from) => ({ name: 'agent', agent, from }))} />}
              {route.name === 'progress' && <InProgressScreen onOpenFeature={openFeature} />}
              {route.name === 'settings' && <SettingsScreen />}
              {route.name === 'project' && <ProjectScreen project={route.project} onBack={back} onOpenFeature={openFeature} />}
              {route.name === 'feature' && <FeatureScreen feature={route.feature} onBack={back} onOpenRun={openRunById} />}
              {route.name === 'workflowRun' && <WorkflowRunDetailScreen run={route.run} onBack={back} />}
              {route.name === 'agent' && (
                <CartridgeDetailScreen agent={route.agent} onBack={back}
                  onOpenMemory={(project) => push((from) => ({ name: 'memory', project, agent: route.agent, from }))} />
              )}
              {route.name === 'memory' && <ProjectMemoryScreen project={route.project} onBack={back} />}
            </View>
            {isTab(route) && <TabBar active={tabOf(route)} onSelect={(t) => setRoute({ name: t })} />}
          </NeonCoreProvider>
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeTop: { flex: 0, backgroundColor: theme.bg },
  safe: { flex: 1, backgroundColor: theme.bgElevated, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  body: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
});
