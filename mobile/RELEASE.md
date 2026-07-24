# Releasing the NeonCore iOS app

**This is the process. Build locally with Xcode, upload via Organizer.** No Expo, no EAS, no
cloud build service. Everything below is on your Mac.

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

- **No OTA updates.** `expo-updates` is gone. Every JS change needs a full build + TestFlight.
- **Push is APNs-direct.** `server/src/lib/apns-push.ts` talks to Apple over HTTP/2 with an
  ES256 JWT — zero dependencies, no Expo push service. Needs `APNS_KEY_PATH`, `APNS_KEY_ID`,
  `APNS_TEAM_ID` set on the server, using an **APNs Auth Key** (Apple Developer ▸ Keys ▸ Apple
  Push Notifications service). That is NOT the App Store Connect upload key — different page,
  not interchangeable.

---

## Release steps

### 1. Bump the version

- **Marketing version** (`0.6.0` → `0.7.0`) when the release is user-facing.
- **Build number** must always increase — App Store Connect rejects duplicates.

Both live in `ios/NeonCore.xcodeproj/project.pbxproj`:

```
MARKETING_VERSION = 0.6.0;
CURRENT_PROJECT_VERSION = 23;      # bump this every upload
```

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
  -allowProvisioningUpdates DEVELOPMENT_TEAM=3AXRJ22S9P archive
```

Archiving into `~/Library/Developer/Xcode/Archives/<date>/` is what makes it appear in
Organizer without hunting for a file.

The archive signs with the **development** identity — that's normal. Xcode re-signs with the
distribution cert during Distribute.

### 4. Upload

**Xcode ▸ Window ▸ Organizer** → select the archive → **Distribute App** →
**TestFlight & App Store** → keep **Automatically manage signing** → **Upload**.

- Sign in first: **Xcode ▸ Settings ▸ Accounts**. An expired session fails the upload.
- If offered a team, choose **Gridlight, Inc. (3AXRJ22S9P)** — not the personal team.
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

## Automation (not set up)

There is deliberately no fastlane lane. An earlier one existed but was written for the Expo
workflow (it called `expo prebuild`) and would fail on the ejected app, so it was removed
rather than left as a trap. If we automate later, it needs an App Store Connect API key
(`.p8`) and a lane that skips prebuild entirely.
