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

## Install the technical preview

Download `ingestron-cli-0.3.7-preview.1.tgz` and `SHA256SUMS` from the GitHub
Release, verify the checksum, then install the archive with pnpm:

```sh
shasum -a 256 --check SHA256SUMS
pnpm add --global ./ingestron-cli-0.3.7-preview.1.tgz
ingestron version
```

npm publication is intentionally deferred; the GitHub Release is the canonical
preview channel.

## Main workflows

```text
ingestron recipe validate
ingestron adf init|plan|install|status|verify|upgrade|rollback|plan-uninstall|uninstall
ingestron azure init|plan|install|status|verify|upgrade|rollback|adf-config|plan-uninstall|uninstall
```

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
