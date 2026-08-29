# ADF lifecycle

The managed profile bundle installs a namespaced child pipeline and, only for
transient transfer, namespaced Binary datasets plus one parameterised SAS linked
service. It never owns or edits the user's linked services. Hosted profiles call
`https://api.ingestron.io/v1/jobs`; customer-managed uses its selected endpoint.
Every call uses the factory managed identity. Endpoint, Entra audience, recipe
and storage mappings are compiled from reviewed config, so none of the five
historical Ingestron/job/storage ADF globals is needed.

Bundle 2.2.0 makes the installed pipeline usable as a waiting ADF child
pipeline. After a `succeeded` or `review_required` job, it returns exactly four
credential-free values to Execute Pipeline:

- `jobId` — the opaque durable job identifier;
- `state` — `succeeded` or `review_required`;
- `manifestReference` — the committed customer-storage URI or installed
  destination path; and
- `manifestDigest` — the expected SHA-256 digest.

The parent must enable **Wait on completion** to read
`@activity('<child activity>').output.pipelineReturnValue.<key>`. Failed,
cancelled and expired jobs still fail the child pipeline and return no consumable
result. No source value, storage credential, SAS, token or internal hosted path is
included.

Customer-managed and registered-storage parents may pass the optional
`businessRunKey` string to place an intentional retry at the same immutable
destination. When omitted, the child uses its own ADF `RunId`, preserving the
default one-package-per-execution behaviour. Use a non-sensitive bounded key such
as `close-2026-07-nz`; reusing it with changed source intent fails safely rather
than overwriting the first result. Hosted transient transfer creates a new
isolated upload and does not currently offer this stable-key replay pattern.

Direct-storage parents may also pass a safe relative `sourcePath`. This lets a
copy pipeline write one run-specific reconciliation manifest, then point the
same installed child at that exact object without reinstalling the recipe. The
runtime still resolves the path inside the registered customer container and
rejects traversal, URLs and credentials. When omitted, the installed recipe path
remains the default.

```sh
ingestron adf init --factory-resource-id /subscriptions/.../factories/my-adf \
  --profile hosted-transient --recipe recipe.yaml
ingestron adf connection discover --config ingestron.yaml
ingestron adf connection add finance --config ingestron.yaml \
  --linked-service finance-landing --store blob \
  --account '<storage-account-name>' \
  --namespace finance --capability read
ingestron adf connection add governed --config ingestron.yaml \
  --linked-service governed-lake --store adls \
  --account '<storage-account-name>' \
  --namespace governed --capability write
ingestron adf connection plan --config ingestron.yaml
ingestron adf connection test finance --config ingestron.yaml
ingestron adf plan --config ingestron.yaml
ingestron adf install --config ingestron.yaml --yes
ingestron adf status --config ingestron.yaml
ingestron adf verify --config ingestron.yaml
ingestron adf plan-uninstall --config ingestron.yaml
ingestron adf uninstall --config ingestron.yaml --yes
```

Mutations always re-check the active Azure subscription and run Resource Manager
what-if. `--yes` is explicit CI/non-interactive confirmation, not a bypass. The
v2 bundle declares and pins all three profile templates. What-if may change only
the exact namespaced IDs calculated for that profile. Drift, a different active
subscription, a changed recipe, a changed bundle digest or lock ownership fails
closed.

`upgrade` snapshots the last verified applied config before mutation. `rollback`
checks that snapshot against the same installation/factory, preserves the failed
source config for audit and re-enters the same plan/apply/verify lifecycle. A v1
config migration creates a non-overwritten `.v1.bak`; connection aliases must be
reviewed before the upgraded bundle can plan.
