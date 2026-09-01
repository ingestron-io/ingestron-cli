# Customer-managed Azure lifecycle

The technical preview wraps the authoritative Apache-2.0 Profile J Bicep
bundle. It does not recreate Azure resources imperatively and does not use an
Ingestron hosted control plane.

## Operator flow

1. Sign in with the organisation's approved Azure CLI identity and select the
   exact subscription.
2. Run `azure init` once with the explicit approved subscription ID. It resolves
   that exact target instead of inheriting the ambient Azure CLI subscription,
   downloads and verifies the bundle-pinned Function package, selects the
   digest-pinned public worker image, and writes only safe intent. Both artefact
   references may be overridden for an approved internal mirror.
3. Run `azure plan`. Review the exact subscription, group, Bicep change set,
   planned cost and deferred runtime stage.
4. Run the organisation's live budget/policy preflight, then `azure create
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
ingestron azure init --subscription <approved-subscription-id> ...
ingestron azure plan --config ingestron.azure.yaml
ingestron azure create --config ingestron.azure.yaml --yes
ingestron azure status --config ingestron.azure.yaml
ingestron azure verify --config ingestron.azure.yaml
ingestron azure plan-pause --config ingestron.azure.yaml --scope cost-bearing
ingestron azure pause --config ingestron.azure.yaml --scope cost-bearing --yes
ingestron azure plan-resume --config ingestron.azure.yaml --scope cost-bearing
ingestron azure resume --config ingestron.azure.yaml --scope cost-bearing --yes
ingestron azure adf-config --config ingestron.azure.yaml \
  --adf-config ingestron.adf.yaml \
  --factory-resource-id /subscriptions/.../factories/... \
  --recipe recipe.yaml
```

An existing Bicep-owned Profile J group without a retained CLI lock uses a
separate fail-closed migration. `adopt-init` reads only non-secret ARM
deployment parameters and writes a bundle-pinned candidate config.
`plan-adopt` then requires the exact seven-resource public-ingress inventory,
matching ownership tags, matching identity/profile parameters and a Bicep
what-if containing no create, delete or replacement. `adopt --yes` reapplies the
authoritative bundle and application artefacts and writes a lock only after full
verification:

```text
ingestron azure adopt-init \
  --subscription <approved-subscription-id> \
  --resource-group <existing-profile-j-group> \
  --name <installation-name> \
  --planned-usd <amount> \
  --config ingestron.azure.yaml
ingestron azure plan-adopt --config ingestron.azure.yaml
ingestron azure adopt --config ingestron.azure.yaml --yes
```

Adoption is not generic Azure-resource import. Bundle `1.9.0` supports only the
declared `entra-public` Profile J shape; an additional or missing resource,
private-ingress topology, changed identity boundary or pre-existing unrelated
lock is rejected.

`1.1.1` intentionally pins the same templates and application artefacts as
`1.1.0`. It proves an explicit compatible no-change upgrade and
rollback without suggesting a runtime feature change:

```text
ingestron azure upgrade --config ingestron.azure.yaml --to 1.1.1 --yes
ingestron azure rollback --config ingestron.azure.yaml --yes
```

`1.2.0` keeps the same runtime behaviour while moving the public release and
digest-pinned worker distribution to the product-owned `ingestron-io` GitHub
namespace. Earlier bundles remain available only for explicit compatibility and
rollback records.

`1.2.1` intentionally pins the same templates and runtime artefacts as `1.2.0`.
It is the public no-change lifecycle candidate: upgrade from `1.2.0` to `1.2.1`,
verify, then roll back to the retained verified `1.2.0` lock:

```text
ingestron azure upgrade --config ingestron.azure.yaml --to 1.2.1 --yes
ingestron azure rollback --config ingestron.azure.yaml --yes
```

New installations use `1.9.0`, which retains the `1.7.0` runtime, corrects the
Flex Consumption lifecycle control and adds exact adoption policy. `create` is the operator-friendly name for the
existing full `install` path. `pause` stops only bundle-declared compute entry
points, and `resume` enables only exact resource IDs recorded as paused by the
same ownership lock. Both mutations require `--yes`; their `plan-*` commands
show current and desired state first.

`--scope cost-bearing` is the default and currently disables the
`submitIngestronJob` trigger, preventing ordinary new submissions without using
an unsupported Flex App Service stop operation. Existing queued and running jobs
may finish. `--scope all` selects every resource the bundle declares pausable. Neither
scope deletes retained state. Storage, registry, network and monitoring usage
can still incur charges, so pause never claims a zero-cost result. A partial
drop is deliberately unsupported because it could destroy retained data or
leave an unreconcilable Bicep deployment.

Bundle `1.7.0` pins Jobs `0.6.0-preview.1` and adds the
customer-managed `dataset.reference-integrity-gate` outcome without adding Azure
resources. It checks deliberately submitted key controls for duplicate entities
and orphan references, then writes a value-free publish or review package. It
retains the quality-policy, schema-baseline, landing-batch and post-Copy
reconciliation gates from earlier bundles. Hosted Jobs does not accept these
customer-managed outcomes.

Uninstall first reconciles every resource ID against the exact lock. It refuses
missing or unexpected resources, adopted Entra objects, a target mismatch or a
changed ownership boundary. The current candidate uses an existing
customer-controlled Entra application and never deletes it.

```text
ingestron azure plan-uninstall --config ingestron.azure.yaml
ingestron azure drop --config ingestron.azure.yaml --yes
```

`drop` is the lifecycle name for exact `uninstall`. It deletes only the complete
Bicep-owned resource group after inventory reconciliation. The original
`install` and `uninstall` command names remain compatible aliases.

## Configuration split

- `ingestron.azure.yaml` contains the runtime installation intent.
- `ingestron.azure.lock.yaml` records runtime release, integration outputs,
  exact Azure ownership and the resource IDs paused by the CLI.
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
