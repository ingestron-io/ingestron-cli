# Review and repair standards bindings

Source-only PB-060 capability; not a published release or cloud deployment.

Use this when selecting layered standards for a contract base or when editing a
pack has invalidated its existing digest pins. You need Node 22, this CLI source
built with `pnpm build`, a readable Git contract base, and permission to edit it.
No Azure credentials, network access or cloud resources are required.

## Inspect before changing

```sh
node dist/cli.js project inspect-standards /absolute/path/to/base --output json
```

The result contains `packs` and `targets`. Each pack includes its layer, version,
relative file path and SHA-256 digest of its exact source bytes. Each target
includes its existing pin and the digest of the file you are about to change.
Digests are non-secret integrity values, not approvals or deployment evidence.

Inspection uses the safe unresolved loader, so stale pins and incomplete layer
selection do not block it. Invalid YAML, duplicate IDs and unsafe filesystem
paths still fail. Packs without a supported layer/version are not offered.

## Apply one reviewed binding

1. Choose an organisation pack for the project, an infrastructure pack for an
   environment, or an ELT pack for a product. Review its YAML and compatibility
   requirements before choosing it.
2. Copy the target ID, pack ID and both digests from inspection. The following
   placeholders must be replaced with those exact returned values:

   ```sh
   node dist/cli.js project bind-standard /absolute/path/to/base \
     --scope elt --target customer-orders --pack platform \
     --expected-target-digest '<target.digest>' \
     --expected-pack-digest '<pack.digest>' --output json
   ```

3. Expect `applied: true`, `validationRequired: true` and
   `generatorsChanged: false`. Review the one-file Git diff. Comments and unrelated
   product fields are retained. Canonical ODPS products use
   `product.x-ingestron.delivery.elt`; legacy products use `delivery.elt`.
4. Repeat for each affected binding. Then run `project validate` with each
   affected `--environment`, explicitly select the ELT pack in the applicable
   generator YAML, generate and review the outputs. A partial selection or an
   incompatible combination remains invalid; saving a pin does not make it valid.

## Retry and recovery

- `STANDARDS_STALE`: the target or pack changed since inspection. Inspect and
  review again. Do not replace the expected digest without reviewing the change.
- `STANDARDS_INVALID`: choose an existing target and a pack of the same layer.
- `STANDARDS_LOCKED`: another edit may be active. Stop and check for a running
  CLI/Studio worker. After a confirmed crash, inspect the exact base's
  `.ingestron-standards.lock` directory and Git diff. A temporary YAML may remain;
  the target rename is single-file atomic. Only remove that lock after confirming
  no writer is active and preserving any recovery material you need.
- Invalid source YAML cannot be repaired through this catalogue. Fix it in the
  customer Git checkout, then inspect again.

The lock coordinates binding commands, not arbitrary external editors or other
tools. Do not race filesystem edits against a save. Roll back a mistaken binding
by reviewing and reverting its specific Git diff; do not reset the whole base.
These commands do not approve a release, modify generator selections, restore
Labs, or deploy customer resources.
