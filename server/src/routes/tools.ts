/**
 * NeonCore Tools Integration Route
 * Handles installation and status checking of AI tool hook integrations.
 *
 * POST /api/tools/install/:tool  — write hook config for a tool
 * GET  /api/tools/status         — check which tools are already configured
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the agent/hooks directory (works in both dev and compiled)
const HOOKS_DIR = path.resolve(__dirname, '../../../agent/hooks');

// All supported tools and their config file locations + hook script names
const TOOL_CONFIGS = {
  gemini: {
    label: 'Gemini CLI',
    configFile: path.join(os.homedir(), '.gemini', 'settings.json'),
    proxyScript: 'gemini-permission-proxy.sh',
    reporterScript: 'gemini-reporter.sh',
    installNote: 'Hooks wired into ~/.gemini/settings.json',
    detectedBy: 'gemini',
  },
  amazonq: {
    label: 'Amazon Q Developer CLI',
    configFile: path.join(os.homedir(), '.aws', 'amazonq', 'cli-agents', 'neoncore.json'),
    proxyScript: 'amazonq-permission-proxy.sh',
    reporterScript: 'amazonq-reporter.sh',
    installNote: 'Agent config written to ~/.aws/amazonq/cli-agents/neoncore.json',
    detectedBy: 'q',
  },
  codex: {
    label: 'Codex CLI (OpenAI)',
    configFile: path.join(os.homedir(), '.codex', 'hooks.json'),
    proxyScript: 'codex-permission-proxy.sh',
    reporterScript: 'codex-reporter.sh',
    installNote: 'Hooks wired into ~/.codex/hooks.json (feature flag enabled in config.toml)',
    detectedBy: 'codex',
  },
  cursor: {
    label: 'Cursor',
    configFile: path.join(os.homedir(), '.cursor', 'hooks.json'),
    proxyScript: 'cursor-permission-proxy.sh',
    reporterScript: 'cursor-reporter.sh',
    installNote: 'Hooks wired into ~/.cursor/hooks.json',
    detectedBy: 'cursor',
  },
  claude: {
    label: 'Claude Code',
    configFile: path.join(os.homedir(), '.claude', 'settings.json'),
    proxyScript: 'permission-proxy.sh',
    reporterScript: 'reporter.sh',
    installNote: 'Hooks wired into ~/.claude/settings.json',
    detectedBy: 'claude',
  },
} as const;

type ToolKey = keyof typeof TOOL_CONFIGS;

// CLI binary names + npm package to install them (null = not npm-installable)
const CLI_INFO: Record<string, { bin: string; npmPkg: string | null; authCmd: string | null }> = {
  claude:  { bin: 'claude',  npmPkg: null,                      authCmd: null },
  gemini:  { bin: 'gemini',  npmPkg: '@google/gemini-cli',      authCmd: 'gemini auth' },
  amazonq: { bin: 'q',       npmPkg: null,                      authCmd: null },
  codex:   { bin: 'codex',   npmPkg: '@openai/codex',           authCmd: null },
  cursor:  { bin: 'cursor',  npmPkg: null,                      authCmd: null },
};

/** Check if a CLI binary is available via PATH or common install locations */
function findCli(binName: string): string | null {
  const home = os.homedir();
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'node_modules', '.bin'),
    // Cursor-specific
    '/Applications/Cursor.app/Contents/Resources/app/bin',
    path.join(home, 'Applications/Cursor.app/Contents/Resources/app/bin'),
  ];
  for (const dir of extraPaths) {
    const full = path.join(dir, binName);
    if (fs.existsSync(full)) return full;
  }
  try {
    const cmd = process.platform === 'win32' ? `where ${binName}` : `bash -lc "which ${binName}"`;
    const result = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
    if (result && fs.existsSync(result)) return result;
  } catch { /* not found */ }
  return null;
}

/** Check if a config file already contains our hook scripts */
function isInstalled(tool: ToolKey): boolean {
  const cfg = TOOL_CONFIGS[tool];
  try {
    const content = fs.readFileSync(cfg.configFile, 'utf-8');
    return content.includes(cfg.proxyScript) || content.includes('neoncore');
  } catch {
    return false;
  }
}

/** Merge-write a JSON config file, preserving existing non-neoncore keys */
function mergeJsonFile(filePath: string, incoming: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { /* file doesn't exist or invalid JSON — start fresh */ }

  const merged = deepMerge(existing, incoming);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/** Deep merge — arrays are replaced (not concatenated) if they come from NeonCore */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function proxyPath(tool: ToolKey): string {
  return path.join(HOOKS_DIR, TOOL_CONFIGS[tool].proxyScript);
}

function reporterPath(tool: ToolKey): string {
  return path.join(HOOKS_DIR, TOOL_CONFIGS[tool].reporterScript);
}

// ---------------------------------------------------------------------------
// GET /api/tools/status
// ---------------------------------------------------------------------------
router.get('/status', (_req, res) => {
  const status: Record<string, {
    installed: boolean;
    configFile: string;
    label: string;
    hooksExist: boolean;
    cliInstalled: boolean;
    cliPath: string | null;
    npmPkg: string | null;
    authCmd: string | null;
  }> = {};

  for (const [key, cfg] of Object.entries(TOOL_CONFIGS)) {
    const tool = key as ToolKey;
    const cliInfo = CLI_INFO[key];
    const cliPath = cliInfo ? findCli(cliInfo.bin) : null;
    status[key] = {
      label: cfg.label,
      installed: isInstalled(tool),
      configFile: cfg.configFile,
      hooksExist: fs.existsSync(proxyPath(tool)) && fs.existsSync(reporterPath(tool)),
      cliInstalled: cliPath !== null,
      cliPath,
      npmPkg: cliInfo?.npmPkg ?? null,
      authCmd: cliInfo?.authCmd ?? null,
    };
  }

  res.json(status);
});

// ---------------------------------------------------------------------------
// POST /api/tools/install/:tool
// ---------------------------------------------------------------------------
router.post('/install/:tool', (req, res) => {
  const tool = req.params.tool as ToolKey;

  if (!(tool in TOOL_CONFIGS)) {
    res.status(400).json({ error: `Unknown tool: ${tool}` });
    return;
  }

  const proxy = proxyPath(tool);
  const reporter = reporterPath(tool);

  if (!fs.existsSync(proxy) || !fs.existsSync(reporter)) {
    res.status(500).json({ error: `Hook scripts not found at ${HOOKS_DIR}` });
    return;
  }

  // Install CLI via npm if available and not yet installed
  const cliInfo = CLI_INFO[tool];
  if (cliInfo?.npmPkg && !findCli(cliInfo.bin)) {
    try {
      execFileSync('bash', ['-lc', `npm install -g ${cliInfo.npmPkg}`], {
        timeout: 120_000,
        stdio: 'pipe',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to install ${cliInfo.npmPkg}: ${msg}` });
      return;
    }
  }

  try {
    if (tool === 'gemini') {
      mergeJsonFile(TOOL_CONFIGS.gemini.configFile, {
        hooks: {
          preToolCall: [{ command: proxy }],
          postToolCall: [{ command: reporter }],
        },
      });

    } else if (tool === 'amazonq') {
      // Amazon Q uses an agent JSON config file (not a hooks.json)
      mergeJsonFile(TOOL_CONFIGS.amazonq.configFile, {
        name: 'neoncore',
        hooks: {
          preToolUse: [{ matcher: '*', command: proxy, timeout_ms: 125000 }],
          postToolUse: [{ matcher: '*', command: reporter }],
        },
      });

    } else if (tool === 'codex') {
      // hooks.json
      mergeJsonFile(TOOL_CONFIGS.codex.configFile, {
        hooks: {
          PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: proxy }] }],
          PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: reporter }] }],
        },
      });

      // Enable feature flag in config.toml
      const tomlPath = path.join(os.homedir(), '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
      let toml = '';
      try { toml = fs.readFileSync(tomlPath, 'utf-8'); } catch { /* new file */ }
      if (!toml.includes('codex_hooks')) {
        toml += (toml && !toml.endsWith('\n') ? '\n' : '') + '\n[features]\ncodex_hooks = true\n';
        fs.writeFileSync(tomlPath, toml, 'utf-8');
      }

    } else if (tool === 'cursor') {
      mergeJsonFile(TOOL_CONFIGS.cursor.configFile, {
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: proxy }],
          beforeMCPExecution: [{ command: proxy }],
          afterFileEdit: [{ command: reporter }],
          stop: [{ command: reporter }],
        },
      });

    } else if (tool === 'claude') {
      // Claude Code uses ~/.claude/settings.json hooks array
      mergeJsonFile(TOOL_CONFIGS.claude.configFile, {
        hooks: {
          PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: proxy }] }],
          PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: reporter }] }],
          UserPromptSubmit: [{ matcher: '.*', hooks: [{ type: 'command', command: reporter }] }],
        },
      });
    }

    const cliWasInstalled = cliInfo?.npmPkg && findCli(cliInfo.bin);
    res.json({
      ok: true,
      tool,
      configFile: TOOL_CONFIGS[tool].configFile,
      note: TOOL_CONFIGS[tool].installNote,
      cliInstalled: !!findCli(cliInfo?.bin ?? ''),
      authCmd: cliWasInstalled ? cliInfo?.authCmd ?? null : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to install ${tool} hooks: ${msg}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/uninstall/:tool  — remove NeonCore hooks from config
// ---------------------------------------------------------------------------
router.post('/uninstall/:tool', (req, res) => {
  const tool = req.params.tool as ToolKey;

  if (!(tool in TOOL_CONFIGS)) {
    res.status(400).json({ error: `Unknown tool: ${tool}` });
    return;
  }

  const cfgFile = TOOL_CONFIGS[tool].configFile;

  try {
    if (!fs.existsSync(cfgFile)) {
      res.json({ ok: true, note: 'Config file did not exist' });
      return;
    }

    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(cfgFile, 'utf-8')); } catch { /* ignore */ }

    // Remove hooks section entirely (it was ours)
    delete config['hooks'];

    // For Amazon Q, also clear the name if it's our agent
    if (tool === 'amazonq' && (config['name'] as string) === 'neoncore') {
      // Delete the whole file — it was our agent config
      fs.unlinkSync(cfgFile);
      res.json({ ok: true, note: 'Agent config removed' });
      return;
    }

    fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    res.json({ ok: true, configFile: cfgFile });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to uninstall ${tool} hooks: ${msg}` });
  }
});

export default router;
