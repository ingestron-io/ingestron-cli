# Customer-managed Azure lifecycle

The technical preview wraps the authoritative Apache-2.0 Profile J Bicep
bundle. It does not recreate Azure resources imperatively and does not use an
Ingestron hosted control plane.

## Operator flow

1. Sign in with the organisation's approved Azure CLI identity and select the
   exact subscription.
2. Run `azure init` once. It discovers the active tenant/subscription,
   downloads and verifies the bundle-pinned Function package, selects the
   digest-pinned public worker image, and writes only safe intent. Both artefact
   references may be overridden for an approved internal mirror.
3. Run `azure plan`. Review the exact subscription, group, Bicep change set,
   planned cost and deferred runtime stage.
4. Run the organisation's live budget/policy preflight, then `azure install
--yes`. The command repeats what-if, applies foundation Bicep, imports and
   verifies the worker digest, applies runtime Bicep, invokes the bundled
   Azure-owned One Deploy helper and writes an exact lock only after verification.
5. Run `azure verify`, then `azure adf-config`. The latter writes the existing
   customer-managed ADF config from the verified endpoint/audience outputs.

An absolute `--recipe` is made portable only when the recipe is inside the ADF
config directory; otherwise the handoff fails before writing an unusable config.
Upgrade planning continues to reject `Modify` by default. It classifies only the
known ACR server-default omissions and deterministic AcrPull principal-reference
comparison emitted by Azure what-if as provider noise.
Lock history is serialised without YAML anchors so every generated lock remains
compatible with the CLI's alias-free safe YAML reader after upgrade and rollback.

```text
ingestron azure init ...
ingestron azure plan --config ingestron.azure.yaml
ingestron azure install --config ingestron.azure.yaml --yes
ingestron azure status --config ingestron.azure.yaml
ingestron azure verify --config ingestron.azure.yaml
ingestron azure adf-config --config ingestron.azure.yaml \
  --adf-config ingestron.adf.yaml \
  --factory-resource-id /subscriptions/.../factories/... \
  --recipe recipe.yaml
```

`1.1.1` intentionally pins the same templates and application artefacts as
`1.1.0`. It proves an explicit compatible no-change upgrade and
rollback without suggesting a runtime feature change:

```text
ingestron azure upgrade --config ingestron.azure.yaml --to 1.1.1 --yes
ingestron azure rollback --config ingestron.azure.yaml --yes
```

`1.2.0` keeps the same runtime behaviour while moving the public release and
digest-pinned worker distribution to the product-owned `ingestron-io` GitHub
namespace. New installations use `1.2.0`; earlier bundles remain available only
for explicit compatibility and rollback records.

Uninstall first reconciles every resource ID against the exact lock. It refuses
missing or unexpected resources, adopted Entra objects, a target mismatch or a
changed ownership boundary. The current candidate uses an existing
customer-controlled Entra application and never deletes it.

```text
ingestron azure plan-uninstall --config ingestron.azure.yaml
ingestron azure uninstall --config ingestron.azure.yaml --yes
```

## Configuration split

- `ingestron.azure.yaml` contains the runtime installation intent.
- `ingestron.azure.lock.yaml` records runtime release, integration outputs and
  exact Azure ownership.
- `ingestron.adf.yaml` and `ingestron.lock.yaml` remain the independently managed
  ADF integration intent and lock.

No file stores a password, client secret, storage key, connection string, SAS or
token. Tenant, subscription, resource and application identifiers are not
credentials but should stay in the customer's protected infrastructure
repository.

## Current limitations

This is an unsupported public technical preview, not customer or production
evidence. The operator supplies an existing Entra API application and exact
allowed caller IDs. Runtime object code remains under the separate Ingestron
Runtime Preview Licence even though it is anonymously downloadable. The CLI
does not collect telemetry, upload configuration or require standing Ingestron
credentials. `cost.plannedUsd` enforces the bundle ceiling; the customer's live
budget/policy gate remains customer-owned rather than guessed by the CLI.
