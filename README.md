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

## Install the technical preview

Download `ingestron-cli-0.3.3-preview.1.tgz` and `SHA256SUMS` from the GitHub
Release, verify the checksum, then install the archive with pnpm:

```sh
shasum -a 256 --check SHA256SUMS
pnpm add --global ./ingestron-cli-0.3.3-preview.1.tgz
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
or service-principal secret. Customer-managed Azure config uses the active Azure
CLI identity and automatically downloads the bundle-pinned Function preview when
an override is not supplied.

See `docs/configuration.md`, `docs/adf-lifecycle.md`,
`docs/azure-lifecycle.md`, `docs/exit-codes.md`, and `SECURITY.md`.

Source is Apache-2.0. The Profile J Function object code and worker image use the
separate Ingestron Runtime Preview Licence. This is an unsupported technical
preview, not a production service, warranty, indemnity, support agreement, or
SLA.
