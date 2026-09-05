# Declare a standards release inventory

Private PB-060 source capability, not a published pack registry. Use this to
review which built-in template versions and dependency declarations accompany a
layered standards pack. Requires Node 22 and this CLI built locally. It makes no
network calls, installs no packages and changes no cloud resources.

## Add the inventory

1. Review `examples/standards-release.json`. It is an executable synthetic
   example, not a licence grant or complete dependency inventory. Its
   `NOASSERTION` values deliberately mean **unknown**.
2. Add that shape as `release:` in the appropriate versioned standards YAML.
   Review the publisher, support status, pack licence and output terms against
   your actual provenance. Do not replace unknown terms with guessed licences.
3. List the built-in templates used by the pack. Each entry requires a unique
   ID, exact template version, `engine: ingestron-builtin`, generator
   implementation, exact generator version, licence and output terms. Synapse
   currently uses the `adf` implementation; it is not a separate engine.
4. List known runtime/library dependencies with exact three-part versions,
   declared licences and either a SHA-256 integrity declaration or explicit
   `NOASSERTION`. Empty dependencies means not inventoried, not dependency-free.
   Vendor runtime identifiers that do not fit this version profile are not yet
   supported by this inventory schema.
5. Review and repin the pack using [binding recovery](standards-bindings.md).
   Changing inventory text changes the pack's source digest.
6. Run `project validate` and `gen plan` for the selected environment/generator.
   Inspect `deliveryStandards.products.<product-id>.elt.release`, then build and
   check the same inventory is retained in the generated manifest and handoff.

Unknown fields, missing terms, duplicate identities, version ranges, unknown
generator implementations and external template engines fail validation.
Both arrays are bounded to 256 entries. Text is bounded literal data, not an
expression or executable instruction. A selected ELT release must declare a
template for the exact generator implementation/version used by that build.

## What the lock proves

Template IDs and template versions are inventory labels, not loadable module
selectors. Generation still executes the CLI's built-in implementation. The new
guard checks its declared generator/version pairing; it does not attest that a
template label corresponds to a separately packaged source module.

`declarationDigest` hashes the normalised declared inventory. The surrounding
pack pin still hashes its exact YAML bytes. Neither digest proves package
contents, download provenance, licence entitlement, vulnerability status or
compatibility with a real customer runtime. Integrity values are declarations;
the CLI does not fetch packages to verify them in this slice.

`STANDARDS_RELEASE_UNVERIFIED` warns when licence or integrity fields explicitly
contain unknown values. `STANDARDS_RELEASE_DEPRECATED` reflects the publisher's
declared support status. Warnings do not grant distribution or deployment
authority. A pack without `release` retains legacy behaviour and does not acquire
an invented inventory.

## Reproduce the local example

From the CLI repository, choose a new destination that does not already exist:

```sh
node --input-type=module -e 'import {createLayeredBase} from "./examples/create-layered-base.mjs"; await createLayeredBase("/tmp/ingestron-release-example", {releaseInventory:true});'
node dist/cli.js project validate /tmp/ingestron-release-example --environment dev --output json
node dist/cli.js gen plan /tmp/ingestron-release-example --environment dev --generator adf --output json
```

Expect the synthetic unknown-terms warning, two template declarations and no
dependency entries. This example declares ADF 1.1.0 and Databricks 1.0.0 only;
the existing Synapse configuration uses ADF 1.0.0 and is intentionally rejected
until its template/version is explicitly inventoried. Creation refuses an existing destination. Use Git review to
roll back an accidental inventory change; repin all affected consumers again.

External templates, template source archives, verified SBOM production, package
installation, licence approval, multi-version registry resolution and automatic
pack upgrades remain unimplemented. The constrained Jinja inputs already used by
contract-base configuration are separate from executable template engines.
