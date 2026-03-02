/**
 * Human-readable MCP tool display utilities.
 *
 * MCP servers expose tools with developer-oriented names and descriptions.
 * This module provides friendly labels and plain-English descriptions so
 * normal users understand what each tool can do.
 */

// ─── Friendly overrides for known tools ──────────────────────────

interface FriendlyTool {
  label: string;
  description: string;
}

/**
 * Map of tool names → user-friendly label + description.
 * Keyed by exact tool name. Prefix matches are handled separately.
 */
const TOOL_OVERRIDES: Record<string, FriendlyTool> = {
  // ── Jira ──
  jira_get: { label: 'Read Jira Data', description: 'Read an issue, project, board, sprint, or any Jira resource by ID or key' },
  jira_search: { label: 'Search Jira', description: 'Search for issues using JQL queries or keywords' },
  jira_create_issue: { label: 'Create Issue', description: 'Create a new Jira issue in a project' },
  jira_update_issue: { label: 'Update Issue', description: 'Update fields on an existing Jira issue' },
  jira_add_comment: { label: 'Add Comment', description: 'Add a comment to a Jira issue' },
  jira_transition_issue: { label: 'Move Issue', description: 'Transition an issue to a different status (e.g., In Progress → Done)' },
  jira_get_transitions: { label: 'Get Status Options', description: 'List available status transitions for an issue' },
  jira_list_projects: { label: 'List Projects', description: 'List all Jira projects you have access to' },

  // ── Slack ──
  slack_post_message: { label: 'Send Message', description: 'Post a message to a Slack channel' },
  slack_list_channels: { label: 'List Channels', description: 'See all channels in your Slack workspace' },
  slack_get_channel_history: { label: 'Read Channel', description: 'Read recent messages from a Slack channel' },
  slack_get_thread_replies: { label: 'Read Thread', description: 'Read replies in a message thread' },
  slack_get_users: { label: 'List Users', description: 'List all members in your Slack workspace' },
  slack_get_user_profile: { label: 'User Profile', description: 'Get profile info for a Slack user' },
  slack_add_reaction: { label: 'Add Reaction', description: 'React to a message with an emoji' },
  slack_search_messages: { label: 'Search Messages', description: 'Search for messages across Slack' },

  // ── GitHub ──
  create_or_update_file: { label: 'Create/Update File', description: 'Create or update a file in a GitHub repo' },
  search_repositories: { label: 'Search Repos', description: 'Search for GitHub repositories' },
  create_repository: { label: 'Create Repo', description: 'Create a new GitHub repository' },
  get_file_contents: { label: 'Read File', description: 'Read a file from a GitHub repository' },
  push_files: { label: 'Push Files', description: 'Push multiple files to a repo in one commit' },
  create_issue: { label: 'Create Issue', description: 'Create a new GitHub issue' },
  create_pull_request: { label: 'Create PR', description: 'Create a new pull request' },
  fork_repository: { label: 'Fork Repo', description: 'Fork a GitHub repository' },
  create_branch: { label: 'Create Branch', description: 'Create a new branch in a repo' },
  list_commits: { label: 'List Commits', description: 'View recent commits on a branch' },
  list_issues: { label: 'List Issues', description: 'List issues for a repository' },
  update_issue: { label: 'Update Issue', description: 'Update a GitHub issue' },
  add_issue_comment: { label: 'Comment on Issue', description: 'Add a comment to a GitHub issue' },
  search_code: { label: 'Search Code', description: 'Search for code across GitHub repositories' },
  search_issues: { label: 'Search Issues', description: 'Search for issues and pull requests' },
  search_users: { label: 'Search Users', description: 'Search for GitHub users' },
  get_issue: { label: 'Get Issue', description: 'Get details of a specific GitHub issue' },
  get_pull_request: { label: 'Get PR', description: 'Get details of a pull request' },
  list_pull_requests: { label: 'List PRs', description: 'List pull requests for a repository' },

  // ── Google Drive ──
  gdrive_list_files: { label: 'List Files', description: 'List files and folders in Google Drive' },
  gdrive_read_file: { label: 'Read File', description: 'Read the contents of a file from Google Drive' },
  gdrive_search: { label: 'Search Drive', description: 'Search for files in Google Drive' },
  gdrive_create_file: { label: 'Create File', description: 'Create a new file in Google Drive' },

  // ── Gmail ──
  gmail_search: { label: 'Search Email', description: 'Search your Gmail inbox for messages' },
  gmail_read: { label: 'Read Email', description: 'Read the contents of an email' },
  gmail_send: { label: 'Send Email', description: 'Compose and send an email' },

  // ── Spotify ──
  spotify_play: { label: 'Play Music', description: 'Play a track, album, or playlist on Spotify' },
  spotify_pause: { label: 'Pause', description: 'Pause the current playback' },
  spotify_next: { label: 'Next Track', description: 'Skip to the next track' },
  spotify_previous: { label: 'Previous Track', description: 'Go back to the previous track' },
  spotify_search: { label: 'Search Music', description: 'Search for tracks, albums, playlists, or podcasts' },
  spotify_current_playback: { label: 'Now Playing', description: 'See what\'s currently playing and on which device' },
  spotify_get_devices: { label: 'List Devices', description: 'List your available Spotify Connect devices' },
  spotify_set_volume: { label: 'Set Volume', description: 'Adjust playback volume (0-100)' },
  spotify_health_check: { label: 'Health Check', description: 'Check if Spotify connection is working' },
  spotify_get_auth_status: { label: 'Auth Status', description: 'Check authentication status' },
  spotify_setup_instructions: { label: 'Setup Help', description: 'Get instructions for connecting your Spotify account' },

  // ── OpenAI ──
  openai_chat: { label: 'Chat with GPT', description: 'Send a prompt to an OpenAI model and get a response' },
  openai_complete: { label: 'Complete Text', description: 'Generate text completion using OpenAI' },

  // ── Gemini ──
  gemini_chat: { label: 'Chat with Gemini', description: 'Send a prompt to Google Gemini and get a response' },

  // ── Fetch / Web ──
  fetch: { label: 'Fetch URL', description: 'Download and parse content from any web URL' },
  fetch_url: { label: 'Fetch URL', description: 'Download and parse content from any web URL' },

  // ── Filesystem ──
  read_file: { label: 'Read File', description: 'Read the contents of a file on disk' },
  write_file: { label: 'Write File', description: 'Write content to a file' },
  list_directory: { label: 'List Directory', description: 'List files and folders in a directory' },
  create_directory: { label: 'Create Folder', description: 'Create a new directory' },
  move_file: { label: 'Move/Rename', description: 'Move or rename a file' },
  search_files: { label: 'Search Files', description: 'Search for files by name or content' },
  get_file_info: { label: 'File Info', description: 'Get metadata about a file (size, modified date, etc.)' },
  read_multiple_files: { label: 'Read Multiple', description: 'Read several files at once' },
  list_allowed_directories: { label: 'Allowed Dirs', description: 'Show which directories the server can access' },

  // ── Brave Search ──
  brave_web_search: { label: 'Web Search', description: 'Search the web and get structured results' },
  brave_local_search: { label: 'Local Search', description: 'Search for local businesses and places' },

  // ── Blender ──
  blender_execute: { label: 'Run Script', description: 'Execute a Blender Python script' },
};

// ─── Display utilities ───────────────────────────────────────────

/**
 * Convert a snake_case tool name to a readable label.
 * e.g., "jira_create_issue" → "Create Issue", "slack_post_message" → "Post Message"
 */
function snakeToLabel(name: string): string {
  // Strip common prefixes (server slug)
  const prefixes = [
    'jira_', 'slack_', 'github_', 'gdrive_', 'gmail_',
    'spotify_', 'openai_', 'gemini_', 'blender_', 'brave_',
  ];
  let cleaned = name;
  for (const prefix of prefixes) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length);
      break;
    }
  }

  return cleaned
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Clean up an MCP tool description: strip markdown, take first sentence,
 * remove developer jargon.
 */
function cleanDescription(raw: string): string {
  if (!raw) return '';

  let text = raw
    // Strip markdown bold/italic
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    // Strip markdown links
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    // Strip markdown headers
    .replace(/#{1,6}\s/g, '');

  // Take first sentence (up to first period followed by space or end)
  const sentenceEnd = text.search(/\.\s|\.$/);
  if (sentenceEnd > 0 && sentenceEnd < 150) {
    text = text.slice(0, sentenceEnd + 1);
  } else if (text.length > 150) {
    text = text.slice(0, 147) + '...';
  }

  return text.trim();
}

/**
 * Get a human-friendly label and description for an MCP tool.
 * Uses curated overrides for known tools, falls back to cleaned-up originals.
 */
export function friendlyTool(
  toolName: string,
  originalDescription?: string,
): { label: string; description: string } {
  const override = TOOL_OVERRIDES[toolName];
  if (override) return override;

  return {
    label: snakeToLabel(toolName),
    description: cleanDescription(originalDescription || ''),
  };
}

// ─── Preview capabilities for preconfigured servers ──────────────
// Shown even when the server is stopped so users know what's possible.

interface CapabilityPreview {
  label: string;
  description: string;
}

const SERVER_CAPABILITIES: Record<string, CapabilityPreview[]> = {
  spotify: [
    { label: 'Search Music', description: 'Find tracks, albums, playlists, and podcasts' },
    { label: 'Play Music', description: 'Play a track, album, or playlist on any connected device' },
    { label: 'Pause / Skip / Previous', description: 'Control playback — pause, next, or go back' },
    { label: 'Now Playing', description: 'See what\'s currently playing and on which device' },
    { label: 'Volume Control', description: 'Adjust playback volume (0-100)' },
    { label: 'List Devices', description: 'See your available Spotify Connect devices' },
  ],
  jira: [
    { label: 'Read Jira Data', description: 'Read issues, projects, boards, sprints by ID or key' },
    { label: 'Search Jira', description: 'Search for issues using JQL or keywords' },
    { label: 'Create Issue', description: 'Create a new issue in any project' },
    { label: 'Update Issue', description: 'Edit fields on an existing issue' },
    { label: 'Move Issue', description: 'Transition an issue to a different status' },
    { label: 'Add Comment', description: 'Comment on a Jira issue' },
  ],
  slack: [
    { label: 'Send Message', description: 'Post a message to any Slack channel' },
    { label: 'Read Channel', description: 'Read recent messages from a channel' },
    { label: 'List Channels', description: 'See all channels in your workspace' },
    { label: 'Search Messages', description: 'Search for messages across Slack' },
    { label: 'Read Thread', description: 'Read replies in a message thread' },
    { label: 'React to Message', description: 'Add an emoji reaction to a message' },
  ],
  github: [
    { label: 'Search Repos', description: 'Search for GitHub repositories' },
    { label: 'Create Issue', description: 'Create a new issue in a repo' },
    { label: 'Create PR', description: 'Open a new pull request' },
    { label: 'Read File', description: 'Read a file from any repository' },
    { label: 'Search Code', description: 'Search for code across GitHub' },
    { label: 'Push Files', description: 'Push multiple files in one commit' },
    { label: 'List Issues / PRs', description: 'Browse issues and pull requests' },
  ],
  'google-drive': [
    { label: 'List Files', description: 'Browse files and folders in Google Drive' },
    { label: 'Read File', description: 'Read the contents of a Drive file' },
    { label: 'Search Drive', description: 'Search for files by name or content' },
    { label: 'Create File', description: 'Create a new file in Google Drive' },
  ],
  gmail: [
    { label: 'Search Email', description: 'Search your inbox for messages' },
    { label: 'Read Email', description: 'Read the contents of an email' },
    { label: 'Send Email', description: 'Compose and send an email' },
  ],
  openai: [
    { label: 'Chat with GPT', description: 'Send a prompt to GPT-4 or other OpenAI models' },
  ],
  gemini: [
    { label: 'Chat with Gemini', description: 'Send a prompt to Google Gemini' },
  ],
  'brave-search': [
    { label: 'Web Search', description: 'Search the web and get structured results' },
    { label: 'Local Search', description: 'Find local businesses and places' },
  ],
  fetch: [
    { label: 'Fetch URL', description: 'Download and parse content from any web page' },
  ],
  filesystem: [
    { label: 'Read / Write Files', description: 'Read and write files on disk' },
    { label: 'List Directory', description: 'Browse files and folders' },
    { label: 'Search Files', description: 'Find files by name or content' },
  ],
  blender: [
    { label: 'Run Blender Script', description: 'Execute Python scripts in Blender to create 3D content' },
  ],
  'adobe-cc': [
    { label: 'Create Design', description: 'Create designs in Adobe Express programmatically' },
  ],
};

/**
 * Get preview capabilities for a preconfigured server (by slug).
 * Returns the curated list of what users can do, even when the server is stopped.
 * Returns null if no preview is available for this server.
 */
export function getServerCapabilityPreview(slug: string): CapabilityPreview[] | null {
  return SERVER_CAPABILITIES[slug] || null;
}
