# NeonCore

## Project Structure

This is an npm workspaces monorepo with three main packages:

- `server/` - Node.js orchestrator server (Express + Socket.io + SQLite)
- `dashboard/` - React web dashboard (Vite + TailwindCSS)
- `agent/` - Claude Code hooks (bash scripts installed on each machine)
- `extension/` - VS Code companion extension (for remote command relay)

## Development

```bash
npm install              # Install all dependencies
npm run dev:server       # Start server (port 4040)
npm run dev:dashboard    # Start dashboard dev server (port 4041)
npm run build            # Build dashboard into server/public, then build server
npm start                # Start production server (serves dashboard from server/public)
npm run install:hooks    # Install Claude Code hooks on this machine
```

## Architecture

- **Hooks** (agent/) fire on Claude Code events, POST to server via HTTP
- **Server** (server/) manages agents, permissions, activity, trust mode
- **Dashboard** (dashboard/) connects via WebSocket for real-time updates
- **Extension** (extension/) enables remote command relay from dashboard to VS Code

## Key Files

- `server/src/index.ts` - Server entry point
- `server/src/db.ts` - SQLite schema and database setup
- `server/src/routes/` - REST API routes (agents, activity, permissions, trust, commands)
- `dashboard/src/App.tsx` - Dashboard entry component
- `dashboard/src/hooks/useAgents.ts` - Main state management hook
- `agent/hooks/permission-proxy.sh` - Permission interception hook
- `agent/hooks/reporter.sh` - Activity reporting hook
