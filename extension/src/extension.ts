import * as vscode from 'vscode';
import { io, Socket } from 'socket.io-client';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

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

async function handleCommand(command: Command) {
  const config = vscode.workspace.getConfiguration('neoncore');
  const url = config.get('orchestratorUrl', 'http://localhost:4040');

  log(`Handling command: "${command.text.slice(0, 120)}"`);

  try {
    // Find a Claude Code terminal (silent — no focus stealing)
    const claudeTerminal = findClaudeTerminal();

    if (claudeTerminal) {
      // Send text directly to the terminal's stdin — works even when VS Code is not focused
      claudeTerminal.sendText(command.text);
      log(`Sent command to terminal "${claudeTerminal.name}" via sendText (silent)`);
      markDelivered(url, command.id);
    } else {
      // Fallback: copy to clipboard and notify user
      await vscode.env.clipboard.writeText(command.text);
      markDelivered(url, command.id);
      const preview = command.text.length > 80 ? command.text.slice(0, 80) + '...' : command.text;
      log('No Claude terminal found — copied to clipboard');
      vscode.window.showInformationMessage(
        `NeonCore: No Claude terminal found. Prompt copied — paste with Cmd+V: "${preview}"`
      );
    }
  } catch (err) {
    log(`handleCommand error: ${err}`);
    vscode.window.showErrorMessage(`NeonCore: Failed to deliver command - ${err}`);
  }
}

function findClaudeTerminal(): vscode.Terminal | undefined {
  const terminals = vscode.window.terminals;
  // Look for a terminal whose name contains "Claude" or "claude"
  for (const t of terminals) {
    const name = t.name.toLowerCase();
    if (name.includes('claude')) {
      return t;
    }
  }
  return undefined;
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
