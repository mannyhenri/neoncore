/**
 * Publish the phone app's JavaScript as an over-the-air update (server/src/lib/mobile-updates.ts).
 *
 *   cd mobile && npm run ota:publish            # bundle for iOS, then publish to mobile/updates/
 *   npm run ota:publish -- --from <folder>      # publish an already-built folder (main.jsbundle + assets)
 *   npm run ota:publish -- --no-hermes          # ship plain JavaScript instead of Hermes bytecode
 *
 * The update is offered to every installed app whose native runtime is OTA_RUNTIME (src/ota.ts);
 * each one downloads it and switches on its next launch. The version is the app's version plus
 * the time (0.8.0-20261123.2315).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishUpdate, updatesDir } from '../../server/src/lib/mobile-updates.ts';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = /OTA_RUNTIME = '([^']+)'/.exec(fs.readFileSync(path.join(MOBILE, 'src', 'ota.ts'), 'utf8'))?.[1];
if (!runtime) throw new Error('OTA_RUNTIME not found in src/ota.ts');
const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8')) as { version: string };
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '.').slice(0, 13);
const version = `${pkg.version}-${stamp}`;

const fromArg = process.argv.indexOf('--from');
let from = fromArg > 0 ? path.resolve(process.argv[fromArg + 1]) : '';
if (!from) {
  from = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncore-ota-'));
  console.log(`Bundling the app for iOS into ${from} …`);
  execFileSync('npx', ['react-native', 'bundle', '--platform', 'ios', '--dev', 'false', '--minify', 'true', '--entry-file', 'index.js',
    '--bundle-output', path.join(from, 'main.jsbundle'), '--assets-dest', from], { cwd: MOBILE, stdio: 'inherit' });
  if (!process.argv.includes('--no-hermes')) hermesCompile(path.join(from, 'main.jsbundle'));
}

/**
 * Compile the bundle to Hermes bytecode — exactly what Xcode's build does to the bundle it ships
 * (react-native-xcode.sh). The compiler must be the app's own Hermes: the one CocoaPods installed,
 * else the hermes-compiler package that react-native pins to the same version. Bytecode from
 * another Hermes would not load, and the app would roll back after a few failed launches.
 */
function hermesCompile(bundle: string): void {
  const bin = { darwin: 'osx-bin/hermesc', linux: 'linux64-bin/hermesc', win32: 'win64-bin/hermesc.exe' }[process.platform as string];
  const candidates = [
    path.join(MOBILE, 'ios', 'Pods', 'hermes-engine', 'destroot', 'bin', 'hermesc'),
    ...['node_modules', '../node_modules'].map((nm) => path.join(MOBILE, nm, 'hermes-compiler', 'hermesc', bin ?? '')),
  ];
  const hermesc = candidates.find((c) => bin && fs.existsSync(c));
  if (!hermesc) throw new Error(`No Hermes compiler found (looked in ${candidates.join(', ')}). Run \`pod install\` in mobile/ios, or publish with --no-hermes.`);
  const out = `${bundle}.hbc`;
  execFileSync(hermesc, ['-emit-binary', '-max-diagnostic-width=80', '-O', '-out', out, bundle], { stdio: 'inherit' });
  fs.renameSync(out, bundle);
  console.log(`Compiled to Hermes bytecode with ${path.relative(MOBILE, hermesc)}`);
}
const m = publishUpdate(from, { version, runtime, createdAt: now.toISOString() });
const bytes = m.files.reduce((n, f) => n + f.bytes, 0);
console.log(`Published ${m.version} for runtime ${m.runtime}: ${m.files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, in ${path.join(updatesDir(), m.version)}`);
console.log('Phones on this runtime pick it up when the app next comes to the front, and switch on the launch after.');
