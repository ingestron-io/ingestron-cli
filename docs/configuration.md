# Configuration

`ingestron.yaml` is declarative, reviewable intent. It contains no credential.
The exact Data Factory resource ID prevents accidental subscription or factory
selection. The profile, endpoint, audience, recipe and friendly connection
aliases are installation settings. ADF global parameters are not required by any
v2 managed pipeline.

The only connection facts stored by the CLI are an alias, existing ADF linked
service name, storage family, non-secret storage account,
container/file-system name and required capability. The account is required by
persistent profiles; no account key, SAS, password or client secret is stored.
Discovery returns only name/type/integration-runtime metadata. `connection test`
first proves that the exact ADF definition is reachable and type-compatible; it
truthfully reports `dataPlaneProbed: false`. The installed synthetic verification
run is the data-plane proof and still never returns secure linked-service fields.

`ingestron.lock.yaml` is written after a verified install with mode `0600`. It
pins the profile, recipe and bundle manifest digests and lists only resources
created and therefore eligible for upgrade or removal. Keep it with deployment
configuration in the operator's protected infrastructure repository; it contains
identifiers but no secrets.

Customer-managed runtime deployment uses a deliberately separate
`ingestron.azure.yaml` and `ingestron.azure.lock.yaml`. The config pins the exact
tenant/subscription/group, Profile J mode, existing Entra caller boundary,
release artefact locations, planned cost and Azure bundle digest. The lock records
only the verified release, credential-free integration outputs, exact owned
resource IDs and release history needed for rollback. Removing or upgrading ADF
integration therefore does not implicitly remove or upgrade the runtime.

Recipes use only nested connection references and paths. `recipeVersion`,
`idempotencyKey`, `expectedDigest`, `mediaType` and physical URIs are deliberately
rejected from the v1 author recipe: the owning boundary resolves them. This keeps
ADF retry/replay safe without requiring every pipeline author to invent values.

Three outcomes are currently recognised:

- `workbook.to-governed-dataset` works through all three placement profiles; and
- `landing.batch-contract-gate` submits a bounded manifest of digest-pinned
  CSV/JSON siblings and is accepted only by `customer-managed` installations;
  and
- `copy.batch-reconciliation-gate` submits source/destination control facts after
  Copy and is accepted only by `customer-managed` installations.

The customer-managed restrictions are enforced during plan, connection plan and
install. Neither outcome can be used to opt into Hosted Jobs.

Profiles preserve placement rather than change recipe syntax:

- `hosted-transient` copies one source through an opaque, object-scoped grant,
  copies governed results home and requests physical hosted deletion;
- `hosted-registered-storage` submits aliases that an authenticated,
  tenant-scoped hosted registration resolves;
- `customer-managed` uses the selected customer endpoint/audience and does not
  depend on the hosted control plane.
