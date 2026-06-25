#!/usr/bin/env node
/**
 * node-pty ships prebuilt `spawn-helper` binaries that are sometimes extracted
 * without the executable bit, causing `posix_spawnp failed` at runtime on
 * macOS/Linux. This postinstall hook restores +x on every prebuilt spawn-helper.
 * No-op on Windows (which uses ConPTY, not spawn-helper).
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

if (process.platform !== 'win32') {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds');
  try {
    if (existsSync(root)) {
      for (const dir of readdirSync(root)) {
        const helper = join(root, dir, 'spawn-helper');
        if (existsSync(helper) && statSync(helper).isFile()) {
          chmodSync(helper, 0o755);
          process.stdout.write(`[neoncore-relay] chmod +x ${helper}\n`);
        }
      }
    }
  } catch (err) {
    // Non-fatal: the relay also self-heals these perms at startup.
    process.stderr.write(`[neoncore-relay] fix-pty-perms warning: ${err}\n`);
  }
}
