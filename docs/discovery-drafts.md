# Create reviewable contracts from exported metadata

Source-only implementation; not included in a published CLI release yet. Use
Node 22 and build this checkout with `pnpm build`. Allow about 10 minutes for the
synthetic example. No Azure access, credentials, AI provider or cloud spend is
required. Use an authorised metadata export, never business rows or credentials.

The result is editable contract and product YAML, not an approved ingestion
pipeline. Discovery cannot establish business meanings, ownership, trustworthy
watermarks, source connectivity or complete catalogue visibility.

## Preview the example

From the CLI repository, run:

```sh
node dist/cli.js project draft-discovery examples/contract-base \
  --inventory examples/discovery/customer-orders.json --output json
```

Expected result: `applied: false`, `imported: 2`, `conflicts: []`,
`reviewRequired: true`, `unresolvedFields: 1`, and three proposed files with
SHA-256 digests. No file changes. The unresolved field is `segment`: its
nullability was not supplied. It is not automatically classified as nullable.

The output product ID is `discovered-sales`; dataset names become stable IDs
`source-orders` and `source-customers`. `amount` remains `decimal(28,8)` and the
source-declared primary key is retained as technical evidence, not promoted into
business-key semantics. Every draft records the original file-byte digest and
its JSON pointer. Export completeness remains unknown for these legacy formats.

## Create and review drafts in your working base

1. Work in a disposable copy or a clean Git branch of your contract base. A
   contract base is the folder containing `ingestron.yaml`, product/contract
   YAML, environments and generator settings. Do not use a live application's
   writable directory while another user is editing it.
2. Run the same command with `project import-discovery` and your working base
   path instead of `examples/contract-base`. Import writes only new contract and
   product files. It honours custom category paths in `ingestron.yaml`.
3. Inspect the Git diff and each draft's `evidence`, `schema` and `review`.
   Existing contracts, products, environment files and generator selections are
   not rewritten. Conflicting contract IDs are reported and excluded from the
   new product; they are not silently matched to a source.
4. Resolve unknown field types/nullability with the source owner. Set the target,
   ownership, ingestion policy and appropriate standards. Only after review set
   `review.status: approved`. This is a local declaration, not authenticated
   approval evidence; Studio's role/change approvals remain separate.
5. Explicitly add the reviewed product and contracts to the intended generator
   configuration, then validate and plan in the chosen environment. Import never
   selects every generator on your behalf.

`project validate` reports `DISCOVERY_REVIEW_REQUIRED` warnings for drafts. A
selected draft cannot build until it has approved review, an explicit target,
non-empty fields and resolved types/nullability. Plan previews are not approval
or connectivity proof. Failed review checks leave prior build output intact.

## Command options and limits

Both commands accept a contract-base path plus required `--inventory <json>`.
Optional `--source-name` sets the retained filename, `--source-digest` asserts the
expected SHA-256 of the original bytes, and `--product-id` selects a new stable
lowercase product ID. Digests are integrity identifiers, not secrets. A supplied
digest mismatch fails before writing. The commands do not need `--environment`:
discovery facts are not a dev/test/prod delivery decision.

Accepted legacy exports: `ingestron.discovery.adf/v1` (`datasets`),
`ingestron.discovery.fabric/v1` (`items`), and
`ingestron.discovery.databricks/v1` (`tables`). A Synapse export must already use
the supported ADF-style format; an arbitrary Azure resource JSON is not an
inventory. No new cloud collector or comprehensive source-catalogue adapter is
implemented here.

Limits: 20 MiB inventory; 2,000 objects; 2,000 fields per object; 100,000 fields
overall; 1 MiB per generated YAML document. The whole base remains within its
10,000-file/128 MiB limits. Object names must normalise uniquely; field names
must be identifier-safe. Unknown logical types remain `unknown` with their
original spelling retained. Generic `number` is not changed to a guessed decimal.
Only recognised technical metadata is retained, not arbitrary export properties,
row payloads, foreign-key graphs or credentials. Template expressions in imported
metadata are rejected, not evaluated.

## Conflicts, retry and recovery

| Symptom                                | Safe action                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product already exists                 | Review the existing product; do not overwrite it by rediscovery. Use a different `--product-id` for a separate draft comparison.                                                                                                                                                               |
| Contract IDs conflict                  | Inspect the reported IDs. Existing files and omitted source objects are preserved; a partial export never means deletion.                                                                                                                                                                      |
| Invalid metadata or digest             | Correct the export/assertion and repeat the preview. Validation occurs before draft writes.                                                                                                                                                                                                    |
| Import lock exists                     | Check that no importer is running. Inspect `.ingestron-discovery.lock/transaction.json`; do not remove a live lock.                                                                                                                                                                            |
| Interrupted write or recovery required | Preserve the working base and journal. Compare only the journal-listed new files with their expected digests; retain edited/partial files for manual review. After reconciling those exact files, remove the journal and empty lock directory, then preview again. Never reset the whole base. |

Imports use an exclusive cooperating-writer lock, source-state checks and
create-only writes. Normal failures attempt to remove only unchanged files
created by that import. A crash can leave partial drafts and a recovery journal:
multi-file publication is not crash-atomic. External editors must not race the
import. No automatic rediscovery merge or deletion is implemented.

In Studio, the retained inventory job invokes this same CLI importer. Studio
still handles upload integrity, tenant/role scope, evidence records and change
approval invalidation. It deletes the transient uploaded file after processing;
retain your original export outside Studio if you need to retry or compare it.

Next: [bind layered standards](layered-standards.md) and
[verify compiler parity](compiler-protocol.md).
