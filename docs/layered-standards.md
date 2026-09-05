# Pin organisation, infrastructure and ELT standards

Source-only compiler capability, not a released customer foundation. This first
slice checks declared compatibility and selects the pinned ELT pack for existing
generators. It does not provision infrastructure, test network reachability,
provide the new native ADF-to-Databricks workload, or certify operational controls.

Use layered bindings when products share a foundation but must follow platform
rules. Existing bases without any `delivery` binding keep their legacy behaviour.
New bindings are opt-in and fail closed when incomplete or incompatible.

## Three distinct responsibilities

| Selection           | YAML location                                | Responsibility                                                                     |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Organisation pack   | `ingestron.yaml` → `delivery.organisation`   | Allowed pack IDs and exact invariant values                                        |
| Infrastructure pack | Environment YAML → `delivery.infrastructure` | Declared capabilities and supported handoff protocols                              |
| ELT pack            | Product YAML → `delivery.elt`                | Required capabilities, infrastructure release compatibility and generator settings |

For canonical ODPS products, put `delivery.elt` under
`product.x-ingestron.delivery.elt`, not the ODPS public fields. An unbound product
can remain in the catalogue; a layered generator cannot select it until bound.

Each selection is a mapping with **id**, **version** and **digest**:

```yaml
delivery:
  infrastructure:
    id: foundation
    version: 1.0.0
    digest: sha256:<sha256-of-the-exact-standard-yaml-file>
```

The ID matches `metadata.id` in a standard YAML file. Version matches
`metadata.version` exactly. Obtain the digest from the corresponding standard's
`sourceFiles` entry in the pre-binding `project resolve` result, or compute
SHA-256 over the file bytes locally (for example `shasum -a 256` on macOS).
Prefix the hexadecimal result with `sha256:`. Formatting edits change this digest
too: review and update pins deliberately, never during Generate.

## Pack fields

All three use `kind: StandardsPack`, `metadata.id`, `metadata.version`, and
`layer: organisation`, `infrastructure` or `elt`. Packs in this initial slice
must be self-contained YAML: no `$ref` or template expressions inside the pack.
Normal contract/environment configuration still supports its constrained
references and declared-input expressions.

- Organisation: `allowedInfrastructure` and `allowedElt` are arrays of pack
  IDs. `invariants.infrastructure` and `invariants.elt` map dot-separated object
  paths to exact required values. For example, an ELT invariant
  `logging.includePayload: false` rejects a pack declaring payload logging.
  These are pack-declaration checks, not general runtime policy enforcement.
- Infrastructure: `capabilities` is an array such as `adf.private-source`,
  `adls.parquet`, `databricks.delta`; `handoffs` lists supported protocol IDs.
  Names describe the selected standard's requirements; they do not prove those
  capabilities exist in a customer's environment.
- ELT: `requires` lists capabilities; `infrastructureCompatibility` lists
  `{id, versions: [...]}` entries with exact allowed infrastructure versions.
  `architecture.handoff.contract` must appear in the foundation's `handoffs`.
  Existing architecture, logging, naming, operations and generator-compatibility
  fields remain available to the generator implementation.

The checked-in `test/layered-standards.test.ts` contains executable compatible
and incompatible synthetic bases, including two products sharing one foundation.
It is engineering evidence, not a curated end-user standard release.

## Build and verify

For a synthetic local starting point, run this from the source checkout on
Node 22, using a new destination directory:

```sh
node examples/create-layered-base.mjs /path/to/new-layered-example
node dist/cli.js project resolve /path/to/new-layered-example --environment dev --output json
```

The example creates exact pins for all three layers in dev/test/prod, refuses
to overwrite an existing destination, and makes no cloud calls. The returned
`deliveryStandards` names `organisation`, `foundation` and the product's
`platform` ELT pack. All resource identifiers remain synthetic placeholders.
Remove only that new example directory when finished, retaining any edits you
need first. This example is not a provisioned or supported production standard.

1. Pin the organisation pack, selected environment foundation and product ELT
   pack. Run `project resolve <base> --environment <id>`.
2. Inspect `deliveryStandards`: it records the three exact releases and the
   declared capabilities. Missing pins, file drift, incompatible capabilities,
   handoffs or organisation invariants fail resolution.
3. Add the selected ELT ID to the generator's `standards` list. Select only
   products bound to that ELT release and contracts owned/referenced by those
   products. Run `gen plan` with the intended environment and generator.
4. Review the lock and plan, then run `gen build` outside the contract base.
   `generation-plan.json` and `ingestron.lock.yaml` retain `deliveryStandards`.
   The pinned ELT pack, not whichever pack appears first, supplies generator
   settings. Generation is not deployment.

One run can select multiple products on the same ELT release. For different
releases, use separate generator configurations. Pack IDs are currently unique
within a base: concurrently retained releases need distinct catalogue IDs.
A multi-version registry and pack publication/upgrade workflow remain unfinished.

To fix `STANDARDS_INCOMPATIBLE`, review the named mismatch. Do not change a pin
merely to suppress a policy or capability error: repinning does not bypass those
checks. A real infrastructure change requires separate environment-owner review.
To revert a local selection, restore the exact prior pack files and their pins
from Git and regenerate; no automatic target rollback is performed.

[Release inventories](standards-release.md) now record bounded template and
dependency declarations, and [binding recovery](standards-bindings.md) supports
explicit selection/repinning from Studio or terminal. Verified SBOMs, actual
template packages, cost estimates, full operational assurance and native workload
proof remain later slices.
No existing licences are changed by these bindings.
