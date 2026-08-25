# Security policy

Privately report suspected vulnerabilities to `security@ingestron.io`. Do not
include customer data, credentials, access tokens, SAS URLs, tenant identifiers,
or production logs. There is no response-time or remediation SLA for this
technical preview.

The CLI does not accept Azure passwords, access tokens, SAS values, or connection
strings as ordinary arguments or configuration. It delegates Azure identity to
Azure CLI, verifies the exact tenant/subscription/factory target, redacts
credential-shaped output, and limits deletion to resource IDs in exact ownership
locks.

Release archives, Azure bundles, Bicep, deployment helpers, Function ZIPs, and
worker images are SHA-256 pinned. Customer-managed planning rejects an
unverified bundle, artefact mismatch, unexpected ARM deletion/replacement,
ownership collision, wrong identity, or unsafe cost input.

These controls do not replace customer review of Azure Policy, identity,
networking, logging, retention, recovery, dependency vulnerabilities, or
production suitability.
