#!/usr/bin/env bash
# Build the NeonCore iPhone app and install it on your iPhone — locally, signed with your personal
# Apple team. No App Store account, no upload. Run it on the Mac, from anywhere, with the
# iPhone connected (USB, or paired over Wi-Fi):
#
#   bash mobile/scripts/build-ios.sh                    # build Release, install on the connected iPhone
#   NEONCORE_DEVICE="iPhone Manu" bash mobile/scripts/build-ios.sh   # pick the phone by name
#   NEONCORE_TEAM_ID=XXXXXXXXXX bash mobile/scripts/build-ios.sh     # sign with another team
#
# The personal team (free) has two limits, both Apple's:
#   · no Push Notifications — the build leaves out the push entitlement (it stays in the project
#     for a paid team); the app works, alerts show when you open it;
#   · the install expires after 7 days — run this again to renew it.
# After the install, app changes still reach the phone over the air: `npm run ota:publish`.
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE"
PBX=ios/NeonCore.xcodeproj/project.pbxproj
VERSION=$(grep -m1 -oE 'MARKETING_VERSION = [0-9.]+;' "$PBX" | grep -oE '[0-9.]+[0-9]')
BUILD=$(grep -m1 -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBX" | grep -oE '[0-9]+')

# 1. The team that signs it: the personal team ("Emmanuel Henri").
TEAM="${NEONCORE_TEAM_ID:-W7QXFS7XBU}"
echo "▸ NeonCore ${VERSION} (${BUILD}) · team ${TEAM}"

# 2. The iPhone: the one named in NEONCORE_DEVICE, else the first connected one.
DEVICES="$(mktemp)"
xcrun devicectl list devices --json-output "$DEVICES" >/dev/null 2>&1 || true
read -r DEVICE_ID DEVICE_NAME < <(python3 - "$DEVICES" "${NEONCORE_DEVICE:-}" <<'PY'
import json, sys
want = sys.argv[2]
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []
for d in devices:
    props, hw = d.get("deviceProperties", {}), d.get("hardwareProperties", {})
    name = props.get("name", "")
    if hw.get("platform") != "iOS" or (want and name != want):
        continue
    if d.get("connectionProperties", {}).get("pairingState") != "paired":
        continue
    print(d["identifier"], name)
    break
PY
) || true
if [[ -z "${DEVICE_ID:-}" ]]; then
  echo "✗ No paired iPhone${NEONCORE_DEVICE:+ named \"$NEONCORE_DEVICE\"} found. Connect it (USB, or Wi-Fi after pairing in Xcode ▸ Devices) and unlock it." >&2
  exit 1
fi
echo "▸ iPhone: ${DEVICE_NAME}"

# 3. JavaScript dependencies and pods, only when they are missing or out of date.
[[ -d node_modules || -d ../node_modules/react-native ]] || npm install
if ! diff -q ios/Podfile.lock ios/Pods/Manifest.lock >/dev/null 2>&1; then
  echo "▸ pod install"; (cd ios && pod install)
fi

# 4. Build Release for the device — without the push entitlement, which a personal team cannot sign.
DERIVED="$MOBILE/ios/build/local"
echo "▸ Building (a few minutes) …"
xcodebuild -workspace ios/NeonCore.xcworkspace -scheme NeonCore -configuration Release \
  -destination "platform=iOS,name=${DEVICE_NAME}" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_ENTITLEMENTS=NeonCore/NeonCore.local.entitlements build -quiet
APP="$DERIVED/Build/Products/Release-iphoneos/NeonCore.app"
[[ -d "$APP" ]] || { echo "✗ The build did not produce $APP" >&2; exit 1; }

# 5. Install it on the iPhone.
echo "▸ Installing on ${DEVICE_NAME} …"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >/dev/null
echo "✓ Installed NeonCore ${VERSION} (${BUILD}) on ${DEVICE_NAME}."
echo "  First install: on the iPhone, Settings ▸ General ▸ VPN & Device Management ▸ trust the developer."
echo "  It expires in 7 days — run this again to renew. App changes in between: npm run ota:publish."
