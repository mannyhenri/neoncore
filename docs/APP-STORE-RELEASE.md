# Shipping NeonCore for iOS to the App Store

TestFlight is already working — see [mobile/RELEASE.md](../mobile/RELEASE.md) for the build and
upload mechanics, which do not change. This document covers the gap between "my testers have it"
and "it is public on the App Store", which is mostly review risk rather than engineering.

---

## Read this first: the rejection risk that actually applies

NeonCore is a **LAN-only client for a server you run yourself**. Three review guidelines bite here,
and the first is the one that sinks builds:

### 1. Guideline 2.1 — "we couldn't evaluate your app"

An app that shows an empty connection screen without a server is, to a reviewer, a broken app.
They will not stand up a NeonCore server. This is the single most likely rejection, and it is
avoidable. Do **all** of these:

- **Provide a working demo server the reviewer can reach**, reachable from the public internet, and
  put the URL plus fleet token in **App Review Information ▸ Notes**. Seed it with cartridges,
  goals and tasks so every screen has content. Keep it up through the whole review.
- **Record a demo video** (App Review Information accepts a URL) showing connect → cartridge grid →
  approval → prompt. Reviewers lean on this heavily for hard-to-configure apps.
- **Write the notes as instructions**, not description: "1. Open the app. 2. Tap Connect. 3. Enter
  `https://demo.example.com`. 4. Tap Cartridges." Assume no context whatsoever.

Without a reachable server, expect 2.1. With one, this is routine.

### 2. Guideline 4.2 — minimum functionality

A "companion that just mirrors a desktop" invites this. Your defence is real, so state it: push
notifications for approvals, remote unblocking, transcript reading, launching workflows. Frame the
app in the description as *acting on* your fleet, not viewing it.

### 3. Guideline 2.5.2 / 3.3.1 — executing code

The app sends prompts that cause an agent to run commands **on the user's own machine**. That is
not the app downloading or executing code, and it is fine — but say so plainly in the review notes
before a reviewer forms their own theory. Ambiguity here costs a review cycle.

---

## Pre-submission checklist

### Identity and metadata

- [ ] **App name** — "NeonCore" may be taken; check App Store Connect early. A subtitle
      ("AI agent orchestrator") carries the meaning if you need a longer name.
- [ ] **Bundle ID** `ai.gridlight.neoncore` — already registered
- [ ] **Marketing version** — currently `0.7.0`. Ship 1.0; a sub-1.0 version signals beta to users
      and to review.
- [ ] **Age rating** — 4+ likely, but the questionnaire asks about unrestricted web access. The app
      renders agent output, so answer honestly.
- [ ] **Category** — Developer Tools (primary); Productivity (secondary)

### Assets

- [ ] **Screenshots** — required for 6.9" and 6.5" iPhone; iPad required because the app is
      universal (`TARGETED_DEVICE_FAMILY = "1,2"`). Missing iPad screenshots blocks submission.
- [ ] **App icon** — 1024×1024, **no alpha channel** (Apple rejects alpha). Full set is already
      committed.
- [ ] **Preview video** (optional, high value) — 15–30s of an approval answered from the phone.
      That is the moment the product explains itself.

### Legal and privacy

- [ ] **Privacy Policy URL** — mandatory, even collecting nothing. Say exactly that: NeonCore
      stores your server URL and token on-device, talks only to servers you configure, and sends no
      analytics.
- [ ] **Privacy Nutrition Label** — you can most likely declare **Data Not Collected**. Verify
      first: confirm no third-party SDK collects anything, and that APNs device tokens go only to
      *your* server. If any crash reporter is linked, it must be declared.
- [ ] **Export compliance** — `ITSAppUsesNonExemptEncryption = false` is already in `Info.plist`,
      so no prompt. Confirm this stays true if you ever add encryption beyond HTTPS.
- [ ] **Support URL** — a real page that answers "how do I set up the server".
- [ ] **Open-source licensing** — with the app Apache-2.0, include a licenses screen or a link.
      Not required by Apple, expected by developers.

### Technical

- [x] **Local network permission** — ✅ *verified present* in `Info.plist`:
      "NeonCore connects to your orchestrator server on the local network." Without it, discovery
      fails silently on a reviewer's device and reads as a broken app.
- [x] **App Transport Security** — ✅ *verified, and configured the right way*:
      `NSAllowsArbitraryLoads = false` with `NSAllowsLocalNetworking = true`. That permits cleartext
      to `.local` hostnames and private IPs **without** a blanket exception, which is exactly the
      narrow form reviewers want. A blanket `NSAllowsArbitraryLoads = true` would have needed
      written justification; this does not. One less rejection risk than expected.
- [ ] **Bonjour** — `NSBonjourServices` is absent. Fine today, because peers are reached over HTTP
      rather than browsed via mDNS. If you ever add real Bonjour *discovery*, iOS 14+ requires the
      service types be declared here or browsing returns nothing, silently.
- [ ] **No-server state** — first launch with nothing configured must explain itself, not show an
      empty grid. This is what a reviewer sees first.
- [ ] **Offline / unreachable server** — must show an error, never an endless spinner.
      *(Fixed in build 36: requests now time out at 12s.)*
- [ ] **iPad layout** — universal build; a stretched-phone layout draws 4.2 complaints.
- [ ] **Crash-free on the review device** — they test on current iOS, often an iPad.

---

## Two decisions worth making before you submit

**Open source + App Store together.** Both are fine and common. Anyone can build the app from
source; the App Store build is the convenient one. Two consequences: someone may publish a clone
(Apache-2.0 permits it — your defence is the name and the trademark, not the licence), and
`DEVELOPMENT_TEAM`/bundle ID in a public repo means contributors must swap in their own.

**Free vs paid.** Free is the obvious fit — the app is worthless without a server you already run,
which makes it a companion rather than a product. If it's free with no purchases, you skip the
paid-apps agreement and banking setup entirely.

---

## Submission flow

1. Bump `MARKETING_VERSION` to `1.0.0`, bump `CURRENT_PROJECT_VERSION`, **and update
   `EXPECTED_BUILD`** in `mobile/src/__tests__/standard-banner.test.ts` in the same commit
2. Archive and upload per [mobile/RELEASE.md](../mobile/RELEASE.md)
3. In App Store Connect: fill metadata, upload screenshots (**iPhone and iPad**), attach the
   privacy policy, complete the nutrition label
4. **App Review Information**: demo server URL, fleet token, step-by-step instructions, demo video,
   and the note about agents running commands on the user's own machine
5. Submit. First review is typically 24–48h; plan for one rejection cycle on 2.1 or ATS
6. Consider **phased release** so a bad build reaches 1% before 100%

---

## After approval

- Every JS change needs a **full build and a new review** — `expo-updates` is gone, so there is no
  OTA path. Batch fixes accordingly.
- APNs environment must match: production for App Store builds, sandbox for Xcode debug. Mismatching
  them is the classic "push works in Xcode, silent in the store build".
- Watch the first crash reports on hardware you don't own — the fleet code paths differ most on
  networks you have never seen.
