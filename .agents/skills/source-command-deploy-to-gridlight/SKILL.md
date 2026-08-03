---
name: "source-command-deploy-to-gridlight"
description: "Build and copy this app into the Gridlight desktop app's installed apps folder for testing"
---

# source-command-deploy-to-gridlight

Use this skill when the user asks to run the migrated source command `deploy-to-gridlight`.

## Command Template

# Deploy to Gridlight

Copy the current app into the Gridlight desktop installed apps folder so it can be tested in the Tauri app.

## Steps

1. **Identify the app and target**

Detect the current app directory name and target the Gridlight Application Support folder:
```bash
APP_NAME=$(basename "$PWD")
GRIDLIGHT_APPS="$HOME/Library/Application Support/Gridlight/apps"
echo "App: $APP_NAME"
echo "Target: $GRIDLIGHT_APPS/$APP_NAME"
ls "$GRIDLIGHT_APPS" 2>/dev/null || echo "WARNING: apps folder does not exist yet, will be created"
```

2. **Build the app**

If `package.json` has a `build` script, run it first:
```bash
if grep -q '"build"' package.json 2>/dev/null; then
  npm run build
fi
```

Report any build errors and stop if the build fails.

3. **Clean existing copy if present**

If the app directory already exists in gridlight/apps/, delete it first to ensure a completely fresh copy:
```bash
if [ -d "$GRIDLIGHT_APPS/$APP_NAME" ]; then
  echo "Removing existing $GRIDLIGHT_APPS/$APP_NAME/"
  rm -rf "$GRIDLIGHT_APPS/$APP_NAME"
fi
```

4. **Copy to Gridlight apps folder**

Use `rsync` to copy a fresh copy of the app, excluding dev-only files (quiet mode to avoid pipe buffering):
```bash
mkdir -p "$GRIDLIGHT_APPS/$APP_NAME"
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.Codex' \
  --exclude='.env' \
  --exclude='.DS_Store' \
  "$PWD/" "$GRIDLIGHT_APPS/$APP_NAME/"
```

5. **Install production dependencies in the deployed copy**

Since we excluded node_modules, install them fresh in the deployed location:
```bash
cd "$GRIDLIGHT_APPS/$APP_NAME" && npm install --production
```

6. **Confirm deployment**
```bash
echo "Deployed $APP_NAME to $GRIDLIGHT_APPS/$APP_NAME/"
ls -la "$GRIDLIGHT_APPS/$APP_NAME/"
```

Report the result — what was copied and the final state of the target directory.
