# Select an installed generator and verify its output

Source-only PB-060 implementation, 2026-09-05. No new release or cloud deployment
is implied. Use this guide when reviewing locally generated assets before a Git
pull request. You need Node 22, this CLI checkout and its installed dependencies;
no Azure credentials, network access or paid compute are required by these commands.

## Check the installed compatibility profiles

From the CLI repository, run:

```sh
pnpm build
node dist/cli.js gen catalogue --output json
```

The catalogue returns `ingestron.generator-catalogue/v1`: ADF 1.0.0 and 1.1.0,
Databricks 1.0.0 and Fabric 1.0.0. Synapse uses the ADF implementation. These are
compatibility profiles implemented by the current CLI, not archived historical
executables or downloadable plugins. External packages are not supported yet.

In each generator YAML, `implementation` and `version` must select an installed
pair. An omitted version retains the historical 1.0.0 default. An explicit null,
number, range, unknown version or `latest` is rejected, even if a standards pack
declares it compatible. Standards compatibility is an additional check, not
permission to invent an installed version.

## Generate and check a synthetic bundle

Use a new disposable output directory outside your contract base. Generation
replaces an empty directory or one bearing an Ingestron generation lock; unrelated
non-empty directories and symbolic output links are rejected. Never select an
existing work directory. Edits inside a previously generated directory are still
replaced on successful regeneration; preserve desired changes in source instead.

```sh
preview_root=$(mktemp -d)
node dist/cli.js gen build examples/contract-base --environment dev --generator adf --out "$preview_root/generated" --output json
node dist/cli.js gen verify "$preview_root/generated" --output json
```

Success reports `valid: true` and `verificationScope: complete-file-inventory`.
The lock includes hashes of the generated plan, README and deployable assets.
Unexpected files, modified recorded files, symbolic links, special files and
malformed inventories are rejected. Unsupported generator versions fail before
generation replaces existing output.

Rendering happens in a sibling staging directory. The CLI verifies the staged
bundle and checks that the previous output has not changed before replacing it.
A rendering failure preserves the last bundle. A sibling lock coordinates CLI
writers; uncoordinated editors must not modify output while a build runs. This is
not a filesystem transaction or a guarantee against machine failure between renames.

Older bundles without `fileInventory: complete` report
`verificationScope: legacy-recorded-files`. Their plan and README were not
recorded and remain unchecked, but additional files outside those two legacy
exceptions and the lock are rejected. Rebuild from reviewed source to obtain a
complete inventory; do not manually change the marker to claim stronger coverage.

## Recover from a failed check

- `GENERATOR_VERSION_UNSUPPORTED`: inspect the catalogue, then deliberately select
  an implemented version and compatible standards pack. No fallback is applied.
- `VERIFY_UNEXPECTED`: review the extra file. Keep intended changes in source and
  regenerate into a fresh directory instead of adding unreviewed files to a bundle.
- `VERIFY_DIGEST`: compare with trusted generated output and rebuild from reviewed
  source. Do not simply rewrite hashes to make the failure disappear.
- `VERIFY_INVALID` or `VERIFY_PATH`: inspect the inventory or filesystem entry and
  regenerate from trusted source. Do not follow unknown links or execute files.
- `OUTPUT_OWNERSHIP`: choose a new directory. Do not fabricate a generation lock to
  make the CLI overwrite unrelated work.
- `OUTPUT_CHANGED`: another writer changed the output during generation. Preserve
  those changes and retry only after writers have stopped.
- `GENERATION_LOCKED`: do not delete the lock while a build is running. After
  confirming no writer remains, inspect the sibling
  `.<output-directory-name>.ingestron-build.lock` directory. `staged` contains the
  new attempt; `previous` contains the previous output if interruption occurred
  during replacement. Copy both somewhere safe before recovery. If the destination
  is missing, restore `previous` to it using your file manager, then verify that
  bundle. If both destination and backup exist, compare and preserve them before
  deciding which is authoritative. Only remove the recovered lock directory after
  its contents are preserved and no process is using it; then rerun generation.

After review, the disposable directory can be removed using your file manager.
No resources need restoring or deleting in Azure.

## What this does not prove

This is consistency checking against a local, unsigned lock. An attacker who can
replace both the lock and assets can produce internally consistent false output.
Keep a trusted Git revision or externally verified artefact digest for provenance.
The command does not establish publisher authenticity, licence entitlement,
dependency security, native deployment success or correct business results.

See [release declarations](standards-release.md) for the separate inventory of
standards template labels and dependency terms. Real template packages,
multi-version registries and verified SBOMs remain subsequent work.
