import * as vscode from 'vscode';
import { io, Socket } from 'socket.io-client';
import * as os from 'os';
import * as path from 'path';
import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);

interface Command {
  id: string;
  agentId: string;
  text: string;
  machine?: string;
  repoPath?: string;
}

interface Agent {
  id: string;
  machine: string;
  repoPath: string;
}

let socket: Socket | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// Agent type (claude or gridlight) — read from config
let agentType: 'claude' | 'gridlight' = 'claude';
let registeredAgentId: string | null = null;

// All discovered agent-related commands
let discoveredCommands: string[] = [];
let autoApproveInFlight = false;
let queuedAutoApprove = 0;

// Gridlight heartbeat & idle reporting
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let gridlightIdleTimer: ReturnType<typeof setTimeout> | null = null;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('NeonCore');
  log('Extension activating...');

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'neoncore.connect';
  updateStatusBar(false);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem, outputChannel);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('neoncore.connect', () => connectToOrchestrator()),
    vscode.commands.registerCommand('neoncore.disconnect', () => disconnectFromOrchestrator()),
  );

  // Read agent type from config
  const config = vscode.workspace.getConfiguration('neoncore');
  agentType = config.get('agentType', 'claude') as 'claude' | 'gridlight';

  // If agentType is 'gridlight', the Gridlight extension handles NeonCore natively
  // (programmatic command injection, activity reporting, permissions).
  // This extension should only connect for 'claude' to avoid double command delivery.
  if (agentType === 'gridlight') {
    log('Agent type is gridlight — deferring to Gridlight extension for NeonCore integration');
    statusBarItem.text = '$(plug) NeonCore → Gridlight';
    statusBarItem.tooltip = 'NeonCore: Managed by Gridlight extension';
    return;
  }

  // Discover agent extension commands
  discoverAgentCommands();

  // Auto-connect if configured
  if (config.get('autoConnect', true)) {
    connectToOrchestrator();
  }
}

async function discoverAgentCommands() {
  try {
    const allCommands = await vscode.commands.getCommands(true);
    discoveredCommands = allCommands.filter((c) => {
      const lower = c.toLowerCase();
      if (agentType === 'gridlight') {
        return lower.includes('gridlight') || lower.includes('gl-');
      }
      return lower.includes('claude') || lower.includes('cline');
    });
    const label = agentType === 'gridlight' ? 'Gridlight' : 'Claude';
    if (discoveredCommands.length > 0) {
      log(`Discovered ${discoveredCommands.length} ${label} commands:`);
      for (const cmd of discoveredCommands) {
        log(`  - ${cmd}`);
      }
    } else {
      log(`No ${label} commands found in this VS Code instance`);
    }
  } catch {
    log('Could not discover commands');
  }
}

async function focusAgentPanel(): Promise<void> {
  const focusCmds = discoveredCommands.filter((c) => {
    const lower = c.toLowerCase();
    return lower.includes('focus') && !lower.includes('new') && !lower.includes('open');
  });

  for (const cmd of focusCmds) {
    try {
      await vscode.commands.executeCommand(cmd);
      return;
    } catch {
      // try next
    }
  }

  // Type-specific fallbacks
  if (agentType === 'gridlight') {
    try {
      await vscode.commands.executeCommand('workbench.action.focusSideBar');
    } catch {
      // ignore
    }
  } else {
    try {
      await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      } catch {
        // ignore
      }
    }
  }
}

function getAutoApproveCommands(): string[] {
  const typeToken = agentType === 'gridlight' ? 'gridlight' : 'claude';
  return discoveredCommands.filter((cmd) => {
    const lower = cmd.toLowerCase();
    const mentionsPlan = lower.includes('plan');
    const mentionsApproval = lower.includes('approve') || lower.includes('accept') || lower.includes('confirm') || lower.includes('continue') || lower.includes('proceed');
    if (mentionsPlan && mentionsApproval) return true;
    if (lower.includes(typeToken) && mentionsApproval && !lower.includes('reject') && !lower.includes('deny')) return true;
    return false;
  });
}

async function runAutoApproveCommands(): Promise<boolean> {
  const commands = getAutoApproveCommands();
  if (commands.length === 0) return false;

  for (const cmd of commands) {
    try {
      await vscode.commands.executeCommand(cmd);
      log(`Auto-approve: executed ${agentType} command "${cmd}"`);
      await sleep(150);
    } catch {
      // keep trying remaining candidates
    }
  }
  return true;
}

async function pasteAndEnter(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  await focusAgentPanel();
  await sleep(250);

  if (process.platform === 'darwin') {
    // Paste first
    await execAsync(
      `osascript` +
      ` -e 'tell application "System Events"'` +
      ` -e '  keystroke "v" using command down'` +
      ` -e 'end tell'`
    );
    await sleep(300);
    // Re-focus then Enter (separate call ensures correct focus target)
    await focusAgentPanel();
    await sleep(300);
    await execAsync(
      `osascript` +
      ` -e 'tell application "System Events"'` +
      ` -e '  key code 36'` +
      ` -e 'end tell'`
    );
    return;
  }

  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  await sleep(180);

  if (process.platform === 'win32') {
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`;
    await execAsync(`powershell -Command "${psScript}"`);
  } else {
    await vscode.commands.executeCommand('default:type', { text: '\n' });
  }
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

function getLocalIdentity() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  let repoPath = workspaceFolder?.uri.fsPath || '';

  // Resolve to git root so subfolders don't create separate agents
  if (repoPath) {
    try {
      repoPath = execSync('git rev-parse --show-toplevel', {
        cwd: repoPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Not a git repo — keep the workspace folder path
    }
  }

  return {
    repoPath,
    machine: os.hostname(),
  };
}

function connectToOrchestrator() {
  const config = vscode.workspace.getConfiguration('neoncore');
  const url = config.get('orchestratorUrl', 'http://localhost:4040');

  if (socket?.connected) {
    vscode.window.showInformationMessage('Already connected to NeonCore orchestrator');
    return;
  }

  socket = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 5000,
  });

  socket.on('connect', () => {
    log('Connected to orchestrator');
    updateStatusBar(true);

    // Join room immediately using local identity (no HTTP dependency)
    const { machine, repoPath } = getLocalIdentity();
    socket!.emit('register_extension', { machine, repoPath, agentType });
    log(`Registered socket with machine=${machine}, repoPath=${repoPath}, agentType=${agentType}`);

    // Also do HTTP registration for agent metadata (async, non-blocking)
    registerWithOrchestrator();
    vscode.window.showInformationMessage(`NeonCore: Connected to orchestrator at ${url}`);
  });

  socket.on('disconnect', () => {
    log('Disconnected from orchestrator');
    updateStatusBar(false);
  });

  // Listen for commands — validate this command is targeted at our registered agent
  socket.on('command_send', (command: Command) => {
    if (registeredAgentId && command.agentId !== registeredAgentId) {
      log(`Ignoring command for agent ${command.agentId} (we are ${registeredAgentId})`);
      return;
    }
    log(`Command received: agent=${command.agentId}, text="${command.text.slice(0, 80)}"`);
    handleCommand(command);
  });

  // Listen for focus requests — bring this VS Code window to front
  socket.on('focus_window' as any, () => {
    log('Focus window request received');
    bringWindowToFront();
  });

  // Two-phase plan auto-approve:
  // Phase 1: dashboard approved the plan → arm the extension
  socket.on('auto_approve_plan' as any, (data: { agentId: string }) => {
    log(`Phase 1: auto_approve_plan for agent ${data.agentId} — arming`);
    armPlanAutoApprove();
  });

  // Phase 2: ExitPlanMode tool finished executing → trigger with precise timing
  socket.on('plan_executed' as any, (data: { agentId: string }) => {
    log(`Phase 2: plan_executed for agent ${data.agentId} — triggering`);
    triggerPlanAutoApprove();
  });

  socket.on('connect_error', (err) => {
    log(`Connection error: ${err.message}`);
    updateStatusBar(false);
  });
}

function disconnectFromOrchestrator() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (gridlightIdleTimer) { clearTimeout(gridlightIdleTimer); gridlightIdleTimer = null; }
  registeredAgentId = null;
  if (socket) {
    socket.disconnect();
    socket = null;
    updateStatusBar(false);
    vscode.window.showInformationMessage('NeonCore: Disconnected from orchestrator');
  }
}

function updateStatusBar(connected: boolean) {
  if (connected) {
    statusBarItem.text = '$(plug) NeonCore';
    statusBarItem.tooltip = 'Connected to NeonCore orchestrator';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(debug-disconnect) NeonCore';
    statusBarItem.tooltip = 'Disconnected from NeonCore orchestrator (click to connect)';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

function registerWithOrchestrator() {
  const config = vscode.workspace.getConfiguration('neoncore');
  const url = config.get('orchestratorUrl', 'http://localhost:4040');
  const { repoPath, machine } = getLocalIdentity();
  const repoName = repoPath ? path.basename(repoPath) : '';

  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    // Not a git repo or git not available
  }

  fetch(`${url}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${machine}/${repoName}`,
      machine,
      repoPath,
      repoName,
      branch,
      sessionId: `vscode-${vscode.env.sessionId}`,
      agentType,
    }),
  })
    .then((res) => res.json())
    .then((agent: Agent) => {
      registeredAgentId = agent.id;
      log(`Registered as ${agentType} agent: ${agent.id}`);
      // Join the agent-specific room now that we know our agent ID (closes race condition)
      if (socket?.connected) {
        socket.emit('join_agent_room', { agentId: agent.id });
        log(`Joined agent room agent:${agent.id}`);
      }
      // Auto-focus Claude sidebar so it's ready for commands
      focusAgentPanel();
      // Drain any commands queued while we were offline
      drainPendingCommands(url, agent.id);
      // Start heartbeat for Gridlight agents (they lack hooks to keep last_seen fresh)
      if (agentType === 'gridlight') {
        startHeartbeat(url);
      }
    })
    .catch((err) => {
      log(`Registration failed: ${err}`);
    });
}

async function bringWindowToFront() {
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';

  // Only use AppleScript on macOS
  if (process.platform !== 'darwin') {
    log(`Skipping window raise (not macOS)`);
    return;
  }

  try {
    await execAsync(`open -a "Visual Studio Code"`);
    await sleep(400);

    await execAsync(
      `osascript` +
      ` -e 'tell application "System Events"'` +
      ` -e '  tell process "Code"'` +
      ` -e '    repeat with w in (every window)'` +
      ` -e '      if title of w contains "${workspaceName}" then'` +
      ` -e '        perform action "AXRaise" of w'` +
      ` -e '        exit repeat'` +
      ` -e '      end if'` +
      ` -e '    end repeat'` +
      ` -e '    set frontmost to true'` +
      ` -e '  end tell'` +
      ` -e 'end tell'`
    );
    log(`Brought window "${workspaceName}" to front`);
  } catch (err) {
    log(`bringWindowToFront failed: ${err}`);
  }
}

async function handleCommand(command: Command) {
  const config = vscode.workspace.getConfiguration('neoncore');
  const url = config.get('orchestratorUrl', 'http://localhost:4040');

  log(`Handling command: "${command.text.slice(0, 120)}"`);

  try {
    // Step 1: Copy prompt to clipboard
    await vscode.env.clipboard.writeText(command.text);
    markDelivered(url, command.id);

    // Step 2: Focus the agent panel (within THIS window's extension host)
    await focusAgentPanel();

    // Step 3: Raise window and paste + submit (platform-specific)
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
    try {
      if (process.platform === 'darwin') {
        // macOS: Use AppleScript for window raising and keystroke simulation
        await execAsync(`open -a "Visual Studio Code"`);
        await sleep(500);

        // Raise the specific window matching this workspace
        await execAsync(
          `osascript` +
          ` -e 'tell application "System Events"'` +
          ` -e '  tell process "Code"'` +
          ` -e '    repeat with w in (every window)'` +
          ` -e '      if title of w contains "${workspaceName}" then'` +
          ` -e '        perform action "AXRaise" of w'` +
          ` -e '        exit repeat'` +
          ` -e '      end if'` +
          ` -e '    end repeat'` +
          ` -e '    set frontmost to true'` +
          ` -e '  end tell'` +
          ` -e 'end tell'`
        );
        log(`Raised window matching "${workspaceName}"`);
        await sleep(500);

        // Re-focus agent input after window raise
        await focusAgentPanel();
        await sleep(500);

        // Paste via AppleScript (separate from Enter to allow refocus between)
        await execAsync(
          `osascript` +
          ` -e 'tell application "System Events"'` +
          ` -e '  keystroke "v" using command down'` +
          ` -e 'end tell'`
        );
        log(`Pasted command text (${command.text.length} chars)`);

        // Wait for paste to render in the input field
        const delayMs = Math.min(500 + Math.floor(command.text.length / 2), 3000);
        await sleep(delayMs);

        // Re-focus agent panel before Enter — critical for step 2+ commands
        // where Claude Code just finished processing and focus may have shifted
        await focusAgentPanel();
        await sleep(400);

        // Send Enter as separate AppleScript call
        await execAsync(
          `osascript` +
          ` -e 'tell application "System Events"'` +
          ` -e '  key code 36'` +
          ` -e 'end tell'`
        );
        log(`Sent Enter keystroke — command submitted`);
      } else {
        // Windows/Linux: Use VSCode commands (clipboard already has the text)
        await sleep(300);

        // Re-focus agent input
        await focusAgentPanel();
        await sleep(500);

        // Trigger paste via VSCode command
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        const delaySec = Math.min(500 + command.text.length / 100, 3000);
        await sleep(delaySec);

        // Submit using PowerShell SendKeys on Windows
        if (process.platform === 'win32') {
          const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`;
          await execAsync(`powershell -Command "${psScript}"`);
          log(`Submitted via PowerShell SendKeys (Windows)`);
        } else {
          // Linux fallback
          await vscode.commands.executeCommand('default:type', { text: '\n' });
          log(`Submitted via type command (Linux)`);
        }
      }
    } catch (err) {
      log(`Keystroke simulation failed: ${err}`);
      const preview = command.text.length > 80 ? command.text.slice(0, 80) + '...' : command.text;
      vscode.window.showInformationMessage(
        `NeonCore: Prompt copied — paste with Cmd+V: "${preview}"`
      );
    }

    // For Gridlight agents: mark as working and schedule idle report
    if (agentType === 'gridlight' && registeredAgentId) {
      fetch(`${url}/api/agents/${registeredAgentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'working' }),
      }).catch(() => {});
      scheduleIdleReport(url);
    }
  } catch (err) {
    log(`handleCommand error: ${err}`);
    vscode.window.showErrorMessage(`NeonCore: Failed to deliver command - ${err}`);
  }
}

// ─── Two-phase plan auto-approve ─────────────────────
// Phase 1 (auto_approve_plan): fires when dashboard approves the plan → arms the extension
// Phase 2 (plan_executed): fires when ExitPlanMode tool finishes → triggers keystroke after
//   a short delay for Claude to generate its follow-up prompt
// Fallback: if plan_executed never arrives within 15s, proceed anyway with longer delay

let pendingPlanAutoApprove = false;
let planAutoApproveFallbackTimer: ReturnType<typeof setTimeout> | null = null;

const AUTO_APPROVE_POST_EXEC_DELAY_MS = 5000; // delay after ExitPlanMode completes
const AUTO_APPROVE_FALLBACK_DELAY_MS = 8000;   // delay if we never get plan_executed
const AUTO_APPROVE_FALLBACK_TIMEOUT_MS = 15000; // how long to wait for plan_executed
const AUTO_APPROVE_RETRY_INTERVAL_MS = 2000;
const AUTO_APPROVE_MAX_ATTEMPTS = 8;

function armPlanAutoApprove() {
  if (pendingPlanAutoApprove) {
    log('Auto-approve already armed');
    return;
  }
  pendingPlanAutoApprove = true;
  log(`Auto-approve armed — waiting up to ${AUTO_APPROVE_FALLBACK_TIMEOUT_MS}ms for plan_executed signal`);

  // Fallback: if PostToolUse signal never arrives, execute with a longer delay
  if (planAutoApproveFallbackTimer) clearTimeout(planAutoApproveFallbackTimer);
  planAutoApproveFallbackTimer = setTimeout(() => {
    if (pendingPlanAutoApprove) {
      pendingPlanAutoApprove = false;
      log('Auto-approve fallback: plan_executed not received, proceeding with longer delay');
      void executeAutoApprove(AUTO_APPROVE_FALLBACK_DELAY_MS);
    }
  }, AUTO_APPROVE_FALLBACK_TIMEOUT_MS);
}

function triggerPlanAutoApprove() {
  if (!pendingPlanAutoApprove) {
    log('plan_executed received but no pending auto-approve — ignoring');
    return;
  }
  pendingPlanAutoApprove = false;
  if (planAutoApproveFallbackTimer) {
    clearTimeout(planAutoApproveFallbackTimer);
    planAutoApproveFallbackTimer = null;
  }
  log(`plan_executed received — executing auto-approve after ${AUTO_APPROVE_POST_EXEC_DELAY_MS}ms`);
  void executeAutoApprove(AUTO_APPROVE_POST_EXEC_DELAY_MS);
}

async function executeAutoApprove(initialDelayMs: number) {
  if (autoApproveInFlight) {
    queuedAutoApprove += 1;
    log(`Auto-approve already running; queued another request (queue=${queuedAutoApprove})`);
    return;
  }

  autoApproveInFlight = true;
  let succeeded = false;
  try {
    await discoverAgentCommands();

    log(`Auto-approve: raising window and waiting ${initialDelayMs}ms`);
    await bringWindowToFront();
    await sleep(initialDelayMs);

    for (let attempt = 1; attempt <= AUTO_APPROVE_MAX_ATTEMPTS; attempt += 1) {
      log(`Auto-approve attempt ${attempt}/${AUTO_APPROVE_MAX_ATTEMPTS}`);

      if (attempt > 1) {
        await discoverAgentCommands();
      }

      const ranCommand = await runAutoApproveCommands();
      if (ranCommand) {
        log('Auto-approve command(s) executed; stopping retry loop');
        succeeded = true;
        break;
      }

      await focusAgentPanel();
      await sleep(300);

      const tokens = attempt <= 2 ? ['yes', 'approve'] : ['yes'];
      for (const token of tokens) {
        try {
          await pasteAndEnter(token);
          log(`Auto-approve: submitted "${token}"`);
          succeeded = true;
        } catch (err) {
          log(`Auto-approve token "${token}" failed: ${err}`);
        }
      }

      if (succeeded) break;

      if (attempt < AUTO_APPROVE_MAX_ATTEMPTS) {
        await sleep(AUTO_APPROVE_RETRY_INTERVAL_MS);
      }
    }

    if (!succeeded) {
      log('Auto-approve: all attempts failed — showing notification');
      vscode.window.showInformationMessage(
        `NeonCore: Plan approved on dashboard — please confirm in ${agentType === 'gridlight' ? 'Gridlight' : 'Claude Code'}`,
        'OK'
      );
    }
  } catch (err) {
    log(`executeAutoApprove failed: ${err}`);
    vscode.window.showInformationMessage(
      `NeonCore: Plan approved on dashboard — please confirm in ${agentType === 'gridlight' ? 'Gridlight' : 'Claude Code'}`,
      'OK'
    );
  } finally {
    autoApproveInFlight = false;
    if (queuedAutoApprove > 0) {
      queuedAutoApprove -= 1;
      setTimeout(() => {
        void executeAutoApprove(AUTO_APPROVE_POST_EXEC_DELAY_MS);
      }, 50);
    }
  }
}

// ─── Gridlight heartbeat & idle reporting ─────────

function startHeartbeat(url: string) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    if (!registeredAgentId) return;
    try {
      await fetch(`${url}/api/agents/${registeredAgentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch { /* silent */ }
  }, 30_000);
  log('Gridlight heartbeat started (30s interval)');
}

function scheduleIdleReport(url: string) {
  if (gridlightIdleTimer) clearTimeout(gridlightIdleTimer);
  gridlightIdleTimer = setTimeout(async () => {
    if (!registeredAgentId) return;
    const { machine, repoPath } = getLocalIdentity();
    try {
      await fetch(`${url}/api/agents/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine, repoPath, agentType: 'gridlight',
          message: '(Gridlight agent task completed)',
        }),
      });
      log('Gridlight idle report sent');
    } catch { /* silent */ }
  }, 60_000);
}

// ─── Helpers ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainPendingCommands(url: string, agentId: string) {
  try {
    const res = await fetch(`${url}/api/commands/pending/${agentId}`);
    const commands = await res.json() as Command[];
    if (commands.length > 0) {
      log(`Draining ${commands.length} pending command(s) queued while offline`);
      for (const cmd of commands) {
        await handleCommand(cmd);
      }
    }
  } catch (err) {
    log(`drainPendingCommands failed: ${err}`);
  }
}

function markDelivered(url: string, commandId: string) {
  fetch(`${url}/api/commands/delivered/${commandId}`, {
    method: 'POST',
  }).catch((err) => {
    log(`markDelivered failed: ${err}`);
  });
}

export function deactivate() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (gridlightIdleTimer) { clearTimeout(gridlightIdleTimer); gridlightIdleTimer = null; }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
