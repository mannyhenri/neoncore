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

// Workflow tables
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    current_step INTEGER NOT NULL DEFAULT 0,
    steps_state TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (template_id) REFERENCES workflow_templates(id)
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_template ON workflow_runs(template_id);
`);

// Migration: add auto-run fields to workflow_templates
try {
  db.prepare('SELECT auto_run FROM workflow_templates LIMIT 1').get();
} catch {
  db.exec(`
    ALTER TABLE workflow_templates ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workflow_templates ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 60;
    ALTER TABLE workflow_templates ADD COLUMN trigger_when TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE workflow_templates ADD COLUMN last_auto_run_at TEXT;
  `);
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

// Cleanup: expire stale pending permissions from past sessions
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const expired = db.prepare(
  `UPDATE permissions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?`
).run(new Date().toISOString(), fiveMinAgo);
if (expired.changes > 0) {
  console.log(`[db] Expired ${expired.changes} stale pending permission(s) from past sessions`);
}

export default db;
