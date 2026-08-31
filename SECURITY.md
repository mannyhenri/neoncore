# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through
[GitHub Security Advisories](https://github.com/GRIDLIGHT-INC/neoncore/security/advisories/new),
or email **security@gridlight.ai**.

Please include what an attacker can do, the steps to reproduce it, and the affected version. We
aim to acknowledge within 3 working days and to agree a disclosure timeline with you.

## What NeonCore assumes about its environment

Understanding the threat model will tell you whether what you have found is a bug or the
documented design.

NeonCore is built for a **trusted local network**. It deliberately has:

- **no user accounts and no per-user authorization** — anyone who can reach the port can drive the
  agents
- **a single shared fleet token**, not per-client credentials
- **`permissive` auth by default**, which allows un-tokened callers and logs them

So these are *not* vulnerabilities in themselves:

- reaching the API without a token while auth is `permissive`
- one dashboard user seeing another's cartridges — there is no multi-tenancy
- an agent in **trust mode** running shell commands without asking; that is the feature

**Exposing NeonCore to the public internet is out of scope.** Do not port-forward it. Use a VPN or
a tunnel such as Tailscale.

## What we do want to hear about

- Bypassing the permission gate — running a gated tool call without approval while in Manual mode
- Reading or exfiltrating the fleet token through the API, logs, or the dashboard
- Extracting APNs credentials, or any path that reads a key file into the database or a response
- Remote code execution reachable from a request, including via workflow or task payloads
- Path traversal through repo paths, attachments, or the directory browser
- SQL injection, or a way to make one peer write to another's database
- A cross-machine attack: one fleet member compromising another beyond the documented gossip
- Secrets appearing in transcripts, activity records, or exported data

## Supported versions

NeonCore is pre-1.0. Fixes land on `main`; there are no backports to older tags yet.

## Handling secrets in this project

- The **fleet token** lives in the database and is redacted from the settings API after its
  one-time display. If you add a settings field, check whether it belongs in `SECRET_SETTING_KEYS`.
- **APNs keys** are referenced by path through `APNS_KEY_PATH` and read at send time. Never read a
  key into the database, a response body, or a log line.
- `.gitignore` covers `mobile/fastlane/.env` and `*.p8`. Before committing, confirm no credential
  is present — a secret in git history outlives its deletion.
