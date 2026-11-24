# Releasing the NeonCore iOS app

**Two paths.** A change to JavaScript only (screens, logic, styles, images) ships **over the
air** from your NeonCore server: `cd mobile && npm run ota:publish`. A change to native code or a
native dependency needs a **native build**: `npm run ios:release` builds Release and installs it
on your connected iPhone, signed with your **personal** Apple team (W7QXFS7XBU) — no App Store
account, no TestFlight. A personal team cannot sign Push Notifications, so this build leaves the
push entitlement out (`NeonCore.local.entitlements`), and the install expires after **7 days**:
run it again to renew. No Expo, no EAS, no cloud build service.

> The App Store / TestFlight path below needs a paid team. It was dropped on 2026-11-23 — the
> Gridlight team's archive was blocked on its Program License Agreement.

---

## Why it's this way

The app was **ejected from Expo** (see the `feat(mobile)!: eject from Expo` commit). That
wasn't cosmetic — Expo SDK 57 cannot compile under **Xcode 26.1 / Swift 6.2**:
`expo-modules-jsi` declares `swiftLanguageModes: [.v6]` but contains `weak let`, which Swift
6.2 rejects. Fixing that just exposes the next rule (`Sendable` classes need immutable stored
properties) — a catch-22 needing upstream changes. `expo@57.0.8` was already latest and even
the canary still had it, so there was nothing to upgrade into.

Dropping Expo removed the incompatible code entirely, so we build on the **latest Xcode** with
no pinning, no patching, and no waiting on upstream.

Two consequences that are permanent:

- **OTA is our own.** `expo-updates` is gone; NeonCore serves updates itself (see *Over-the-air
  updates* below), so a JS change no longer needs a build + TestFlight.
- **Push is APNs-direct.** `server/src/lib/apns-push.ts` talks to Apple over HTTP/2 with an
  ES256 JWT — zero dependencies, no Expo push service. Needs `APNS_KEY_PATH`, `APNS_KEY_ID`,
  `APNS_TEAM_ID` set on the server, using an **APNs Auth Key** (Apple Developer ▸ Keys ▸ Apple
  Push Notifications service). That is NOT the App Store Connect upload key — different page,
  not interchangeable.

---

## Over-the-air updates

The installed app downloads newer JavaScript from **its NeonCore server** (the first server it
was set up with) and switches to it the next time it opens. Pieces:

| Piece | Where |
|---|---|
| Publish | `npm run ota:publish` → `scripts/ota-publish.ts`: bundles for iOS, compiles to Hermes bytecode with the app's own Hermes, writes `mobile/updates/<version>/` (git-ignored) |
| Serve | `GET /api/mobile/update?runtime=…&current=…&since=…` and `/api/mobile/update/<version>/files/<path>` — `server/src/lib/mobile-updates.ts`, behind the fleet token. **Restart the server** after pulling this the first time. |
| Install | `NeonCoreUpdates` in `ios/NeonCore/NeonCorePush.swift`: checks 5 s after launch and whenever the app comes to the front, verifies every file's sha256, stages it, and switches on the next launch |
| Safety | A version that has not reported healthy (`src/ota.ts`, 4 s after start) after 3 launches is rolled back and never offered again. A new native build (new build number) drops every download and starts from the code built into it; an update published before that build is never offered to it. |

**The runtime number.** `OTA_RUNTIME` in `src/ota.ts` must equal `NeonCoreUpdates.runtime` in
the Swift (a test checks). Bump **both** whenever native code or a native dependency changes —
then do a native build: JavaScript built for one runtime is never offered to another.

Settings in the app shows the running version and has **Check for an update**.

Updates apply to **Release** builds only (TestFlight, or an Xcode Release run). A Debug build
loads from Metro as always.

---

## Release steps

**One command:** `cd mobile && npm run ios:release` (`scripts/build-ios.sh`) does steps 1–4 —
bumps the build in both configurations, runs `pod install` when needed, archives, and uploads to
App Store Connect (falls back to opening Organizer if the upload is refused). The manual steps:

### 1. Bump the version

- **Marketing version** (`0.6.0` → `0.7.0`) when the release is user-facing.
- **Build number** must always increase — App Store Connect rejects duplicates.

Both live in `ios/NeonCore.xcodeproj/project.pbxproj`:

```
MARKETING_VERSION = 0.6.0;
CURRENT_PROJECT_VERSION = 23;      # bump this every upload
```

There are **two** configurations (Debug and Release) carrying `CURRENT_PROJECT_VERSION`, and
both must move — bumping one and leaving the other is a partial change that builds fine and
produces a confusing upload.

`src/__tests__/standard-banner.test.ts` checks exactly that, against its own
`EXPECTED_BUILD` constant, so **bump the constant in the same commit as the pbxproj**. It went
stale for builds 34 and 35 because that step is easy to skip, which left the suite red and the
guard useless — a red test nobody expects to pass stops being a signal.

### 2. Install pods if native deps changed

```bash
cd mobile/ios && pod install
```

### 3. Archive

```bash
cd mobile
ARCHDIR="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)"
mkdir -p "$ARCHDIR"
xcodebuild -workspace ios/NeonCore.xcworkspace -scheme NeonCore -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHDIR/NeonCore <version> (<build>).xcarchive" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your team id> archive
```

Archiving into `~/Library/Developer/Xcode/Archives/<date>/` is what makes it appear in
Organizer without hunting for a file.

The archive signs with the **development** identity — that's normal. Xcode re-signs with the
distribution cert during Distribute.

### 4. Upload

**Xcode ▸ Window ▸ Organizer** → select the archive → **Distribute App** →
**TestFlight & App Store** → keep **Automatically manage signing** → **Upload**.

- Sign in first: **Xcode ▸ Settings ▸ Accounts**. An expired session fails the upload.
- If offered a team, choose your Apple Developer team.
- Leave **"Manage Version and Build Number" unchecked** so Xcode doesn't override the build
  number set in step 1.

Then **App Store Connect ▸ TestFlight**: ~5–30 min processing, then assign testers.
Export compliance won't prompt — `ITSAppUsesNonExemptEncryption = false` is in `Info.plist`.

---

## Gotchas that have actually bitten us

- **App icons are not optional.** The bare-RN template ships an `AppIcon.appiconset` with
  declared slots and **no image files**, which fails App Store validation. The full set (8
  iPhone + 9 iPad + 1 marketing) is committed, generated from `assets/icon.png` (1024×1024,
  **no alpha** — Apple rejects alpha). If you replace the icon, regenerate every size.
- **iPad icons are required.** The app is universal (`TARGETED_DEVICE_FAMILY = "1,2"`), so
  missing 76×76@2x / 83.5×83.5@2x fails validation even though the build only warns.
- **Never run two builds at once.** They share `ios/` and `DerivedData`, and produce bogus
  compile errors that look like real incompatibilities.
- **APNs environment must match.** TestFlight uses the **production** gateway; Xcode debug
  builds use **sandbox**. `aps-environment` is `development` in the entitlement (Xcode swaps
  it on App Store export) and the server defaults to production with `APNS_SANDBOX=1`
  available. Mismatching these is the classic "push works in Xcode, silent in TestFlight."
- **`ios/` is committed.** It's ours now, not regenerated. Don't run `expo prebuild` — there
  is no Expo. Edit the native project directly, or use the `xcodeproj` gem for structural
  changes (adding files/build settings) rather than hand-editing `project.pbxproj`.

---

## Automation

`scripts/build-ios.sh` (`npm run ios:release`) is the automation: plain `xcodebuild` archive +
`-exportArchive` upload, signed with the Xcode account you are logged into. There is still no
fastlane lane — the old one was written for Expo (it called `expo prebuild`) and was removed
rather than left as a trap.
