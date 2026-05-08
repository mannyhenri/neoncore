import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'neoncore.db');

const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    machine TEXT NOT NULL,
    repo_path TEXT NOT NULL DEFAULT '',
    repo_name TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    current_task TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    trust_mode INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    last_message TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_agents_machine_repo ON agents(machine, repo_path);

  CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    tool_input TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'dashboard',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id);
  CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS idx_permissions_status ON permissions(status);
  CREATE INDEX IF NOT EXISTS idx_permissions_agent ON permissions(agent_id);
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memory_project ON agent_memory(project);
  CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent_id);
`);

// Migration: add agent_mode column
try {
  db.prepare('SELECT agent_mode FROM agents LIMIT 1').get();
} catch {
  db.exec(`
    ALTER TABLE agents ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'manual';
    UPDATE agents SET agent_mode = CASE WHEN trust_mode = 1 THEN 'trust' ELSE 'manual' END;
  `);
}

// Migration: add agent_type column
try {
  db.prepare('SELECT agent_type FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'`);
}

// Migration: add composite index for dedup by machine + repo + type
db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_machine_repo_type ON agents(machine, repo_path, agent_type)`);

// Migration: add active column to agent_memory
try {
  db.prepare('SELECT active FROM agent_memory LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agent_memory ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
}

// Migration: add tool_result column to activity
try {
  db.prepare('SELECT tool_result FROM activity LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE activity ADD COLUMN tool_result TEXT NOT NULL DEFAULT '{}'`);
}

// Migration: add pending_question column to agents
try {
  db.prepare('SELECT pending_question FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN pending_question TEXT NOT NULL DEFAULT ''`);
}

// Migration: add memory_enabled column to agents
try {
  db.prepare('SELECT memory_enabled FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0`);
}

// Migration: add response column to permissions (for AskUserQuestion answers, ExitPlanMode feedback)
try {
  db.prepare('SELECT response FROM permissions LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE permissions ADD COLUMN response TEXT NOT NULL DEFAULT ''`);
}

// Migration: add plans_included column to agents
try {
  db.prepare('SELECT plans_included FROM agents LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE agents ADD COLUMN plans_included INTEGER NOT NULL DEFAULT 0`);
}

// Epic Autopilot table
db.exec(`
  CREATE TABLE IF NOT EXISTS epic_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    current_task INTEGER NOT NULL DEFAULT 0,
    tasks TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '{}',
    previous_mode TEXT NOT NULL DEFAULT 'manual',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_epic_runs_status ON epic_runs(status);
  CREATE INDEX IF NOT EXISTS idx_epic_runs_agent ON epic_runs(agent_id);
`);

// Workflow table
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    jira_task_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    players TEXT NOT NULL DEFAULT '[]',
    phases TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    current_phase INTEGER NOT NULL DEFAULT 0,
    iteration INTEGER NOT NULL DEFAULT 1,
    max_iterations INTEGER NOT NULL DEFAULT 3,
    shared_context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT,
    error TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
`);

// Migration: add target_repos to workflows
try {
  db.prepare('SELECT target_repos FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN target_repos TEXT NOT NULL DEFAULT '[]'`);
}

// Migration: add template_id and run_number to workflows (multi-run support)
try {
  db.prepare('SELECT template_id FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN template_id TEXT DEFAULT NULL`);
  db.exec(`ALTER TABLE workflows ADD COLUMN run_number INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_template ON workflows(template_id)`);
}

// Migration: add initial_context column to workflows (user-supplied context passed to first steps)
try {
  db.prepare('SELECT initial_context FROM workflows LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflows ADD COLUMN initial_context TEXT NOT NULL DEFAULT ''`);
}

// FTS5 full-text search over session summaries and project knowledge.
// Drop triggers and tables first so we always start from a consistent schema.
try {
  db.exec(`
    DROP TRIGGER IF EXISTS sessions_ai;
    DROP TRIGGER IF EXISTS sessions_au;
    DROP TRIGGER IF EXISTS sessions_ad;
    DROP TRIGGER IF EXISTS knowledge_ai;
    DROP TRIGGER IF EXISTS knowledge_au;
    DROP TRIGGER IF EXISTS knowledge_ad;
    DROP TABLE IF EXISTS sessions_fts;
    DROP TABLE IF EXISTS knowledge_fts;
  `);
} catch { /* ignore */ }

try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      summary,
      project,
      content='sessions',
      content_rowid='rowid'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content,
      project,
      filename,
      content='project_knowledge',
      content_rowid='rowid'
    );
  `);

  // Populate FTS with existing data
  db.exec(`
    DELETE FROM sessions_fts;
    INSERT INTO sessions_fts(rowid, summary, project) SELECT rowid, summary, project FROM sessions WHERE summary != '';

    DELETE FROM knowledge_fts;
    INSERT INTO knowledge_fts(rowid, content, project, filename) SELECT rowid, content, project, filename FROM project_knowledge WHERE content != '';
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, summary, project) VALUES (new.rowid, new.summary, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE OF summary ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
      INSERT INTO sessions_fts(rowid, summary, project) VALUES (new.rowid, new.summary, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON project_knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, project, filename) VALUES (new.rowid, new.content, new.project, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE OF content ON project_knowledge BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.rowid;
      INSERT INTO knowledge_fts(rowid, content, project, filename) VALUES (new.rowid, new.content, new.project, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON project_knowledge BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.rowid;
    END;
  `);
} catch {
  // FTS5 not available or already exists — skip
}

// Session token usage table
db.exec(`
  CREATE TABLE IF NOT EXISTS session_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_session ON session_usage(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_agent ON session_usage(agent_id);
`);

// MCP Servers table
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    is_preconfigured INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'stopped',
    error TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    capabilities TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(slug);
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
`);

// Workflow Steps table (V2 canvas workflows)
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position_x REAL NOT NULL DEFAULT 0,
    position_y REAL NOT NULL DEFAULT 0,
    executor_type TEXT NOT NULL,
    executor_id TEXT NOT NULL DEFAULT '',
    executor_config TEXT NOT NULL DEFAULT '{}',
    auto_advance INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    depends_on TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_status ON workflow_steps(status);
`);

// Migration: add plan_content column to workflow_steps (stores plan captured from ExitPlanMode)
try {
  db.prepare('SELECT plan_content FROM workflow_steps LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE workflow_steps ADD COLUMN plan_content TEXT NOT NULL DEFAULT ''`);
}

// Migration: add description column to mcp_servers
try {
  db.prepare('SELECT description FROM mcp_servers LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE mcp_servers ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
}

// Backfill descriptions for existing preconfigured servers
const mcpDescriptions: Record<string, string> = {
  slack: 'Send messages, read channels, and manage your Slack workspace',
  github: 'Browse repos, manage issues & PRs, search code on GitHub',
  jira: 'View and update Jira issues, search projects, track work',
  'google-drive': 'List, search, read and manage files in your Google Drive',
  gmail: 'Read, search, and send emails from your Gmail account',
  spotify: 'Control playback, search music, manage playlists on Spotify',
  openai: 'Query OpenAI models (GPT-4, etc.) as a tool within workflows',
  gemini: 'Query Google Gemini models as a tool within workflows',
  'adobe-cc': 'Create and edit designs in Adobe Express programmatically',
  blender: 'Control Blender 3D — create scenes, objects, materials, and render',
  fetch: 'Fetch and parse content from any URL on the web',
  filesystem: 'Read, write, and manage files on the local filesystem',
  'brave-search': 'Search the web using Brave Search API and get structured results',
};
{
  const updateDesc = db.prepare('UPDATE mcp_servers SET description = ? WHERE slug = ? AND description = ?');
  for (const [slug, desc] of Object.entries(mcpDescriptions)) {
    updateDesc.run(desc, slug, '');
  }
}

// Fix Blender MCP: npx → uvx (Python package), port 8400 → 9876 (standard addon port)
{
  const blender = db.prepare('SELECT id, command, env FROM mcp_servers WHERE slug = ?').get('blender') as { id: string; command: string; env: string } | undefined;
  if (blender) {
    try {
      const env = JSON.parse(blender.env);
      let changed = false;
      if (env.BLENDER_PORT === '8400') { env.BLENDER_PORT = '9876'; changed = true; }
      if (blender.command === 'npx') {
        db.prepare('UPDATE mcp_servers SET command = ? WHERE id = ?').run('uvx', blender.id);
        changed = true;
      }
      if (changed) {
        db.prepare('UPDATE mcp_servers SET env = ? WHERE id = ?').run(JSON.stringify(env), blender.id);
      }
    } catch { /* ignore */ }
  }
}

// Seed pre-configured MCP servers (only on first run)
const mcpCount = db.prepare('SELECT COUNT(*) as count FROM mcp_servers WHERE is_preconfigured = 1').get() as { count: number };
if (mcpCount.count === 0) {
  const now = new Date().toISOString();
  const registry = [
    { slug: 'slack', name: 'Slack', command: 'npx', args: ['@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' }, description: 'Send messages, read channels, and manage your Slack workspace' },
    { slug: 'github', name: 'GitHub', command: 'npx', args: ['@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '' }, description: 'Browse repos, manage issues & PRs, search code on GitHub' },
    { slug: 'jira', name: 'Jira', command: 'npx', args: ['@aashari/mcp-server-atlassian-jira'], env: { JIRA_HOST: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' }, description: 'View and update Jira issues, search projects, track work' },
    { slug: 'google-drive', name: 'Google Drive', command: 'npx', args: ['-y', 'google-drive-mcp'], env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, description: 'List, search, read and manage files in your Google Drive' },
    { slug: 'gmail', name: 'Gmail', command: 'npx', args: ['-y', 'gmail-mcp'], env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, description: 'Read, search, and send emails from your Gmail account' },
    { slug: 'spotify', name: 'Spotify', command: 'npx', args: ['@tbrgeek/spotify-mcp-server'], env: { SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: '' }, description: 'Control playback, search music, manage playlists on Spotify' },
    { slug: 'openai', name: 'OpenAI', command: 'npx', args: ['@mzxrai/mcp-openai'], env: { OPENAI_API_KEY: '' }, description: 'Query OpenAI models (GPT-4, etc.) as a tool within workflows' },
    { slug: 'gemini', name: 'Gemini', command: 'npx', args: ['@houtini/gemini-mcp'], env: { GEMINI_API_KEY: '' }, description: 'Query Google Gemini models as a tool within workflows' },
    { slug: 'adobe-cc', name: 'Adobe CC', command: 'npx', args: ['@adobe/express-developer-mcp@latest', '--yes'], env: {}, description: 'Create and edit designs in Adobe Express programmatically' },
    { slug: 'blender', name: 'Blender', command: 'uvx', args: ['blender-mcp'], env: { BLENDER_HOST: 'localhost', BLENDER_PORT: '9876' }, description: 'Control Blender 3D — create scenes, objects, materials, and render' },
    { slug: 'fetch', name: 'Fetch / Web', command: 'npx', args: ['mcp-fetch-server'], env: {}, description: 'Fetch and parse content from any URL on the web' },
    { slug: 'filesystem', name: 'Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: {}, description: 'Read, write, and manage files on the local filesystem' },
    { slug: 'brave-search', name: 'Web Search (Brave)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' }, description: 'Search the web using Brave Search API and get structured results' },
  ];

  const insert = db.prepare(`
    INSERT INTO mcp_servers (id, name, slug, command, args, env, is_preconfigured, status, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'stopped', ?, ?, ?)
  `);

  for (const srv of registry) {
    const id = `mcp-${srv.slug}`;
    insert.run(id, srv.name, srv.slug, srv.command, JSON.stringify(srv.args), JSON.stringify(srv.env), srv.description, now, now);
  }
  console.log(`[db] Seeded ${registry.length} pre-configured MCP servers`);
}

// Virtual Cartridges table — local folder workspaces with MCP-powered actions
db.exec(`
  CREATE TABLE IF NOT EXISTS virtual_cartridges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    directory_path TEXT NOT NULL UNIQUE,
    icon_index INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#a855f7',
    mcp_server_ids TEXT NOT NULL DEFAULT '[]',
    pinned_tools TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_virtual_cartridges_path ON virtual_cartridges(directory_path);
`);

// Migration: add ntfy_url to virtual_cartridges (per-project push notification override)
try {
  db.prepare('SELECT ntfy_url FROM virtual_cartridges LIMIT 1').get();
} catch {
  db.exec(`ALTER TABLE virtual_cartridges ADD COLUMN ntfy_url TEXT NOT NULL DEFAULT ''`);
}

// MCP Macros table — reusable multi-step MCP tool chains
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_macros (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Custom',
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_macros_category ON mcp_macros(category);
`);

// MCP Macro Runs table — execution history
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_macro_runs (
    id TEXT PRIMARY KEY,
    macro_id TEXT NOT NULL,
    cartridge_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 0,
    step_results TEXT NOT NULL DEFAULT '[]',
    input_params TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_macro_runs_status ON mcp_macro_runs(status);
  CREATE INDEX IF NOT EXISTS idx_macro_runs_macro ON mcp_macro_runs(macro_id);
`);

// Cleanup: expire stale pending permissions from past sessions
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expired = db.prepare(
  `UPDATE permissions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?`
).run(new Date().toISOString(), fiveMinAgo);
if (expired.changes > 0) {
  console.log(`[db] Expired ${expired.changes} stale pending permission(s) from past sessions`);
}

// Session journal table — tracks session lifecycle per agent
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    repo_path TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    activity_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);

// Project knowledge files — per-project editable markdown documents
db.exec(`
  CREATE TABLE IF NOT EXISTS project_knowledge (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(project, filename)
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON project_knowledge(project);

  -- Centralized command templates
  CREATE TABLE IF NOT EXISTS command_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Custom',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_command_templates_category ON command_templates(category);

  -- Cleanup performance indexes
  CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);

  -- Add project column to notes for project-scoped notes
  -- (SQLite ALTER TABLE ADD COLUMN is safe to run multiple times if column exists — handled below)
`);

// Add project column to notes table (migration-safe)
try {
  db.prepare("SELECT project FROM notes LIMIT 1").get();
} catch {
  db.prepare("ALTER TABLE notes ADD COLUMN project TEXT NOT NULL DEFAULT ''").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project)").run();
}

// Backfill project on existing notes from their agent's repo_name
const orphanNotes = db.prepare("SELECT n.id, a.repo_name FROM notes n JOIN agents a ON n.agent_id = a.id WHERE n.project = '' AND a.repo_name != ''").all() as { id: string; repo_name: string }[];
if (orphanNotes.length > 0) {
  const update = db.prepare("UPDATE notes SET project = ? WHERE id = ?");
  for (const n of orphanNotes) {
    update.run(n.repo_name, n.id);
  }
  console.log(`[db] Migrated ${orphanNotes.length} notes to project-scoped`);
}

// ── Seed default workflow templates ──────────────────────────────────────────
// Creates 5 starter templates if none exist yet. Safe to run on every boot —
// skips seeding if any pending templates are already present.

function seedDefaultTemplates() {
  // Always replace the 5 standard templates by name so schema changes take effect.
  // User-created templates with other names are left untouched.
  const standardNames = ['Code Improvement', 'Bug Hunter', 'Feature Fix', 'New Feature', 'CI/CD Pipeline', 'Feature Validation', 'Deep Research', 'Jira Tasks Validation', 'Jira Tasks Completion'];
  for (const name of standardNames) {
    const row = db.prepare("SELECT id FROM workflows WHERE name = ? AND template_id IS NULL").get(name) as { id: string } | undefined;
    if (row) {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(row.id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.id);
    }
  }

  const now = new Date().toISOString();

  const insertWorkflow = db.prepare(`
    INSERT INTO workflows (id, name, description, status, target_repos, created_at, started_at)
    VALUES (?, ?, ?, 'pending', '[]', ?, '')
  `);

  const insertStep = db.prepare(`
    INSERT INTO workflow_steps
      (id, workflow_id, name, description, position_x, position_y,
       executor_type, executor_id, executor_config, auto_advance, depends_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Agent-based types need __deferred__ so the user picks a cartridge at run time.
  // Connector/command steps run without a cartridge.
  const DEFERRED_TYPES = new Set(['claude-code', 'quality-gate', 'review-gate', 'deliberation']);

  function step(
    wfId: string,
    id: string,
    name: string,
    desc: string,
    x: number,
    y: number,
    type: string,
    config: Record<string, unknown>,
    deps: string[],
    auto = true,
  ) {
    const executorId = DEFERRED_TYPES.has(type) ? '__deferred__' : '';
    insertStep.run(id, wfId, name, desc, x, y, type, executorId, JSON.stringify(config), auto ? 1 : 0, JSON.stringify(deps), now);
  }

  const cc = (role: string, extra: Record<string, unknown> = {}) => ({
    role,
    includeDepOutput: true,
    systemPromptMode: 'free',
    systemPrompt: '',
    loopCount: 1,
    ...extra,
  });

  const gate = (gateType: string) => ({ gateType, includeDepOutput: true });

  // Layout constants: all steps x=300, y increments by 175 (fully linear/sequential).

  // ── 1. Code Improvement ───────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Code Improvement',
      'Audit → architect → define tests → implement → run tests → security → notify.', now);
    step(wfId, s1, 'Performance Audit',   'Identify top bottlenecks ranked by impact. No code changes.',                                                                                                                      300,   50, 'claude-code', cc('performance'), []);
    step(wfId, s2, 'Architecture Review', 'Propose refactoring steps with exact file paths and interfaces.',                                                                                                                  300,  225, 'claude-code', cc('architect'),   [s1]);
    step(wfId, s3, 'Define Tests',        'Define the test cases and expected outcomes that will prove the improvements worked. List what each test verifies. Do not write implementation code.',                              300,  400, 'claude-code', cc('tester'),     [s2]);
    step(wfId, s4, 'Implement Fixes',     'Apply the improvements following the architecture plan.',                                                                                                                          300,  575, 'claude-code', cc('backend'),    [s3]);
    step(wfId, s5, 'Run Tests',           'Execute the tests defined in the Define Tests step. Verify all pass.',                                                                                                             300,  750, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }], maxCycles: 2 }, [s4]);
    step(wfId, s6, 'Security & Lint',     'Verify lint and security pass after the changes.',                                                                                                                                 300,  925, 'quality-gate', gate('security'), [s5]);
    step(wfId, s7, 'Notify',              'System notification: Code Improvement workflow complete.',                                                                                                                          300, 1100, 'connector',
      { connectorType: 'system-notify', title: 'Code Improvement — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s6]);
  }

  // ── 2. Bug Hunter ─────────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Bug Hunter',
      'Proactive bug hunt: static analysis → dead code → bug pattern scan → prioritize & plan → implement fixes → verify → notify.', now);

    step(wfId, s1, 'Static & Lint Analysis',
      'Run the compiler and linter to surface all type errors, lint violations, and build warnings. No code changes.',
      300, 80, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Run a full static analysis pass on this codebase. Do NOT make any code changes — only identify and document issues.\n\n1. DETECT LANGUAGE & TOOLS — Check what\'s available: TypeScript (`tsc --noEmit`), ESLint (`npx eslint . --format compact`), Rust (`cargo check`, `cargo clippy`), Python (`ruff check .` or `flake8`), etc. Run whatever applies to this project.\n\n2. RUN EACH TOOL and capture all output.\n\n3. OUTPUT all findings grouped by file in this format:\n```\n## Static Analysis Findings\n\n### [file:line]\nSEVERITY: error | warning | info\nISSUE: [description]\n```\n\nEnd with a count: `Total findings: N (errors: X, warnings: Y)`\n\nIf no issues found, say "STATIC: CLEAN".',
      }, []);

    step(wfId, s2, 'Dead Code Scan',
      'Find all unused code: imports, variables, functions, exports, unreachable branches, empty catch blocks, and commented-out code.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the entire codebase for dead code. Do NOT make any changes — only identify and document. Use Read, Grep, and Glob tools extensively.\n\nLook for all of the following:\n\n**Unused imports** — imported but never referenced in the file.\n**Unused variables** — declared but never read after assignment.\n**Unused functions/methods** — defined but never called anywhere in the project.\n**Unreachable code** — code after a `return`, `throw`, or `break`; branches that can never be true.\n**Empty or swallowed catch blocks** — `catch (e) {}` or `catch { /* ignore */ }` with no logging or handling.\n**Dead exports** — symbols exported but never imported by any other file.\n**Commented-out code blocks** — large sections of code left as comments (not doc comments).\n**Redundant conditions** — `if (true)`, `if (false)`, always-truthy/falsy guards.\n\nFor each finding:\n```\n### [file:line]\nTYPE: unused-import | unused-var | unused-function | unreachable | empty-catch | dead-export | commented-code | redundant-condition\nDETAIL: [what it is and why it\'s dead]\n```\n\nEnd with: `Dead code findings: N`',
      }, [s1]);

    step(wfId, s3, 'Bug Pattern Hunt',
      'Systematically scan for common bug patterns: null access, missing awaits, race conditions, silent failures, incorrect comparisons, and missing error handling.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Scan the codebase for common bug patterns. Do NOT make any changes — only document findings. Use Read, Grep, and Glob tools.\n\nCheck for each of these patterns:\n\n**Null/undefined access without guards** — `obj.property` or `arr[i]` where the value could be null/undefined/out-of-bounds.\n**Missing await** — async functions called without `await`; promises returned but never resolved or caught.\n**Unhandled promise rejections** — `.then()` chains without `.catch()`; `async` functions whose returned promise is not awaited or caught by the caller.\n**Race conditions** — shared state mutated across async boundaries; multiple concurrent writes without locking.\n**Off-by-one errors** — loop bounds, array slices, index comparisons using `<` vs `<=`.\n**Incorrect equality** — `==` instead of `===` in JS/TS; comparison of different types.\n**Silent failures** — operations that can fail but have no error path (missing `try/catch`, ignoring return codes, swallowing errors).\n**Missing input validation** — user-facing functions or API handlers that don\'t validate/sanitize their inputs.\n**Incorrect state updates** — mutating state directly instead of via setState/reducers; stale closures capturing outdated values.\n**Memory leaks** — event listeners added but never removed; timers/intervals not cleared; large objects held in long-lived scope.\n**Hardcoded values** — URLs, credentials, magic numbers that should be config or constants.\n\nFor each finding:\n```\n### [file:line]\nPATTERN: [pattern name from list above]\nSEVERITY: critical | high | medium | low\nDETAIL: [what the bug is and what could go wrong at runtime]\n```\n\nEnd with: `Bug patterns found: N (critical: X, high: Y, medium: Z, low: W)`',
      }, [s2]);

    step(wfId, s4, 'Prioritize & Plan Fixes',
      'Collate all findings from the three scans, rank by severity, and write a concrete fix plan. Manual advance — review before any code changes.',
      300, 770, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the findings from the three previous steps (Static Analysis, Dead Code Scan, Bug Pattern Hunt), compile a prioritized fix plan.\n\n1. COLLATE ALL FINDINGS — List every unique issue found across all three steps. Deduplicate overlaps.\n\n2. RANK BY PRIORITY:\n   - **P0 — Critical**: crashes, data corruption, security holes, broken core paths\n   - **P1 — High**: wrong behavior under normal conditions, data loss risk, unhandled errors in prod paths\n   - **P2 — Medium**: edge case failures, incorrect logic that usually works, bad UX paths\n   - **P3 — Low**: style, minor inefficiency, non-critical dead code\n\n3. OUTPUT THE PLAN in this format:\n\n```\n## Bug Fix Plan\n\n### P0 — Critical ([count])\n| File:Line | Issue | Fix |\n|-----------|-------|-----|\n| [path:line] | [what the bug is] | [exact change to make] |\n\n### P1 — High ([count])\n[same table]\n\n### P2 — Medium ([count])\n[same table]\n\n### P3 — Low / Dead Code ([count])\n[same table]\n\n## Summary\nTotal issues: N | Estimated risk of fixing: low/medium/high\n```\n\nBe specific about the exact change for each fix — the next step will implement directly from this plan.',
      }, [s3], false);

    step(wfId, s5, 'Implement Fixes',
      'Apply all fixes from the plan in priority order (P0 → P1 → P2 → P3). Remove dead code. Document each change.',
      300, 1000, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the prioritized fix plan from the previous step, implement all fixes.\n\nWork through them in order: P0 first, then P1, P2, and finally P3 (dead code removal).\n\nFor each fix:\n1. Apply the minimal correct change — do not refactor beyond what is needed to fix the issue.\n2. For dead code (unused imports, variables, functions, unreachable branches): remove them entirely.\n3. For empty catch blocks: add at minimum a `console.error` or appropriate error logging.\n4. Log each change in this format:\n```\nFIXED [file:line] — [brief description of what was changed and why]\n```\n\nAfter all fixes are applied, output:\n```\n## Fixes Applied\n[list of all FIXED log lines]\n\nTotal fixed: N\nDead code removed: N items\n```\n\nDo not add new features. Do not refactor code beyond the fix. Do not change tests.',
      }, [s4]);

    step(wfId, s6, 'Verify',
      'Run the full test suite to confirm all fixes are correct and nothing was broken.',
      300, 1230, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s5 }], maxCycles: 2 }, [s5]);

    step(wfId, s7, 'Notify',
      'System notification: Bug Hunter workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Bug Hunter — Done', message: '{{workflowName}} finished. Check NeonCore for the full bug report.' }, [s6]);
  }

  // ── 3. Feature Fix ────────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Feature Fix',
      'Diagnose → plan → define tests → implement → run tests → security → notify.', now);
    step(wfId, s1, 'Diagnose Issue',  'Find exactly where behavior diverges from intent. No code changes.',                                                                                                                    300,   50, 'claude-code', cc('reviewer'),  []);
    step(wfId, s2, 'Plan the Fix',    'Design the minimal fix with exact file paths and edge case analysis.',                                                                                                                  300,  225, 'claude-code', cc('architect'), [s1]);
    step(wfId, s3, 'Define Tests',    'Define the test cases that describe the correct behavior. List what each test verifies and what inputs/outputs prove the feature works. Do not write the fix yet.',                     300,  400, 'claude-code', cc('tester'),    [s2]);
    step(wfId, s4, 'Implement Fix',   'Implement the fix following the plan.',                                                                                                                                                300,  575, 'claude-code', cc('backend'),   [s3]);
    step(wfId, s5, 'Run Tests',       'Execute all tests defined in Define Tests. Verify the feature behaves as expected.',                                                                                                   300,  750, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }], maxCycles: 2 }, [s4]);
    step(wfId, s6, 'Security & Lint', 'Confirm lint and security pass after the fix.',                                                                                                                                        300,  925, 'quality-gate', gate('security'), [s5]);
    step(wfId, s7, 'Notify',          'System notification: Feature Fix workflow complete.',                                                                                                                                   300, 1100, 'connector',
      { connectorType: 'system-notify', title: 'Feature Fix — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s6]);
  }

  // ── 4. New Feature ────────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'New Feature',
      'Research → architect → define tests → develop → run tests → security → summary → notify.', now);
    step(wfId, s1, 'Research',        'Investigate existing approaches, patterns, and trade-offs.',                                                                                                                           300,   50, 'claude-code', cc('researcher'), []);
    step(wfId, s2, 'Architecture',    'Design implementation plan with file paths and interfaces. Manual advance — review before tests are written.',                                                                         300,  225, 'claude-code', cc('architect'),  [s1], false);
    step(wfId, s3, 'Define Tests',    'Define all test cases and acceptance criteria. For each test: describe the scenario, inputs, expected output, and what failure means. Do not write any implementation code.',          300,  400, 'claude-code', cc('tester'),     [s2]);
    step(wfId, s4, 'Develop',         'Build the feature following the architecture plan.',                                                                                                                                   300,  575, 'claude-code', cc('backend'),    [s3]);
    step(wfId, s5, 'Run Tests',       'Execute the tests defined in Define Tests. All acceptance criteria must pass.',                                                                                                        300,  750, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }], maxCycles: 3 }, [s4]);
    step(wfId, s6, 'Security & Lint', 'Full lint + security check.',                                                                                                                                                          300,  925, 'quality-gate', gate('security'), [s5]);
    step(wfId, s7, 'Summary',         'Document all changes, test results, and manual testing instructions.',                                                                                                                 300, 1100, 'claude-code', cc('planner'), [s6]);
    step(wfId, s8, 'Notify',          'System notification: New Feature workflow complete.',                                                                                                                             300, 1275, 'connector',
      { connectorType: 'system-notify', title: 'New Feature — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s7]);
  }

  // ── 5. CI/CD Pipeline ─────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID();
    insertWorkflow.run(wfId, 'CI/CD Pipeline',
      'Code review → unit tests → integration tests → security → notify.', now);
    step(wfId, s1, 'Code Review',           'Review code quality, patterns, and edge cases.',                                                                                                                                 300,  50, 'quality-gate', gate('full-review'), []);
    step(wfId, s2, 'Run Unit Tests',        'Execute full unit test suite.',                                                                                                                                                  300, 225, 'quality-gate',
      { ...gate('test'), routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s1 }], maxCycles: 1 }, [s1]);
    step(wfId, s3, 'Run Integration Tests', 'Execute integration and end-to-end tests.',                                                                                                                                      300, 400, 'claude-code',
      cc('tester', { systemPrompt: 'Run all integration and e2e tests. Report STATUS: PASS or STATUS: FAIL in your result.' }), [s2]);
    step(wfId, s4, 'Security Scan',         'Audit for OWASP issues, auth flaws, and credential exposure.',                                                                                                                   300, 575, 'quality-gate', gate('security'), [s3]);
    step(wfId, s5, 'Notify',                'System notification: CI/CD Pipeline workflow complete.',                                                                                                                  300, 750, 'connector',
      { connectorType: 'system-notify', title: 'CI/CD Pipeline — Done', message: '{{workflowName}} finished. Check NeonCore for results.' }, [s4]);
  }

  // ── 6. Feature Validation ─────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Feature Validation',
      'TDD-based feature validation: specify → define/review tests (human gate) → evaluate code → implement gaps → run tests → final report. Enter the feature description (and optional Jira epic key) in the launch prompt.', now);

    // Step 1: Feature Specification — spec is entered at launch time; step enriches it with Jira data if provided
    step(wfId, s1, 'Feature Specification',
      'Reads the specification entered at launch. If a Jira epic key was included, fetches the epic and all its tasks and merges requirements into the spec. Outputs a structured Feature Spec document passed to every subsequent step.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The feature specification has been provided at launch (shown above). Your job is to structure it clearly and, if a Jira epic key was included, enrich it with the full epic task details.\n\n**STEP 1 — PARSE THE PROVIDED SPEC**\nRead the specification above carefully. Extract:\n- Feature name and functional description\n- Architectural expectations (layers, components, routes, DB tables, APIs)\n- Acceptance criteria\n- Edge cases and error states\n\n**STEP 2 — FETCH JIRA EPIC (if a key was provided)**\nIf the spec contains a Jira epic key (e.g. GRD-500):\n1. Discover the Jira CLI (`jira --version`, `jira-cli --version`, or project scripts).\n2. Fetch the epic and ALL its child tasks (stories, bugs, tasks, subtasks — recurse fully).\n3. For each task: collect title, status, description, and acceptance criteria.\n\n**STEP 3 — OUTPUT THE STRUCTURED FEATURE SPEC**\n\n```\n## Feature Specification\n\n### Feature Overview\n[What the feature does from a user perspective]\n\n### Architecture\n[Which layers, services, files, DB tables, API routes, and UI components are involved]\n\n### Functional Requirements\n[Numbered list of every requirement — each must be testable]\n\n### Acceptance Criteria\n- [ ] [every condition that must be true for the feature to be complete]\n\n### Edge Cases & Error States\n[Every edge case and expected handling]\n\n### Jira Epic Tasks (if applicable)\n| Key | Title | Status | Requirements |\n|-----|-------|--------|---------------|\n[one row per task]\n```\n\nOutput this document in full — it is the source of truth for all subsequent steps.',
      }, []);

    // Step 2: Test Discovery & Creation — find existing tests, write missing ones, STOP for human review
    step(wfId, s2, 'Test Discovery & Creation',
      'Find all existing tests related to this feature, identify gaps against the spec, write new tests for uncovered behaviors. STOPS for human review — you must confirm the tests truly validate the feature before the workflow continues.',
      300, 310, 'claude-code',
      {
        ...cc('tester'),
        prompt: 'Using the Feature Specification from the previous step, you must (1) find all existing tests related to this feature, (2) identify coverage gaps, and (3) write new tests for anything not already covered.\n\n**RULE: This step must NOT auto-advance. You will output a test manifest and wait for human approval.**\n\n### PHASE 1 — DISCOVER EXISTING TESTS\n1. Use Grep, Glob, and Read to search the entire test suite for tests related to this feature.\n   - Search by feature name, component names, route paths, function names, DB table names, and key terms from the Feature Specification.\n   - Look in all test directories: `*.test.ts`, `*.spec.ts`, `*.test.tsx`, `__tests__/`, `test/`, `spec/` and any other test file patterns in this project.\n2. For each relevant test found, record:\n   - File path and test name/describe block\n   - What behavior it validates\n   - Whether it maps to a requirement in the Feature Spec\n\n### PHASE 2 — IDENTIFY GAPS\nCross-reference every requirement and acceptance criterion from the Feature Spec against the existing tests.\nFor each requirement, answer: Is it covered? If YES — by which test(s)? If NO — what test is needed?\n\n### PHASE 3 — WRITE MISSING TESTS\nFor every gap identified:\n1. Write real, runnable tests that assert the behavior described in the spec.\n2. Each new test must cover: happy path + at least 2 edge cases + at least 1 error state per requirement.\n3. Tests must be written so they FAIL before the implementation is correct — do not write tests that trivially pass.\n4. Follow the existing test patterns, frameworks, and conventions used in this project (detect from existing test files).\n5. Save new tests to the appropriate test file(s) — either extending an existing file or creating a new one following the project conventions.\n\n### PHASE 4 — OUTPUT THE TEST MANIFEST\nOutput the complete manifest in this exact format — do NOT advance automatically:\n\n```\n## Test Manifest for: [Feature Name]\n\n### Existing Tests (covers this feature)\n| File | Test Name | Requirement Covered |\n|------|-----------|--------------------|\n[one row per relevant test]\n\n### New Tests Written\n| File | Test Name | Requirement Covered | Status |\n|------|-----------|---------------------|--------|\n[one row per new test, Status = NEW]\n\n### Coverage Summary\n- Requirements from spec: N\n- Fully covered by existing tests: N\n- Covered by new tests: N\n- Remaining gaps (if any): N — [list them]\n\n### Instructions for Human Review\nPlease review the test manifest above and confirm:\n1. Do the existing tests truly validate the listed requirements?\n2. Do the new tests cover the gaps accurately?\n3. Are there any additional scenarios you want tested?\n\nOnce you are satisfied, advance this step manually to continue the workflow.\n```',
      }, [s1], false);

    // Step 3: Code Evaluation — deep analysis of current implementation vs spec
    step(wfId, s3, 'Code Evaluation',
      'Thoroughly evaluate the current codebase against the Feature Specification. Identify every gap, incorrect behavior, and missing implementation.',
      300, 540, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'Using the Feature Specification (step 1) and the Test Manifest (step 2), perform a deep, thorough evaluation of the current codebase to determine how well the feature is implemented.\n\n**Do NOT make any code changes in this step — only investigate and report.**\n\n### PHASE 1 — MAP THE IMPLEMENTATION\nTrace every file, function, route, component, hook, and DB query involved in this feature using Read, Grep, and Glob.\nFollow the data flow end-to-end: from the user trigger → through every layer → to the final output/state change.\n\n### PHASE 2 — EVALUATE EACH REQUIREMENT\nFor every requirement and acceptance criterion in the Feature Spec, answer:\n- Is it implemented? (YES / PARTIAL / NO)\n- If YES: which code handles it and does it match the spec exactly?\n- If PARTIAL: what part is missing or wrong?\n- If NO: what needs to be built?\n\n### PHASE 3 — IDENTIFY BUGS & GAPS\nAlso check for:\n- Logic errors that would cause wrong behavior\n- Missing error handling on async calls, DB queries, or API responses\n- Race conditions or state inconsistencies\n- Missing input validation\n- Edge cases from the spec that are not handled\n- Architectural mismatches (wrong layer, wrong data flow)\n\n### PHASE 4 — OUTPUT THE EVALUATION REPORT\n```\n## Code Evaluation Report\n\n### Implementation Status per Requirement\n| Requirement | Status | Files | Notes |\n|-------------|--------|-------|-------|\n[one row per requirement from the Feature Spec — Status: ✅ Implemented / ⚠️ Partial / ❌ Missing]\n\n### Gaps & Issues Found\n| Severity | File:Line | Description | Fix Needed |\n|----------|-----------|-------------|------------|\n[one row per gap or bug — Severity: critical / high / medium / low]\n\n### Summary\n- Fully implemented: N/N requirements\n- Partially implemented: N requirements\n- Not implemented: N requirements\n- Bugs/issues found: N (critical: X, high: Y, medium: Z, low: W)\n\n### Verdict\n[STATUS: COMPLETE — all requirements fully implemented with no issues]\n[STATUS: INCOMPLETE — list the top items that must be fixed]\n```',
      }, [s2]);

    // Step 4: Code Implementation — fix gaps, never touch tests
    step(wfId, s4, 'Code Implementation',
      'Implement all missing or incorrect code identified in the Code Evaluation. Fix every gap in priority order. Do NOT modify any test files.',
      300, 770, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'Using the Code Evaluation Report from the previous step, implement all fixes and additions needed to make the feature fully comply with the Feature Specification.\n\n**CRITICAL RULE: You must NEVER modify, delete, or weaken any test file. If a test exposes a bug in the implementation, fix the implementation — not the test.**\n\n### IMPLEMENTATION ORDER\nWork through issues in this priority order:\n1. **Critical** — crashes, data corruption, completely missing core paths\n2. **High** — wrong behavior on the happy path, missing required logic\n3. **Medium** — edge cases not handled, partial implementations\n4. **Low** — minor issues, missing error state handling\n\nFor each gap from the evaluation report:\n1. Read the relevant files to understand the existing patterns and conventions.\n2. Implement the minimal correct change — do not refactor beyond what is needed.\n3. Follow the architecture described in the Feature Specification.\n4. Handle all error states and edge cases specified.\n5. Log each change: `IMPLEMENTED [file:line] — [brief description of what was changed and why]`\n\n### AFTER ALL CHANGES\nOutput:\n```\n## Implementation Summary\n\n### Changes Made\n[List of all IMPLEMENTED log lines]\n\n### Gaps Resolved\n[Map each fix to the requirement it addresses]\n\n### Remaining Issues (if any)\n[Anything that could not be implemented and why]\n\nTotal files changed: N | Requirements now fully implemented: N/N\n```',
      }, [s3]);

    // Step 5: Run Tests — quality-gate loops back to implementation if tests fail
    step(wfId, s5, 'Run Tests',
      'Execute all tests from the Test Manifest. If any fail, the code is fixed — tests are never changed. Loops back to Code Implementation on failure (max 3 cycles).',
      300, 1000, 'quality-gate',
      {
        ...gate('test'),
        routingRules: [{ id: randomUUID(), condition: 'contains', value: 'STATUS: FAIL', nextStepId: s4 }],
        maxCycles: 3,
        includeDepOutput: true,
      }, [s4]);

    // Step 6: Final Report — full summary, requires human review before closing
    step(wfId, s6, 'Final Report',
      'Compile the complete validation report: what was specified, what tests were written, what code was changed, and the final test results. Requires human review.',
      300, 1175, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Compile the final Feature Validation report using all outputs from every previous step. Be thorough and precise.\n\n```\n## Feature Validation Report\n\n### Feature\n[Feature name and 1-sentence description]\n\n### Specification Summary\n[Bullet list of the key requirements from the Feature Spec]\n\n### Tests\n#### Existing Tests (pre-existing, related to this feature)\n| File | Test | Requirement |\n|------|------|-------------|\n\n#### New Tests Written\n| File | Test | Requirement |\n|------|------|-------------|\n\n### Code Changes\n#### What was already implemented correctly\n[Bullet list]\n\n#### What was fixed or added\n| File | Change | Requirement |\n|------|--------|-------------|\n\n### Test Results\n| Test | Result | Detail |\n|------|--------|--------|\n[one row per test from the run — PASS or FAIL]\n\n### Requirements Coverage\n| Requirement | Tests | Code | Status |\n|-------------|-------|------|--------|\n[one row per requirement from the Feature Spec]\n\n### Summary\n- Requirements: N total | N fully validated | N with gaps\n- Tests: N existing + N new = N total | N passed | N failed\n- Code changes: N files modified\n\n### Overall Verdict\n**STATUS: PASS** — all requirements implemented and all tests passing\n**STATUS: FAIL** — list the specific requirements or tests that are still not satisfied\n\n### Next Steps (if STATUS: FAIL)\n[Numbered list of remaining action items, highest severity first]\n```',
      }, [s5], false);

    // Step 7: Notify
    step(wfId, s7, 'Notify',
      'System notification: Feature Validation workflow complete.',
      300, 1350, 'connector',
      { connectorType: 'system-notify', title: 'Feature Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the full validation report.' }, [s6]);
  }

  // ── 7. Deep Research ──────────────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(), s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Deep Research',
      'Set the workflow description to the research subject — it is automatically injected into the first step. Web + local research → synthesis → your review → epic planning → save epic → optional Jira creation → notify.', now);

    // Step 1: Deep Research — search web + local dirs
    step(wfId, s1, 'Deep Research', 'Search the web and local codebase for papers, articles, and ideas on the subject.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'You are conducting deep research on the subject described above.\n\nDo both of the following:\n\n1. WEB RESEARCH — Use the WebSearch and WebFetch tools to find: academic papers, technical articles, blog posts, GitHub repos, documentation, and any other relevant online resources. Go at least 3 levels deep on the most promising leads. For each source: note the title, URL, key insights, and how it relates to the subject.\n\n2. LOCAL RESEARCH — Search the local project files for any existing work, prior art, related features, or relevant patterns using Read, Glob, and Grep tools.\n\nOutput all findings in a structured document:\n## Web Findings\n[Source-by-source: title, URL, key insight]\n\n## Local Findings\n[File paths and relevant code/content]\n\n## Key Ideas & Themes\n[Synthesized list of the most important concepts discovered]',
      }, []);

    // Step 2: Idea Synthesis — compile into a clean research brief
    step(wfId, s2, 'Idea Synthesis', 'Compile all research findings into a structured brief organized by theme, opportunity, and approach.',
      300, 310, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'Using the research findings above, compile a clean, structured research brief:\n\n## Research Brief: [Subject]\n\n### Executive Summary\n[2-3 sentences on what the research found and why it matters]\n\n### Key Themes\n[Bullet list of the major themes that emerged]\n\n### Top Ideas & Opportunities\n[Numbered list of the most promising ideas, each with: what it is, why it matters, how it could apply]\n\n### Technical Approaches\n[Concrete implementation approaches found in research]\n\n### Open Questions\n[Things that need further investigation or user decisions]\n\n### Recommended Direction\n[Your top recommendation based on the research, with rationale]',
      }, [s1]);

    // Step 3: Your Review — agent surfaces the brief and asks for user input via AskUserQuestion
    step(wfId, s3, 'Your Review', 'Read the research brief. The agent will ask for your comments and direction — respond via the question prompt in NeonCore.',
      300, 540, 'claude-code',
      {
        ...cc('general'), autoAdvance: false,
        prompt: 'The research brief from the previous step is ready for human review. Do the following:\n\n1. Present the research brief clearly and in full so the user can read it.\n\n2. Then use the AskUserQuestion tool with this exact question:\n"Please share your comments, direction, and priorities for the epic. What should be the focus? Any constraints, preferences, or ideas you want incorporated? (Your response will be passed directly to the epic planning step.)"\n\n3. After the user responds, output their response verbatim under a heading:\n## User Direction\n[user\'s response here]\n\nDo not advance or do anything else — end there.',
      }, [s2]);

    // Step 4: Epic Planning — write full scoped epic based on research + user direction
    step(wfId, s4, 'Epic Planning', 'Write the full scoped epic document based on the research brief and your review comments.',
      300, 770, 'claude-code',
      {
        ...cc('architect'),
        prompt: 'Using the research brief and the user\'s direction from the previous step, write a comprehensive epic scope document in this exact format:\n\n# Epic: [Subject Name]\n\n## Overview\n[2-3 paragraphs: what this epic is, why it matters, what it delivers]\n\n## Business Goals\n- **[Goal 1]**: [description]\n- **[Goal 2]**: [description]\n(continue for all key goals)\n\n## Current State\n| Component | Current State |\n|-----------|---------------|\n[table of what exists today]\n\n## Target State\n| Component | Target State |\n|-----------|---------------|\n[table of what we\'re building toward]\n\n## Constraints\n- **[Constraint 1]**: [description]\n(list all technical, product, or business constraints)\n\n## Task Breakdown\n\n### Phase 1: [Phase Name]\n| Task | Title | Description | Size | Dependencies |\n|------|-------|-------------|------|--------------|\n| [ID]-001 | [Title] | [Description] | S/M/L | None |\n(continue for all tasks)\n\n### Phase 2: [Phase Name]\n[same format]\n\n## Open Questions\n[Numbered list of unresolved decisions]\n\n## Success Metrics\n[How we\'ll know this epic is done and working]',
      }, [s3]);

    // Step 5: Save Epic — write the file to the scoping folder
    step(wfId, s5, 'Save Epic', 'Write the completed epic document to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/',
      300, 1000, 'claude-code',
      {
        ...cc('general'),
        prompt: 'Take the epic document written in the previous step and save it as a file.\n\n1. Derive a short kebab-case slug from the epic subject (e.g. "mcp-integration", "voice-search", "offline-mode").\n\n2. Write the full epic content to:\n/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md\n\nUse the Write tool to create the file. Do not modify the epic content — copy it exactly.\n\n3. Confirm with: "✅ Epic saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/scoping/EPIC-[slug].md"',
      }, [s4]);

    // Step 6: Create in Jira? — ask user YES/NO, then create epic + tasks if YES
    step(wfId, s6, 'Create in Jira?',
      'Ask whether to create this epic and all its tasks in Jira. If YES: creates the Jira epic, creates every task linked to it, and saves task files to .claude/tasks/.',
      300, 1230, 'claude-code',
      {
        ...cc('general'),
        prompt: 'The epic document has been saved. Now check if the user wants to create it in Jira.\n\n**STEP A — PRESENT THE PLAN**\nFrom the Epic Planning step output, extract and display a concise summary:\n- Epic title\n- Total task count across all phases\n- Phase breakdown (Phase name → N tasks)\n\n**STEP B — ASK THE USER**\nUse the AskUserQuestion tool with this exact question:\n"Create this epic and all [N] tasks in Jira?\n\nReply YES to create everything (you can include your Jira project key, e.g. YES GRD).\nReply NO to skip Jira and finish the workflow."\n\n**STEP C — ACT ON THE RESPONSE**\n\nIf the user replied NO (or anything other than YES):\n→ Output: "⏭️ Skipping Jira — epic saved locally only." and stop.\n\nIf the user replied YES:\n\n1. DISCOVER JIRA CLI — check `jira --version`, `jira-cli --version`, or project scripts to identify the available Jira CLI tool and syntax. Determine the project key (from the user\'s reply or from any existing Jira config/env in the project).\n\n2. CREATE THE JIRA EPIC — create the epic in Jira using the CLI. Use the epic title from the epic document as the summary, and the Overview section as the description. Note the created epic key (e.g. GRD-500).\n\n3. CREATE ALL TASKS — for every task in every phase of the Task Breakdown table, create a Jira issue linked to the epic. For each task:\n   - Summary = task title from the table\n   - Description = full task description from the table\n   - Labels / story points = Size (S=1, M=3, L=5, XL=8)\n   - Epic link = the epic key created above\n   - Note the created issue key (e.g. GRD-501)\n\n4. SAVE TASK FILES — for each created Jira issue, save a task file to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/[ISSUE-KEY].md using this exact format:\n```\n# [ISSUE-KEY]: [Task ID] - [Title]\n\n## Task Details\n- **Jira:** [ISSUE-KEY]\n- **Branch:** [ISSUE-KEY-lowercase-kebab-title]\n- **Created:** [today\'s date YYYY-MM-DD]\n- **Epic:** [Epic title]\n- **Phase:** [Phase number and name from Task Breakdown]\n- **Size:** [S/M/L/XL]\n- **Dependencies:** [Dependencies from table, or None]\n\n## Description\n[Full description from the Task Breakdown table]\n\n## Acceptance Criteria\n- [ ] [Derive 3-5 acceptance criteria from the description]\n\n## Technical Notes\n[Any relevant technical context from the epic document]\n\n## Progress\n- [ ] Task started\n```\n\n5. OUTPUT a completion report:\n```\n✅ Jira Epic created: [EPIC-KEY] — [Epic Title]\n\nTasks created ([total]):\n| Issue | Phase | Title | Size |\n|-------|-------|-------|------|\n[one row per task]\n\nTask files saved to /Users/mannyhenri/Documents/Git/gridlight/.claude/tasks/\n```',
      }, [s5]);

    // Step 7: Notify — system notification when research is complete
    step(wfId, s7, 'Notify', 'System notification: Deep Research workflow complete.',
      300, 1460, 'connector',
      { connectorType: 'system-notify', title: 'Deep Research — Done', message: '{{workflowName}} finished. Your epic is ready in NeonCore.' }, [s6]);
  }

  // ── 8. Jira Tasks Validation ──────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID();
    insertWorkflow.run(wfId, 'Jira Tasks Validation',
      'Enter the Jira epic name or key in the launch prompt — each task in the epic is checked against the codebase and transitioned to In QA if requirements are met.', now);

    // Step 1: Fetch all tasks and save to file — output only path + count, not the full dump
    step(wfId, s1, 'Fetch & Save Tasks',
      'Query Jira for every task in the epic, save full details to a local MD file, and output only the file path and task count.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The Jira epic to validate is specified above.\n\n**IMPORTANT: Do NOT output task details to this conversation. Write everything to a file — the next step reads from disk. Process tasks one by one to stay within context limits.**\n\n1. DISCOVER JIRA CLI — Try `jira --version`, `jira-cli --version`, or look for jira scripts in package.json / Makefile. Identify the exact command syntax for this project.\n\n2. FIND PROJECT ROOT — Run `git rev-parse --show-toplevel` to get the absolute project root path.\n\n3. DERIVE SLUG — Convert the epic name to kebab-case (e.g. "Document Generation" → "document-generation").\n\n4. CREATE OUTPUT FILE — Create the directory and initialize the file with a header only:\n   Path: `{project-root}/.gridlight/jira-validation/{epic-slug}-tasks.md`\n   Header:\n   ```\n   # Jira Tasks — [Epic Name]\n   Fetched: [today\'s date]\n   ---\n   ```\n\n5. COLLECT ALL LEAF TASKS (recursive, any depth):\n   Start with the specified epic key. Use a queue/stack approach:\n   a. Fetch the direct children of the current item (use the Jira CLI to list child issues or search by parent/epic-link).\n   b. For each child: if it is itself an epic or has its own children (sub-epic), add it to the queue to recurse into — do NOT add it as a task.\n   c. If it is a leaf task (story, task, subtask, bug — no children of its own), add it to the task list.\n   d. Continue until the queue is empty. You now have all leaf-level tasks from the entire hierarchy.\n   Do not include parent epics in the task list — only leaf issues.\n   Order the final list by creation date.\n   Note the total count.\n\n6. ITERATE THROUGH EACH LEAF KEY — For every issue key, one at a time:\n   a. Fetch the full details for that single issue: title, current status, created date, description, acceptance criteria, technical notes.\n   b. IMMEDIATELY APPEND to the tasks file in this format:\n      ```\n      ## [ISSUE-KEY] — [Title]\n      **Status:** [current status] | **Created:** [date]\n      **Requirements:**\n      [full description and acceptance criteria]\n      ---\n      ```\n   c. Do not accumulate details in memory — fetch one, write one, move on.\n\n7. OUTPUT ONLY these two lines when done:\n   ```\n   Tasks file: {absolute path to the saved file}\n   Total tasks: N\n   ```',
      }, []);

    // Step 2: Read tasks from file, validate each, append results to a second file incrementally
    step(wfId, s2, 'Validate & Save Results',
      'Read the saved tasks file, validate each task against the codebase one by one, append results to a results file as it goes, and transition to "In QA" in Jira when requirements are met.',
      300, 310, 'claude-code',
      {
        ...cc('reviewer'),
        prompt: 'The previous step saved all Jira tasks to a file. Its output contains the file path.\n\n**IMPORTANT: Read the tasks from disk — do NOT rely on the task content being in the conversation context.**\n\n1. READ THE TASKS FILE — From the previous step output, extract the "Tasks file:" path and read it using the Read tool. This gives you the full task list with all requirements.\n\n2. READ THE EPIC SLUG — Derive it from the tasks filename (e.g. `document-generation-tasks.md` → slug is `document-generation`).\n\n3. PREPARE RESULTS FILE (MERGE MODE) — The results file path is:\n   `{same directory}/{epic-slug}-results.md`\n   Check if it already exists:\n   - **If it does NOT exist**: create it with this header:\n     ```\n     # Jira Validation Results — [Epic Name]\n     Validated: [today\'s date]\n     ---\n     ```\n   - **If it DOES exist**: read it and extract every ISSUE-KEY that already has a `VERDICT:` line. These tasks are already validated — skip them in this run. Then append a re-run separator:\n     ```\n     --- Re-run: [today\'s date] ---\n     ```\n   Do not delete or overwrite existing results — only append new ones.\n\n4. FOR EACH TASK in the tasks file (in order) that has NOT already been validated:\n\n   a. READ its requirements from the tasks file.\n\n   b. INVESTIGATE the codebase — use Read, Grep, and Glob to find the relevant implementation. Check:\n      - Is the feature/fix implemented?\n      - Do all details match the requirements exactly?\n      - Are edge cases and error states handled as specified?\n      - Are tests present if required?\n\n   c. DECIDE and ACT:\n      - **MEETS ALL REQUIREMENTS** → run the Jira CLI transition to move it to "Done"\n      - **DOES NOT FULLY MEET** → run the Jira CLI transition to move it to "To Do"\n\n   d. IMMEDIATELY APPEND this result to the results file (do not wait until all tasks are done):\n      ```\n      ## [ISSUE-KEY] — [Title]\n      VERDICT: ✅ Done | ❌ To Do\n      REASON: [1-2 sentences on what was found or what is specifically missing]\n      ---\n      ```\n\n5. After all tasks are processed, OUTPUT ONLY:\n   ```\n   Results file: {absolute path to results file}\n   ✅ Marked Done: N\n   ❌ Marked To Do: N\n   ⏭️ Skipped (already validated): N\n   ```\n\nDo not output individual task verdicts to the conversation — they are saved in the results file.',
      }, [s1]);

    // Step 3: Read results file from disk, compile final report — fresh context, no accumulated data
    step(wfId, s3, 'Summary Report',
      'Read the results file from disk and compile the final validation report with ✅/📋 tables and a summary paragraph.',
      300, 540, 'claude-code',
      {
        ...cc('planner'),
        prompt: 'The previous step saved all validation results to a file. Its output contains the file path.\n\n1. READ THE RESULTS FILE — From the previous step output, extract the "Results file:" path and read it using the Read tool.\n\n2. ALSO READ THE TASKS FILE — Replace "-results.md" with "-tasks.md" in the path to get the tasks file. Read it to get the epic name and any task titles you need.\n\n3. COMPILE THE REPORT in this exact format:\n\n---\n## Jira Epic Validation Report\n**Epic:** [epic name]\n**Validated:** [date from results file] | **Total tasks:** N | **✅ Done:** N | **📋 To Do:** N\n\n### ✅ Done ([count])\n| Issue | Title |\n|-------|-------|\n| [KEY] | [Title] |\n\n### 📋 To Do ([count])\n| Issue | Title | What\'s Missing |\n|-------|-------|----------------|\n| [KEY] | [Title] | [REASON from results file] |\n\n### What\'s Left — Summary\n[Write 2-4 sentences: overall completion state of the epic, the main areas of remaining work, any patterns in what\'s incomplete, and recommended next steps for the team.]\n\n---\n\nThe report above is your full output. Be precise — use the exact issue keys and reasons from the results file.',
      }, [s2], false);

    // Step 4: Notify
    step(wfId, s4, 'Notify',
      'System notification: Jira Tasks Validation workflow complete.',
      300, 770, 'connector',
      { connectorType: 'system-notify', title: 'Jira Validation — Done', message: '{{workflowName}} finished. Check NeonCore for the epic status report.' },
      [s3]);
  }

  // ── 9. Jira Tasks Completion ──────────────────────────────────────────────
  {
    const wfId = randomUUID();
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
    insertWorkflow.run(wfId, 'Jira Tasks Completion',
      'TDD-driven loop: completes To Do tasks one by one (understand → failing tests → implement → verify → update Jira + doc → commit → ask to continue). All looping happens inside step 2 — answering YES automatically starts the next task without re-running the workflow.', now);

    // Step 1: Load context — identify epic + results doc paths (minimal output)
    step(wfId, s1, 'Load Context',
      'Read the epic context, identify the results doc and project root. Outputs only the key paths — the work loop in step 2 handles all tasks.',
      300, 80, 'claude-code',
      {
        ...cc('researcher'), workflowContext: true,
        prompt: 'The Jira epic to work on is specified above.\n\n**Goal: identify the scope. Output only the key paths — do not load task details.**\n\n1. FIND PROJECT ROOT — Run `git rev-parse --show-toplevel`.\n\n2. DISCOVER JIRA CLI — Try `jira --version`, `jira-cli --version`, or look for project scripts.\n\n3. DERIVE EPIC SLUG — Convert the epic name to kebab-case (e.g. "Document Generation" → "document-generation").\n\n4. LOCATE THE RESULTS DOC — Expected path: `{project-root}/.gridlight/jira-validation/{epic-slug}-results.md`. Check if it exists.\n\n5. OUTPUT ONLY these lines:\n```\nEpic: [epic name]\nEpic slug: [kebab-slug]\nProject root: [absolute path]\nJira CLI: [command name]\nResults doc: [absolute path] (exists: YES/NO)\nTasks doc: [absolute path to {slug}-tasks.md]\n```',
      }, []);

    // Step 2: The main work loop — agent iterates internally through tasks
    step(wfId, s2, 'Work Through Tasks',
      'Main loop. For each To Do task: fetch Jira requirements → explore code → write failing tests → implement → run tests → update Jira + doc → commit → AskUserQuestion to continue. Answer YES to auto-start next task, NO to stop.',
      300, 310, 'claude-code',
      {
        ...cc('backend'),
        prompt: 'The previous step identified the epic, results doc path, and project root. You will now work through To Do tasks one at a time in a loop — do NOT stop after a single task unless the user says so or all tasks are done.\n\n**OVERALL LOOP — repeat until user says NO or no To Do tasks remain:**\n\n### PHASE 1 — PICK NEXT TASK\n- Read the results doc (or tasks doc if no results doc exists). Find the first task marked `VERDICT: ❌ To Do`.\n- If NO To Do tasks remain: output `🎉 All tasks in the epic are complete!` and END the loop. Do not call AskUserQuestion.\n- Otherwise note the ISSUE-KEY and Title — this is the current task.\n\n### PHASE 2 — UNDERSTAND\n- Use the Jira CLI to fetch full details for this one issue: description, acceptance criteria, technical notes.\n- Read the section for this issue in the tasks doc to cross-reference its originally-captured requirements.\n- Read the REASON line for this issue in the results doc — that tells you what was missing during validation.\n- Use Read/Grep/Glob to explore the codebase: what already exists? what is missing? where should the new code live? what patterns to follow?\n\n### PHASE 3 — WRITE TESTS FIRST (TDD)\n- Find the test file(s) for this area of the codebase.\n- Write real tests based on the requirements — NOT based on what the implementation will look like.\n- Each test must assert meaningful behavior: happy path + at least 2 edge cases + at least 1 error state per requirement.\n- Run the tests with Bash and CONFIRM they FAIL (since the implementation does not exist yet). If they pass before code is written, the tests are wrong — rewrite them.\n\n### PHASE 4 — IMPLEMENT\n- Write the minimum code needed to satisfy the requirements and make the tests pass.\n- Follow existing patterns, conventions, and architecture.\n- Do NOT modify the tests to make them pass — fix the implementation.\n- Handle error states and edge cases as specified.\n\n### PHASE 5 — VERIFY (with retry)\n- Run the tests using Bash. If any fail: go back to PHASE 4, fix the implementation, run again. Do this up to 3 times.\n- If after 3 attempts tests still fail: STOP the loop, output the failure details, and do not call AskUserQuestion.\n- Also run the full test suite (not just the new tests) to confirm nothing else broke.\n\n### PHASE 6 — FINALIZE\n- Use the Jira CLI to transition this issue to "Done".\n- In the results doc, find this issue\'s section and change:\n  - `VERDICT: ❌ To Do` → `VERDICT: ✅ Done`\n  - The REASON line to: `Implemented in this run — [brief 1-sentence description].`\n- Stage all changes (implementation files, test files, updated results doc).\n- Commit with message: `[ISSUE-KEY] [Title] — implement per Jira requirements`\n- Output a short confirmation: `✅ [ISSUE-KEY] done · commit [hash]`\n\n### PHASE 7 — ASK TO CONTINUE\n- Read the results doc again to find the NEXT task with `VERDICT: ❌ To Do`.\n- If no more To Do tasks: output `🎉 All tasks in the epic are complete!` and END the loop.\n- Otherwise use the AskUserQuestion tool with this exact message:\n  "✅ [just-completed KEY] — [just-completed title] done.\n\n  Next: [NEXT-KEY] — [next title]\n  [1-line description of what the next task requires]\n\n  Continue automatically to the next task? (YES / NO)"\n- If user replies YES (or anything starting with Y): GO BACK TO PHASE 1 and process the next task.\n- If user replies NO (or anything else): output `⏸️ Paused at user request. Resume anytime.` and END the loop.\n\n**Critical: only one task active at a time. Complete each phase fully before moving to the next. Never skip PHASE 3 (tests before implementation). The loop is mandatory — do not stop after one task unless the user says NO or tasks are exhausted or 3 consecutive test failures occur.**',
      }, [s1]);

    // Step 3: Notify
    step(wfId, s3, 'Notify',
      'System notification: Jira Tasks Completion run finished.',
      300, 540, 'connector',
      { connectorType: 'system-notify', title: 'Jira Tasks Completion — Done', message: '{{workflowName}} finished. Check NeonCore for the session report.' },
      [s2]);
  }

  console.log('[db] Seeded 9 default workflow templates');
}

seedDefaultTemplates();

export default db;
