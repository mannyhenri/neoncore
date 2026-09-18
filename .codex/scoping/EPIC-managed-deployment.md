# GRD-4295: Manager-Initiated Managed Deployment — Linux, Docker, Kubernetes, Proxmox, VMs, Windows and macOS

Gridlight Manager is the secured control interface initiating and managing installation on accessible customer network servers/computers, Docker hosts, Kubernetes clusters and hypervisors. AWS ECR hosts container images; the existing license server (license.gridlight.ai, private S3/CloudFront signed download infrastructure) governs access to downloadable installers, scripts, charts and required VM files. Workload execution is on the selected accessible destination, not automatically on AWS. Reuse gl-dev gateway orchestration, secret providers, fleet registry, image mirror, desired-state reconciler and validation engines. Keep AWS credentials and license-server administrator material out of the frontend and customer targets. All operations have reviewable plans, persistent jobs, truthful convergence evidence, safe lifecycle actions and audited entitlement enforcement.

This epic extends GRD-3449 rather than duplicating its native package/signing work. Native Linux/macOS/Windows installers and distribution channels remain owned by GRD-3449; link and satisfy its relevant blocked/open tasks before their dependent acceptance cells can pass. Manager owns the operator interface; gl-dev owns control APIs/execution/runtime verification; license-server owns release catalog and artifact entitlement/delivery. Desktop installation is offered only where the platform/package and interactive-session requirements support it. VM installation-only covers reachable compatible guests; provisioning initially explicitly covers Proxmox, libvirt/KVM, Hyper-V and VMware vSphere. Other providers and Proxmox LXC are visibly unsupported until separately implemented. Air-gapped file availability may reuse GRD-3449 bundles, but fully disconnected activation/deployment is not promised by this network-and-secure-artifact-access epic.

## Acceptance criteria

- All seven target categories are initiated and managed from Gridlight Manager without an operator terminal for supported flows.

- Artifact access is authenticated and entitled: ECR content is digest-pinned through trusted broker/mirror access, downloadable install assets use license-server authorized signed delivery.

- Complete supported platform/architecture/role/action coverage is defined once and drives API, UI and set-based testing; missing required native artifacts are blockers.

- Persistent jobs survive restart, report real progress and functional verification, and support upgrade, drain, rollback where safe, uninstall and owned-resource cleanup.

- Security, real network acceptance evidence and operator runbooks pass before the epic is Done.

## GRD-4296 / MDEP-001: Contract and complete deployment capability registry

### Summary

Define versioned target, platform, architecture, installation-role, agent-role and lifecycle schemas. Separate artifact hosting on AWS from the execution destination on the customer network. Cover Linux, Windows, macOS, Docker, Kubernetes, Proxmox and VMs; VM adapters include existing guests, libvirt/KVM, Hyper-V and VMware vSphere. Derive role coverage from the live deployable-unit registry, including every ROLE_IMAGES member, and native installer contracts from GRD-3449.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

None

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. One shared machine-readable registry drives API validation, UI options and tests; no hard-coded subset of agent roles.

2. Every supported target/role/architecture/action cell has an executor, prerequisites and verification method; unavailable cells show a reason before execution.

3. Specify endpoints for connections, artifact resolution, preflight, deployment jobs, events and lifecycle actions, with ownership and error contracts.

4. Document bootstrap of the first gateway, the Manager control connection and recovery if a gateway deploys or upgrades itself.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Registry-driven contract tests reject unknown targets and verify complete role/action coverage; API compatibility tests cover schema versions.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4297 / MDEP-002: License-server deployment release catalog and entitlement API

### Summary

Extend backend/src/services/downloads and user download handlers with a machine-consumable deployment catalog. Model release/channel/version, OS/architecture, gateway/agent/desktop roles, installer format, ECR repository and immutable digest, file checksum/signature, supported capabilities and prerequisite metadata. Reuse license identity and subscription enforcement rather than the admin download bypass.

### Ownership and effort

Implementation repositories: license-server + gl-dev. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Authorized Manager control services list and resolve entitled artifacts; unauthorized, expired, revoked and cross-tenant requests are denied.

2. Catalog includes container images, Helm charts, bootstrap scripts, native packages and VM templates where required.

3. Unavailable artifacts and blocked GRD-3449 cells are explicit and cannot be marked deployable.

4. Responses are versioned and never expose AWS secret keys, signing private keys or reusable admin credentials.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

API integration tests enumerate artifact kinds, entitlements and tenant isolation; fixture catalog resolves every supported registry cell.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4298 / MDEP-003: Publish immutable ECR images and license-server install assets

### Summary

Extend release CI to publish signed native installers, bootstrap files, Helm charts and supported VM templates through the license-server release flow, and all deployment container images to configured private AWS ECR. Reuse GRD-3449 packaging and signing outputs. Register a coherent versioned catalog only after all required artifacts are available.

### Ownership and effort

Implementation repositories: gl-dev + license-server. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4297

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Release publication validates every supported target/role/architecture cell against the registry.

2. Images resolve to digests; downloadable files carry verified checksums and signature metadata; mutable tags are never the deployed identity.

3. Failed or partial publication cannot promote a release; rollback references remain retained for the supported recovery window.

4. Pipeline uses scoped workload identity and produces provenance, vulnerability results and an auditable publication record.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Staging publication test verifies catalog-to-ECR/file integrity; missing asset, digest mismatch and interrupted promotion fixtures must fail.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4299 / MDEP-004: Scoped artifact-access grants and signed installer download integration

### Summary

Add a deployment-session grant flow for Manager-initiated jobs. Reuse short-lived download tokens and CloudFront signed URLs for native files; bind grants to tenant, job, artifact and allowed operation. The gl-dev control service refreshes grants when justified without handing license-server administrator access to targets.

### Ownership and effort

Implementation repositories: license-server + gl-dev. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4297, GRD-4298

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Only entitled deployment jobs obtain the selected release assets; denied access fails before target changes.

2. Signed URLs and grants expire, are redacted from logs and UI, and support bounded refresh during long installations.

3. Cross-job/tenant reuse, revoked entitlement and altered artifact requests fail closed.

4. Targets receive only minimum temporary material; checksum and signature verification precede execution.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Integration tests cover expiration, refresh, revocation, tenant boundaries, tampering and download failure during an active job.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4300 / MDEP-005: Secure ECR-backed gateway mirror for all deployment transports

### Summary

Extend the existing image-mirror and gateway/src/unit_images.rs contract so targets pull only catalog-authorized, digest-pinned ECR content via the trusted control service/mirror. Keep AWS credentials server-side. Add a renewable registry credential path suitable for Docker and Kubernetes, including manifest lists and image layers; validate existing mirror authentication before reuse.

### Ownership and effort

Implementation repositories: gl-dev + license-server. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4297, GRD-4298, GRD-4299

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. A clean network host with no AWS account pulls authorized deployment images successfully.

2. Tenant/job-scoped pull authorization rejects unrelated repositories and cannot allow arbitrary upstream requests.

3. Kubernetes and Docker pulls support token renewal, multi-architecture selection and immutable digest verification.

4. Mirror outage, entitlement denial and registry failure produce actionable job errors without credentials in outputs.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Real ECR staging pulls from Docker and a Kubernetes cluster; negative tests cover unauthorized layers/manifests, expiry and upstream outage.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4301 / MDEP-006: Deployment connections, credentials and operator permissions

### Summary

Implement connection records and secret references for SSH, Windows remoting, Docker, Kubernetes kubeconfig, Proxmox, libvirt, Hyper-V and vSphere. Use existing gateway secret-provider infrastructure. Manager provides credential entry, connection test, rotation and deletion; backend enforces tenant-scoped deployment and lifecycle permissions.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Secrets are encrypted server-side, never baked into frontend/VITE configuration, and read back only as redacted metadata.

2. SSH host identity and TLS certificates are verified; trust-on-first-use requires explicit operator acknowledgement.

3. Role permissions distinguish read, deploy, upgrade, rollback, delete and credential administration; cross-tenant access is denied.

4. Credential rotation works for future operations; in-flight jobs follow a documented bounded lease/revocation policy.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Secret-store and authorization integration tests for every connection type; verify API/events/export and frontend build contain no credentials.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4302 / MDEP-007: Network target inventory and connection-aware discovery

### Summary

Extend fleet discovery with deployable target inventory for manually entered hosts, opt-in bounded network discovery, clusters and hypervisor inventory. Store detected OS/architecture, reachability, current installation, resources, connection reference and management endpoint. Discovery is constrained to operator-authorized networks.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4301

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager can add reachable Linux/Windows/Mac hosts and enumerate connected cluster/hypervisor targets.

2. No raw address is treated as an authenticated or ready deployment target; identity and connection checks are visible.

3. Existing installs are detected and duplicate targets deduplicated without accidental replacement.

4. Offline, inaccessible and unsupported systems show specific status and remain selectable only for appropriate diagnostic actions.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Discovery fixtures and network lab verify seven target categories, duplicate identity, inaccessible hosts and allowed-range enforcement.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4303 / MDEP-008: Complete deployment preflight and resource compatibility checks

### Summary

Create target-specific preflight plans covering OS/version/architecture, privilege, free disk/RAM/VRAM, GPU/driver/runtime compatibility, ports, container runtime, storage, reboot requirements, artifact access and network routing. Validate chosen model/role placement against actual target resources.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4297, GRD-4301, GRD-4302

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. All supported capability-registry cells run deterministic checks before mutating a target.

2. Blocking and advisory findings include remediation; unsupported GPU/backend combinations cannot appear ready.

3. Check target-to-gateway and target-to-artifact paths, not only Manager-to-target connectivity.

4. Preflight produces a reviewable plan with target, release, roles, privilege changes, downtime and resource allocations.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Set-based preflight tests cover every adapter plus insufficient memory, wrong architecture, occupied port, missing privileges and artifact denial.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4304 / MDEP-009: Persistent deployment jobs and resumable execution engine

### Summary

Evolve deploy_executor.rs and deployment storage into a database-backed job engine with immutable plans, idempotency keys, step results, retry policies, leases and target locks. Include prepare/download/install/configure/enroll/verify stages, cancellation safe points and compensation. Replace process-only rollout history for managed jobs.

### Ownership and effort

Implementation repositories: gl-dev. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4296, GRD-4301, GRD-4303

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Jobs and redacted events survive gateway restart; recovery checks target state before repeating side effects.

2. Repeated submissions cannot duplicate installs or VM creation; conflicting jobs on a target are rejected or queued.

3. Each adapter reports observed step outcomes, timeouts and safe retry/cancellation behavior.

4. No stage succeeds from a timer or a reachable process alone; terminal success requires verification evidence.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Engine integration tests inject restart, duplicate submission, concurrent operation, adapter failure and cancellation at every stage.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4305 / MDEP-010: Desired-state reconciliation and trustworthy convergence reporting

### Summary

Wire node reconciler results into heartbeat/fleet reporting and bind them to deployment job, desired revision, image/package identity and observed configuration. Update FleetDeployTarget in handlers_ops/rollouts.rs, which currently reports health without proof of convergence.

### Ownership and effort

Implementation repositories: gl-dev. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Healthy old workloads cannot satisfy a deployment of a newer requested revision.

2. Heartbeat records observed version/digest, role configuration and convergence result with authenticated node identity.

3. Rollout gates require matching desired/observed state and surface reconciliation errors.

4. Reboot, stale heartbeat and reconnect preserve job/revision correlation without falsely completing a rollout.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Integration tests deploy a changed revision; healthy-but-stale, wrong digest, reconciliation failure and late heartbeat must not pass.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4306 / MDEP-011: Manager-initiated native Linux remote deployment

### Summary

Implement a Linux adapter that uses authenticated SSH to install catalog-selected gateway/agent/desktop packages and configure services on clean accessible hosts. Reuse GRD-3449 distro/package contracts; support declared Debian/Ubuntu and RHEL-family distributions and architectures. Resolve GRD-3496, GRD-3495, GRD-3493 and GRD-3488 dependencies as applicable.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Operator starts installation entirely in Manager with selected target, release and roles.

2. Signed assets are downloaded through the license-server flow, verified and installed using supported package/service managers.

3. Clean install and re-run are idempotent; elevation and reboot needs are explicit.

4. Enrollment and requested-role inference succeed; unsupported distro or missing artifact fails before mutation.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Clean Linux lab installs across declared distro/architecture matrix, including Enterprise Linux; repeat-install and interrupted-install recovery tests.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4307 / MDEP-012: Manager-initiated native Windows remote deployment

### Summary

Implement Windows remote installation with authenticated PowerShell remoting over a secured transport and optional supported SSH/PowerShell path. Reuse GRD-3449 signed MSI/NSIS assets and install.ps1; complete the platform-aware bootstrap path linked to GRD-3494. Manager never offers a Unix shell command for a Windows target.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Install selected gateway/agent/desktop roles from signed license-server assets on a clean Windows host.

2. Validate Authenticode, checksum, privilege and declared OS/architecture compatibility before installation.

3. Windows service configuration, firewall changes, exit codes and reboot-required state are accurately reported.

4. Remote install, restart/reconnect, enrollment and requested-role verification complete without an operator terminal.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Windows VM lab covers successful installation, invalid signature, remoting auth failure, reboot-required handling and repeat deployment.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4308 / MDEP-013: Manager-initiated native macOS remote deployment

### Summary

Implement macOS deployment through authenticated SSH and catalog-selected signed/notarized DMG/PKG assets. Support declared Apple Silicon/Intel roles and launchd behavior. Reuse blocked GRD-3449 work for macOS headless gateway/agent packages and Developer ID Installer signing; do not treat desktop-only availability as complete role support.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager installs supported gateway/agent/desktop roles on clean compatible Macs without manual terminal steps.

2. Validate package signatures/notarization and declared architecture; unavailable signing/package cells remain blocked.

3. Elevation, interactive-session requirements and OS security restrictions are visible during preflight.

4. Services survive reboot and report authenticated convergence plus requested-role verification.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Intel/Apple Silicon Mac lab tests signed install, reboot, invalid asset, unsupported role and credential/permission failures.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4309 / MDEP-014: Actual remote Docker and Compose deployment adapter

### Summary

Replace Docker command-only preview with real execution against an accessible authenticated Docker host, using supported SSH transport or verified TLS API. Generate Compose/service definitions from the full deployment registry and desired plan, pull ECR-backed mirror images by digest, and manage volumes, networks and GPU resources.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4298, GRD-4300, GRD-4301, GRD-4303, GRD-4304, GRD-4305

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager starts real single/multi-role container deployment and shows observed container outcomes.

2. All supported roles receive correct image, ports, model mounts, credentials and resources; unsupported combinations are explicit.

3. Docker endpoint is never accessed through an unauthenticated exposed socket.

4. Upgrade/re-run preserve declared persistent data and verify observed digest/convergence.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Docker network-host lab tests multi-role install, private image pull, occupied ports, GPU capability mismatch and idempotent retry.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4310 / MDEP-015: Actual Kubernetes Helm deployment adapter

### Summary

Extend the existing Kubernetes page and Helm generation into real authenticated cluster operations. Publish/resolve charts through the release catalog; render the requested configuration, execute install/upgrade, wait for observed workload readiness and capture Helm revision. Support namespaces, RBAC, storage, networking and explicitly compatible GPU infrastructure.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4298, GRD-4300, GRD-4301, GRD-4303, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager selects a connected cluster/namespace, previews a validated plan and executes Helm deployment without a terminal.

2. Every supported role uses digest-pinned authorized images with renewable image-pull access.

3. Preflight verifies permissions, storage classes, capacity and GPU prerequisites; creation of privileged cluster components requires a distinct disclosed operation.

4. Release failures, readiness timeouts and partial workloads remain failed with actionable diagnostics; deployed version and inference are verified.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Real Kubernetes lab covers fresh install, upgrade, private pulls, missing RBAC/storage/GPU, readiness failure and Helm rollback.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4311 / MDEP-016: Proxmox VM provisioning and Gridlight deployment adapter

### Summary

Add verified-TLS Proxmox API integration to select a host/storage/network/template, clone or create a VM, configure CPU/memory/disk and guest bootstrap, then run the appropriate native/container deployment. Publish any required authorized templates through the license-server catalog. Distinguish full VMs from LXC; LXC is explicitly unsupported until a separate capability is implemented.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304, GRD-4306, GRD-4307

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager provisions a selected supported guest, waits for accessible authenticated guest management and installs Gridlight.

2. Resource/storage/network allocations and optional GPU passthrough prerequisites are validated before creation.

3. Creation task IDs, VM identity and ownership are persisted; retry cannot create duplicate VMs.

4. Failure compensation removes only job-owned resources under the chosen retention policy; existing VMs are never deleted implicitly.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Proxmox lab verifies provision-and-deploy, existing guest, API denial, storage exhaustion, boot timeout and retry after controller restart.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4312 / MDEP-017: Deploy Gridlight to existing virtual-machine guests

### Summary

Treat an existing reachable VM as a guest deployment destination using the correct Linux, Windows or macOS adapter, independent of hypervisor ownership. Capture guest identity and optional hypervisor reference without requiring provisioning permissions. Expose install-only versus provision-and-install choices in Manager.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: M.

### Dependencies

GRD-4302, GRD-4303, GRD-4304, GRD-4306, GRD-4307, GRD-4308, GRD-4309

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Reachable supported VM guests deploy using native or Docker mode entirely from Manager.

2. Guest permissions suffice for install-only; no unrelated hypervisor credentials are requested.

3. VM guest OS/architecture and resource checks use observed guest capabilities.

4. Lifecycle actions on the installation do not power off or delete the VM unless separately authorized as a provisioned resource.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Existing-guest lab verifies Linux/Windows and supported macOS guest paths, wrong OS detection and installation-only deletion boundaries.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4313 / MDEP-018: libvirt/KVM VM provisioning adapter

### Summary

Implement authenticated libvirt/KVM host connection, supported template selection, VM creation and guest bootstrap, followed by Linux/Windows deployment where supported. Reuse the common VM job/resource ownership model and authorized catalog templates; expose supported network/storage configuration and optional GPU passthrough requirements.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304, GRD-4306, GRD-4312

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager creates a VM with selected supported resources and installs a selected Gridlight release.

2. Verified management transport, template integrity and unique ownership/idempotency are enforced.

3. Guest readiness is observed; unsupported guest/template/GPU combinations fail preflight.

4. Provisioning failure and deletion apply the shared compensation/retention policy only to job-owned resources.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

KVM/libvirt lab covers create-and-deploy, restart/retry, guest boot failure, inaccessible storage and preservation of pre-existing VMs.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4314 / MDEP-019: Hyper-V VM provisioning adapter

### Summary

Add authenticated Windows/Hyper-V management to create supported Linux/Windows guests from authorized templates, configure virtual switch/storage/resources and bootstrap guest access before installing Gridlight. Reuse common resource ownership and deployment stages.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304, GRD-4306, GRD-4307, GRD-4312

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager provisions and deploys to supported Hyper-V guests without manual host commands.

2. Preflight checks Hyper-V privileges, VM generation/template compatibility, switch/storage availability and supported acceleration.

3. Job identity and guest address are persisted; reconnect/retry does not duplicate resources.

4. Unsupported GPU assignment or guest combinations are clearly disabled; failures preserve unrelated VMs.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Hyper-V lab covers Linux/Windows deployment, template mismatch, denied host privilege, boot timeout and idempotent recovery.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4315 / MDEP-020: VMware vSphere VM provisioning adapter

### Summary

Add verified-TLS vSphere connection and resource discovery for supported datacenter/cluster/datastore/network/template choices. Clone or create supported Linux/Windows VMs, observe task/guest readiness and deploy Gridlight using the common guest adapters. Catalog-host downloadable templates on the license server when needed.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4298, GRD-4299, GRD-4301, GRD-4303, GRD-4304, GRD-4306, GRD-4307, GRD-4312

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager provisions a selected supported VM and completes Gridlight installation and verification.

2. Preflight validates API permissions, template integrity, capacity, network and supported GPU allocation.

3. Persist vSphere task/VM identity and ownership; retry/restart cannot create duplicate VMs.

4. API/guest failures are actionable and compensation cannot modify unrelated resources.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

vSphere lab covers provision/deploy, API role denial, capacity shortage, guest bootstrap timeout and recovery after gateway restart.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4316 / MDEP-021: Deployment networking, storage and bootstrap routing

### Summary

Implement common network/storage plan validation and adapter bindings: gateway advertised URL, target registration routes, TLS, service ports, DNS, firewall changes, persistent model/data volumes and VM/cluster network mapping. Address the bootstrap case where Manager is available but no destination gateway exists yet.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4303, GRD-4304

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Plans prove target-to-control, artifact and inference routing before reporting ready.

2. Firewall and elevated network changes are listed and limited to selected deployment needs.

3. Persistent data ownership, encryption expectations, capacity and retention are explicit for every target.

4. Gateway bootstrap and self-upgrade keep or recover the Manager control connection; loopback-only advertised addresses are rejected.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Cross-subnet and NAT lab tests, loopback rejection, TLS failure, port conflict, storage exhaustion and first-gateway bootstrap recovery.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4317 / MDEP-022: Real model distribution and complete agent-role placement

### Summary

Replace Deployment ModelsTab download-marker prototype with verified model distribution and actual placement across selected targets. Use the model catalog and deployable-unit registry for all roles; locate/licence model sources explicitly and host Gridlight-distributed downloadable bundles through the license server when appropriate. Validate checksums, storage and backend compatibility.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4296, GRD-4303, GRD-4304, GRD-4316

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Downloaded means verified model bytes exist at the selected target, not a toggled database flag.

2. Deployment plans bind roles to compatible models, devices and resource budgets across every registered modality.

3. Interrupted transfer resumes safely; missing, corrupted, gated or unauthorized models prevent readiness.

4. Shared caches and deletion obey ownership/retention rules and do not remove models used by other deployments.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Target transfer tests include actual model files, checksum failure, interruption, insufficient disk and complete registry-based modality coverage.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4318 / MDEP-023: End-to-end deployment verification and evidence gates

### Summary

Create shared verification stages for artifact identity, service readiness, authenticated enrollment, desired-state convergence and a real request through the requested gateway/agent role. Reuse validation_runs and rollout gates where appropriate; evidence is correlated with job and release.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4304, GRD-4305, GRD-4316, GRD-4317

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Terminal success requires requested package/image/model identity and matching observed configuration.

2. Each supported role has a registry-defined real functional check; health alone cannot pass.

3. Verification failure blocks subsequent rollout waves and provides retained redacted evidence.

4. Manager distinguishes installed, enrolled, converged and functionally verified states.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Set-based verification tests for all supported roles plus healthy-old-version, wrong model, failed inference and stale heartbeat; network lab stores real outputs.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4319 / MDEP-024: Managed upgrade, restart, drain and uninstall across targets

### Summary

Implement lifecycle actions for all supported target adapters using versioned plans and deployment ownership. Include upgrade, restart/start/stop where meaningful, traffic drain and uninstall, preserving data by default. Separate Gridlight removal from deletion of provisioned VM/cluster resources.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4304, GRD-4305, GRD-4306, GRD-4307, GRD-4308, GRD-4309, GRD-4310, GRD-4311, GRD-4312, GRD-4313, GRD-4314, GRD-4315, GRD-4318

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Manager performs each declared lifecycle action with target locks, operator permissions and observed result.

2. Upgrades preserve required persistent data and apply compatible configuration/schema migration checks.

3. Drain respects active workload safety and bounded timeout policy before restart/removal.

4. Destructive resource/data deletion is separately disclosed and only affects explicitly selected owned resources.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Registry-driven adapter lifecycle tests; real lab upgrades and uninstall with model/data preservation and resource deletion isolation.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4320 / MDEP-025: Rollback, staged rollout and deployment failure recovery

### Summary

Extend wave planning with canary/staged updates, verified gates, previous-known-good identity and target-specific rollback/compensation. Use retained ECR digests/files; establish database/configuration migration compatibility and explicit non-reversible steps rather than promising universal rollback.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4304, GRD-4305, GRD-4318, GRD-4319

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Operator previews waves and starts or cancels them from Manager; later waves halt on verification failure.

2. Supported rollbacks restore prior version/configuration and re-run functional verification.

3. Non-reversible migrations or actions are clearly flagged before execution with recovery requirements.

4. Gateway restart and artifact/token failure recover safely without fictitious success or uncontrolled duplicate actions.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Fault-injection lab tests failed canary, later-wave refusal, rollback asset retention, incompatible migration and restart during rollback.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4321 / MDEP-026: Unified secured deployment workspace in Gridlight Manager

### Summary

Rework Deployment.tsx, SetupWizard.tsx, Kubernetes.tsx and api.ts into one coherent deployment experience for seven target categories. Flow: connection/target selection, entitled release, installation and agent roles/models, preflight/plan review, execution, live results and lifecycle. Reuse existing generators as previews and remove misleading prototype completion states.

### Ownership and effort

Implementation repositories: gridlight-manager + gl-dev. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4296, GRD-4297, GRD-4301, GRD-4302, GRD-4303, GRD-4304, GRD-4318

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. All seven categories are discoverable in Manager with appropriate native, container, cluster and VM options.

2. Operator can launch jobs and inspect actual stage progress, errors, retry, cancellation, verification and history without a terminal.

3. Unavailable assets/capabilities show precise blockers; connection secrets and signed access URLs never appear in ordinary UI/log exports.

4. Existing rollout/Helm screens preserve functionality through migration; accessibility and recoverable API errors are covered.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Browser journeys cover every category, denied access, blocked preflight, failed job/retry, reload/reconnect and verified completion using real API state.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4322 / MDEP-027: Deployment audit trail, operational logs and notifications

### Summary

Add correlated durable audit and operational events across catalog grants, target connections, jobs, resource changes and lifecycle actions. Manager exposes filtered job history, redacted logs, diagnostic export and completion/failure notifications. Define retention and access policies.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4299, GRD-4301, GRD-4304, GRD-4321

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Every mutation records tenant/operator, target, job, release identity, action and observed outcome.

2. Logs survive restart and can correlate license-server asset access with deployment steps.

3. Secrets, tokens, signed URLs and sensitive command parameters are redacted before persistence/export.

4. History and notifications cannot leak another tenant or mislabel an incomplete deployment as successful.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Audit completeness tests enumerate all mutating actions; redaction fixtures and tenant-isolation/export/browser notification tests.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4323 / MDEP-028: Deployment security and supply-chain abuse tests

### Summary

Review and test the deployment attack surface: operator/tenant authorization, remote command injection, SSRF, host identity, TLS, privilege boundaries, artifact signatures, catalog tampering, token expiry, registry repository isolation and credential leakage. Use existing security review conventions and document remediation with no unreviewed privileged paths.

### Ownership and effort

Implementation repositories: gl-dev + license-server + gridlight-manager. Suggested owner: Backend/Full-stack. Complexity: L.

### Dependencies

GRD-4298, GRD-4299, GRD-4300, GRD-4301, GRD-4304, GRD-4321, GRD-4322

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Untrusted target/role/model inputs cannot execute arbitrary commands or reach non-authorized control/artifact endpoints.

2. Every adapter enforces connection identity, scoped privileges and owned-resource boundaries.

3. Forged/revoked grants, altered downloads/images and cross-tenant operations are denied with safe diagnostics.

4. No unresolved high-severity deployment security finding remains at epic completion.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Automated abuse suites for all transports and grant paths plus manual threat review; retain actual findings/remediation and rerun results.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4324 / MDEP-029: Seven-target deployment acceptance lab and release gate

### Summary

Build a registry-driven acceptance matrix and realistic network lab for Linux, Windows, macOS, Docker, Kubernetes, Proxmox and VMs, including libvirt/KVM, Hyper-V and vSphere provisioning. AWS hosts artifacts, not a mandatory workload destination. Drive all tests from Manager against accessible lab targets with production-like ECR and signed license-server downloads.

### Ownership and effort

Implementation repositories: gl-dev + gridlight-manager + license-server. Suggested owner: Backend/Full-stack. Complexity: XL.

### Dependencies

GRD-4306, GRD-4307, GRD-4308, GRD-4309, GRD-4310, GRD-4311, GRD-4312, GRD-4313, GRD-4314, GRD-4315, GRD-4318, GRD-4319, GRD-4320, GRD-4321, GRD-4322, GRD-4323

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Fresh deployment, verification, repeat run, upgrade, rollback where supported and uninstall pass for every declared target/platform/role cell.

2. Customer lab targets have no AWS long-lived credentials; authorized ECR and installer retrieval succeed.

3. Injected network outage, credential/token expiry, corrupt artifact, insufficient resources and gateway restart produce correct failed/recovered outcomes.

4. CI/release report states matrix counts and actual evidence; unavailable required cells block epic completion rather than disappear from coverage.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Run the full machine-readable acceptance matrix with real target and functional request outputs; gate release on exact supported-set counts and zero unexplained omissions.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.

## GRD-4325 / MDEP-030: Deployment operator documentation and support runbooks

### Summary

Document target connection setup, required network routes, artifact/license authentication, supported OS/architecture/roles, VM providers, GPU/storage prerequisites and Manager-only deployment workflows. Provide failure diagnosis, secret rotation, recovery, rollback limitations and data retention/deletion runbooks.

### Ownership and effort

Implementation repositories: gridlight-manager + gl-dev + license-server. Suggested owner: Backend/Full-stack. Complexity: M.

### Dependencies

GRD-4321, GRD-4322, GRD-4324

Related foundation: GRD-3449; do not duplicate packaging/signing tasks.

### Acceptance criteria

1. Docs cover all seven categories and initial VM providers with examples aligned to actual UI and catalog.

2. Explain that AWS ECR/license-server downloads host artifacts while deployments run on accessible selected machines/clusters.

3. Include first-gateway bootstrap, self-upgrade recovery, expired entitlement and disconnected-target procedures.

4. A new operator completes a clean deploy and recovery exercise using the documentation and Manager, with no undocumented terminal requirement.

### Implementation guide

Existing anchors: gridlight-manager/src/pages/Deployment.tsx, src/components/SetupWizard.tsx, src/pages/Kubernetes.tsx, src/api.ts; gl-dev/gateway/src/deploy.rs, deploy_executor.rs, deployment.rs, unit_images.rs, handlers_ops/setup.rs and handlers_ops/rollouts.rs; gl-dev/helm/gridlight-palette; license-server/backend/src/services/downloads, backend/src/api/handlers/admin_releases.rs and terraform/edge/s3_downloads.tf. Inspect current per-repository AGENTS.md and implementation before editing; these anchors indicate existing integration points, not mandatory placements for every new module.

Persist new deployment/connection/job state through reviewed migrations where needed. Use the versioned shared contract and existing authentication/secret abstractions; do not introduce frontend AWS secrets or admin-download bypasses. Surface actionable errors and bind observations to target/job/release.

### Tests and verification

Documentation link/schema checks and observed operator walkthrough for each target category, including a failed-job recovery exercise.

Before implementation enumerate the complete supported set from the shared registry, write the failing set-based test, implement the whole set, run appropriate checks and retain actual output. Hardware/network tests require real lab evidence; mocks alone cannot certify deployment.

### Completion standard

Finish implementation with NEONCORE-DONE including scope counts, exact verification command/results and any explicitly justified deferred work. A prototype command preview, toggled download marker or healthy stale workload does not meet acceptance.
