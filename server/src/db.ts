import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

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

// FTS5 full-text search over session summaries and project knowledge
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

  // Populate FTS with existing data (safe to run multiple times; duplicates avoided by DELETE first)
  db.exec(`
    DELETE FROM sessions_fts;
    INSERT INTO sessions_fts(rowid, summary, project) SELECT rowid, summary, project FROM sessions WHERE summary != '';

    DELETE FROM knowledge_fts;
    INSERT INTO knowledge_fts(rowid, content, project, filename) SELECT rowid, content, project, filename FROM project_knowledge WHERE content != '';
  `);

  // Triggers to keep FTS in sync for future inserts/updates/deletes on sessions
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

export default db;
