# Ingestron CLI

The cross-platform command-line interface for Ingestron pipeline integration and
customer-managed Azure deployment. It keeps ordinary recipes small and moves
tenant, version, digest, idempotency, physical URI, and transfer details into
trusted profiles and execution records.

```yaml
outcome: workbook.to-governed-dataset
source:
  connection: finance
  path: monthly-close.xlsx
destination:
  connection: governed
  path: monthly-close/
```

The same five-field recipe can submit a bounded CSV/JSON landing manifest to the
durable contract gate. That outcome is intentionally limited to the
customer-managed profile; both hosted profiles fail validation before Azure
deployment.

The same shape also selects `copy.batch-reconciliation-gate`: its source path is
the digest-pinned control manifest created after Copy, and its destination is the
customer-owned immutable decision package prefix. Control values do not enter
CLI configuration or command output. This outcome is customer-managed only.

For `schema.baseline-compatibility-gate`, the source path is one bounded
YAML/JSON control manifest containing named baseline and candidate JSON Schemas.
The durable result says publish or review and retains only safe change codes and
paths; schema bodies are not copied into the result package. This outcome is
customer-managed only.

For `dataset.quality-policy-gate`, the source path is one bounded YAML/JSON
control manifest containing the sample records and explicit quality rules to
evaluate. The gate supports required, non-empty, range, allowed-value and
unique checks. Its durable package contains only the decision, counts and safe
finding locations—not record values, allowed lists or thresholds. This outcome
is customer-managed only and is a bounded release-control check, not proof of
quality across an entire dataset.

For `dataset.reference-integrity-gate`, the source path is one bounded YAML/JSON
control manifest containing the parent/entity key tuples and child/reference key
tuples deliberately extracted by the pipeline. Repeated valid child references
are allowed. The durable package reports duplicate parents and unmatched
references using counts and input indexes without retaining key values. This is
customer-managed only and is not a whole-dataset join or remediation service.

## Install the technical preview

Download `ingestron-cli-0.3.9-preview.1.tgz` and `SHA256SUMS` from the GitHub
Release, verify the checksum, then install the archive with pnpm:

```sh
shasum -a 256 --check SHA256SUMS
pnpm add --global ./ingestron-cli-0.3.9-preview.1.tgz
ingestron version
```

npm publication is intentionally deferred; the GitHub Release is the canonical
preview channel.

## Main workflows

```text
ingestron recipe validate
ingestron project validate|resolve <contract-base> --environment <id>
ingestron gen plan|build <contract-base> --environment <id> --generator <id>
ingestron gen verify <generated-directory>
ingestron deploy plan <contract-base> --environment <id> --generator <id>
ingestron adf init|plan|install|status|verify|upgrade|rollback|plan-uninstall|uninstall
ingestron azure init|plan|install|status|verify|upgrade|rollback|adf-config|plan-uninstall|uninstall
```

The private PB-056 contract-base workflow uses one Git-ready directory containing
multi-file products, contracts, standards, generator configuration and explicit
environment YAML. `$ref` composes values; constrained Jinja-style `{{ ... }}`
expressions can read the selected `env` and declared typed `inputs`. Ambient
process environment variables, secrets, I/O and arbitrary functions are not
available. The same commands are used by Studio, a terminal and CI:

```sh
ingestron project validate examples/contract-base --environment dev
ingestron gen plan examples/contract-base --environment dev --generator fabric
ingestron gen build examples/contract-base --environment dev --generator fabric --out ../generated-fabric
ingestron gen verify ../generated-fabric
ingestron deploy plan examples/contract-base --environment test --generator fabric
```

`deploy plan` produces a credential-free customer-side handoff and never applies
infrastructure. Explicit non-secret inputs must be declared in `ingestron.yaml`
and supplied as `--set name=value`; every resolved input is digest-bound.

The private PB-054 product-engineering client also delegates to an independently
installed Blueprint engine:

```text
ingestron product import --inventory exported-metadata.json --out blueprint.json
ingestron product requirements --source requirements.docx --out proposals.json
ingestron product resolve --proposals proposals.json --decisions decisions.json --out resolution.json
ingestron product plan --blueprint blueprint.json --resolution resolution.json --standards standards.json --target fabric --out plan.json
ingestron product diff --before approved-plan.json --after plan.json
ingestron product approve --plan plan.json --out approval.json
ingestron product generate --plan plan.json --approval approval.json --plugin ../ingestron-plugin-fabric --out generated
ingestron product verify --out generated --plugin ../ingestron-plugin-fabric
```

The historical `product` delegation accepts `fabric`, `adf-synapse` or
`databricks`. It remains for PB-054 compatibility while its proved generators
migrate into the versioned built-in CLI modules. Neither workflow exposes a
target apply in this private slice, and neither is part of the public
technical-preview support promise.

ADF config maps logical recipe connections to existing linked services. It needs
no Ingestron global parameters and stores no connection string, key, token, SAS,
or service-principal secret. Customer-managed Azure initialisation requires an
explicit `--subscription` and verifies that exact target rather than inheriting
the ambient Azure CLI subscription. The generated config uses the resolved Azure
CLI identity and automatically downloads the bundle-pinned Function preview when
an override is not supplied.

See `docs/configuration.md`, `docs/adf-lifecycle.md`,
`docs/azure-lifecycle.md`, `docs/exit-codes.md`, and `SECURITY.md`.

Source is Apache-2.0. The Profile J Function object code and worker image use the
separate Ingestron Runtime Preview Licence. This is an unsupported technical
preview, not a production service, warranty, indemnity, support agreement, or
SLA.
