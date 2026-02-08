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
    registerWithOrchestrator();
    vscode.window.showInformationMessage(`NeonCore: Connected to orchestrator at ${url}`);
  });

  socket.on('disconnect', () => {
    log('Disconnected from orchestrator');
    updateStatusBar(false);
  });

  // Listen for commands — match by machine + repoPath (no agent ID needed)
  socket.on('command_send', (command: Command) => {
    const { machine, repoPath } = getLocalIdentity();
    const matchesMachine = command.machine === machine;
    const matchesRepo = command.repoPath === repoPath;

    log(`Command received: agent=${command.agentId}, machine match=${matchesMachine}, repo match=${matchesRepo}`);

    if (matchesMachine && matchesRepo) {
      handleCommand(command);
    }
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
    })
    .catch((err) => {
      log(`Registration failed: ${err}`);
    });
}

async function handleCommand(command: Command) {
  const config = vscode.workspace.getConfiguration('neoncore');
  const url = config.get('orchestratorUrl', 'http://localhost:4040');

  log(`Handling command: "${command.text.slice(0, 120)}"`);

  try {
    // Step 1: Copy prompt to clipboard
    await vscode.env.clipboard.writeText(command.text);
    markDelivered(url, command.id);

    // Step 2: Focus the Claude Code panel
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
      log('No focus command found, focusing sidebar');
      try {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      } catch {
        // ignore
      }
    }

    // Step 3: Bring VS Code to front, paste, and submit (macOS)
    try {
      // Activate VS Code window
      await execAsync(`osascript -e 'tell application "Visual Studio Code" to activate'`);
      log('Activated VS Code window');
      await sleep(500);

      // Focus the Claude Code input area
      if (!focused) {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      }
      await sleep(500);

      // Simulate Cmd+V (paste from clipboard)
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
      log('Simulated Cmd+V paste');

      // Wait for paste, then simulate Enter to submit
      await sleep(300);
      await execAsync(`osascript -e 'tell application "System Events" to key code 36'`);
      log('Simulated Enter — command submitted');
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
