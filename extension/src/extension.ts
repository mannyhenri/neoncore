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

// All discovered Claude-related commands
let claudeCommands: string[] = [];

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

  // Discover Claude Code extension commands
  discoverClaudeCommands();

  // Auto-connect if configured
  const config = vscode.workspace.getConfiguration('neoncore');
  if (config.get('autoConnect', true)) {
    connectToOrchestrator();
  }
}

async function discoverClaudeCommands() {
  try {
    const allCommands = await vscode.commands.getCommands(true);
    // Log ALL claude-related commands for debugging
    claudeCommands = allCommands.filter((c) => {
      const lower = c.toLowerCase();
      return lower.includes('claude') || lower.includes('cline');
    });
    if (claudeCommands.length > 0) {
      log(`Discovered ${claudeCommands.length} Claude commands:`);
      for (const cmd of claudeCommands) {
        log(`  - ${cmd}`);
      }
    } else {
      log('No Claude commands found in this VS Code instance');
    }
  } catch {
    log('Could not discover commands');
  }
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

function getLocalIdentity() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return {
    repoPath: workspaceFolder?.uri.fsPath || '',
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
    socket!.emit('register_extension', { machine, repoPath });
    log(`Registered socket with machine=${machine}, repoPath=${repoPath}`);

    // Also do HTTP registration for agent metadata (async, non-blocking)
    registerWithOrchestrator();
    vscode.window.showInformationMessage(`NeonCore: Connected to orchestrator at ${url}`);
  });

  socket.on('disconnect', () => {
    log('Disconnected from orchestrator');
    updateStatusBar(false);
  });

  // Listen for commands — only received if we're in the correct agent room
  socket.on('command_send', (command: Command) => {
    log(`Command received: agent=${command.agentId}, text="${command.text.slice(0, 80)}"`);
    handleCommand(command);
  });

  // Listen for focus requests — bring this VS Code window to front
  socket.on('focus_window' as any, () => {
    log('Focus window request received');
    bringWindowToFront();
  });

  socket.on('connect_error', (err) => {
    log(`Connection error: ${err.message}`);
    updateStatusBar(false);
  });
}

function disconnectFromOrchestrator() {
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
    }),
  })
    .then((res) => res.json())
    .then((agent: Agent) => {
      log(`Registered as agent: ${agent.id}`);
      // Join the agent-specific room now that we know our agent ID (closes race condition)
      if (socket?.connected) {
        socket.emit('join_agent_room', { agentId: agent.id });
        log(`Joined agent room agent:${agent.id}`);
      }
      // Drain any commands queued while we were offline
      drainPendingCommands(url, agent.id);
    })
    .catch((err) => {
      log(`Registration failed: ${err}`);
    });
}

async function bringWindowToFront() {
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
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

    // Step 2: Focus the Claude Code panel (within THIS window's extension host)
    const focusCmds = claudeCommands.filter((c) => {
      const lower = c.toLowerCase();
      return lower.includes('focus') && !lower.includes('new') && !lower.includes('open');
    });

    let focused = false;
    for (const cmd of focusCmds) {
      try {
        log(`Focusing: ${cmd}`);
        await vscode.commands.executeCommand(cmd);
        focused = true;
        break;
      } catch {
        // try next
      }
    }

    if (!focused) {
      log('No focus command found, opening sidebar');
      try {
        await vscode.commands.executeCommand('claude-vscode.sidebar.open');
      } catch {
        // ignore
      }
    }

    // Step 3: Raise the CORRECT VS Code window by workspace folder name,
    // then paste and submit via AppleScript
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
    try {
      // Activate VS Code to restore minimized windows, then raise the matching one
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

      // Always re-focus Claude Code input after window raise (focus shifts during raise)
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
      } catch {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      }
      await sleep(500);

      // Paste and Enter in a single AppleScript (delay is more reliable than JS setTimeout)
      const delaySec = Math.min(0.5 + command.text.length / 500, 3).toFixed(1);
      await execAsync(
        `osascript` +
        ` -e 'tell application "System Events"'` +
        ` -e '  keystroke "v" using command down'` +
        ` -e '  delay ${delaySec}'` +
        ` -e '  key code 36'` +
        ` -e 'end tell'`
      );
      log(`Simulated paste + Enter (delay=${delaySec}s) — command submitted`);
    } catch (err) {
      log(`Keystroke simulation failed: ${err}`);
      const preview = command.text.length > 80 ? command.text.slice(0, 80) + '...' : command.text;
      vscode.window.showInformationMessage(
        `NeonCore: Prompt copied — paste with Cmd+V: "${preview}"`
      );
    }
  } catch (err) {
    log(`handleCommand error: ${err}`);
    vscode.window.showErrorMessage(`NeonCore: Failed to deliver command - ${err}`);
  }
}

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
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
