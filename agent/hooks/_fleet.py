"""
The fleet token, for hooks.

Hooks are spawned by Claude Code — not by the NeonCore server and not by your shell — so an
env var set for `npm start` never reaches them. Resolution is therefore env FIRST (so a remote
machine or a test can override), then the file the server publishes at ~/.neoncore/token.

Never raises. A hook that dies because it could not find a credential is worse than a hook
that sends none: in permissive mode the unauthenticated call still works and gets logged,
which is exactly the migration this supports. Returning {} keeps the old behaviour intact.
"""
import os

TOKEN_FILE = os.path.expanduser("~/.neoncore/token")


def fleet_token():
    """The token, or None. Env wins so a remote agent can point at another fleet."""
    env = (os.environ.get("NEONCORE_FLEET_TOKEN") or "").strip()
    if env:
        return env
    try:
        with open(TOKEN_FILE, "r") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def auth_headers():
    """Headers to merge into a request. Empty when no token is configured."""
    token = fleet_token()
    return {"Authorization": "Bearer " + token} if token else {}
