# Shipping NeonCore to TestFlight yourself (no Expo cloud)

`fastlane beta` builds a signed iOS app **on this Mac** and uploads it to TestFlight in one
command. No EAS / Expo build servers are involved — just Xcode, CocoaPods, and your Apple
account. This is a one-time setup; after that it's a single command per release.

## What fastlane is

A Ruby automation tool for the tedious iOS release steps — archiving, code signing, bumping the
build number, and uploading to TestFlight. The whole pipeline lives in `fastlane/Fastfile` as a
"lane" you run by name.

## One-time setup

### 1. Install fastlane
```bash
brew install fastlane
```

### 2. Create an App Store Connect API key (avoids Apple-ID passwords / 2FA)
App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **(+)**.
- Role: **App Manager**.
- Copy the **Issuer ID** (shown once at the top) and the new key's **Key ID**.
- Download the **`AuthKey_XXXXXXXXXX.p8`** — it downloads **once**. Save it into this `fastlane/`
  folder (it's gitignored).

### 3. Find your Team ID
developer.apple.com/account → **Membership details** → **Team ID** (10 characters).

### 4. Fill in credentials
```bash
cd mobile
cp fastlane/.env.example fastlane/.env
# edit fastlane/.env with ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, APPLE_TEAM_ID
```

## Release

```bash
cd mobile
fastlane beta
```

That regenerates `ios/` from `app.json`, bumps the build number past what's on TestFlight,
builds a signed App Store `.ipa`, and uploads it. It appears in TestFlight once Apple finishes
processing (a few minutes). Distribute to testers from App Store Connect → TestFlight as usual.

## Notes

- **Version vs. build number.** `app.json` `version` (0.6.0) is the marketing version; the build
  number auto-increments each upload. Bump `version` in `app.json` for the next release.
- **Signing.** The lane uses automatic signing with `-allowProvisioningUpdates`, so Xcode
  creates/downloads the distribution provisioning profile via the API key — you don't manage
  profiles by hand. It does need a distribution certificate in your account (Xcode ▸ Settings ▸
  Accounts ▸ Manage Certificates ▸ + ▸ Apple Distribution, once).
- **OTA after this.** The build bakes in runtimeVersion 0.6.0 + the EAS Update URL already in
  `app.json`. After 0.6.0 is on TestFlight, JS-only changes ship over-the-air with
  `eas update --channel production` — no rebuild — until you bump `version` again.
- **Push notifications.** `expo-notifications` needs an APNs key registered for your push
  service; that's independent of this build.
