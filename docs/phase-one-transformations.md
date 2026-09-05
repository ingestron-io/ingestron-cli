# Generate reviewed customer-order transformations

Private source-only PB-060 profile, 2026-09-05. Build ADF landing assets and a
Databricks job that derives country revenue from the latest completed orders.
This is a full-snapshot transformation implementation, not a completed phase-one
release or proof that a customer deployment works.

Allow about 20 minutes for the local walkthrough after installing dependencies.
You need the CLI and Studio checkouts, Node 22 and pnpm. No cloud credentials or
paid compute are used. The sample identifiers, review declarations and requirement
references are synthetic; they are not evidence of a human approving requirements.

## Create and inspect the sample

From the CLI checkout:

```sh
pnpm build
sample_root=$(mktemp -d)
node examples/create-phase-one-base.mjs "$sample_root/base"
node dist/cli.js project validate "$sample_root/base" --environment dev --output json
node dist/cli.js gen plan "$sample_root/base" --environment dev --generator databricks --output json
```

The new base contains two source contracts and ADF/Databricks generator
configurations. Its orders contract embeds the authoritative example from
[`phase-one-transformation.json`](../examples/phase-one-transformation.json).
The plan contains seven typed steps, source schemas, requirement references and a
transformation digest. Other inherited sample proposal warnings still need review.

The graph casts amount to `decimal(18,2)` and revision time to `timestamp`, selects
the latest revision per order, then excludes cancelled orders. Filtering first
would incorrectly retain an older completed revision. It joins customer country
and aggregates revenue and order count. An inner join intentionally excludes
orders without a matching customer; it is not a reference-integrity gate.

## Review and generate in Studio

From the Studio checkout, start the disposable local preview:

```sh
node --import tsx scripts/preview-standards.ts --phase-one
```

1. Open `http://127.0.0.1:3106/projects/finance-platform/build`. This harness has
   an isolated synthetic base, local identity, database and jobs. It does not
   edit your normal Studio projects.
2. Select **orders → Transformations**. Inspect the declared execution order,
   silver/gold outputs and requirement references. This view describes source;
   the CLI remains responsible for validation.
3. Select **Edit transformation YAML** to use the existing YAML editor. Save
   source changes before generating. A pending review or invalid graph blocks
   generation, but Builder remains open so that you can fix the YAML.
4. Open **Problems → Review proposal** for the inherited synthetic amount
   proposal and exercise its decision controls. A real project requires an
   authorised engineer's decision. Accepting a proposal does not itself create
   or edit a transformation: this sample already contains one.
5. Select **Generate source**. The terminal shows actual CLI validation, ADF and
   Databricks builds, then independent file-inventory checks. Expect 21 generated
   files across both generators for this profile. This success verifies source
   files and hashes, not Azure ingestion or a Databricks run.

Stop the preview with Ctrl+C; its disposable state is cleaned up. Keep intentional
source edits in a normal reviewed contract base, not in this test harness.

## Generate without Studio

```sh
node dist/cli.js gen build "$sample_root/base" --environment dev --generator adf --out "$sample_root/adf" --output json
node dist/cli.js gen build "$sample_root/base" --environment dev --generator databricks --out "$sample_root/databricks" --output json
node dist/cli.js gen verify "$sample_root/databricks" --output json
```

Inspect `src/orders.py`, `contracts/orders.transformation.json` and
`resources/orders.job.yml` in the Databricks output. Edit the source contract,
not generated files: successful regeneration replaces owned output. See
[output verification and recovery](generator-verification.md).

## Configuration and safety boundaries

Databricks generator `version: 1.1.0` requires an approved transformation on each
selected output contract. Referenced input contracts remain separate metadata
objects. Version 1.0.0 retains its legacy generation behaviour.

- `review.requirements` contains references to reviewed evidence. These strings
  are required but are not independently resolved or authenticated by the compiler.
- `handoff.snapshotId` names the same landing snapshot in ADF and Databricks.
  Use a new safe identifier for each full extract. The generator does not ensure
  that ADF has finished writing it or prevent somebody overwriting its files.
- `handoff.immutable: true` is an operator declaration, not a storage lock.
- `handoff.bronzeRootPath` is the customer Parquet root. The synthetic `abfss`
  location must be replaced with the actual container/account path; it contains
  no credentials. ADF's destination and Databricks' read path must match.
- `target.catalog` and `target.schema` are existing customer Databricks namespaces,
  not resources this profile provisions. Table names are generated beneath them.
- Source field types and `required` nullability must be explicit. Invalid casts
  fail under Spark ANSI mode; timestamp handling uses UTC. No arbitrary SQL,
  Python or expression evaluation is accepted in the transformation graph.

Joins support inner/left, matching typed keys and explicit projections. Duplicate
right keys are rejected to prevent accidental fan-out. Deduplication rejects
null keys and ambiguous ordering ties, while exact duplicate rows are harmless.
Aggregates support sum, min, max and non-null column count. Equality verification
compares schema, values and multiplicity, not just row counts. It uses Spark's
[exceptAll](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.exceptAll.html)
after aligning columns.

Existing target tables must carry matching Ingestron project/contract ownership
properties before overwrite. This is a basic guard, not atomic multi-product
deployment fencing. A crash between creating a table and setting its ownership
properties requires investigation; do not adopt or drop that table automatically.

## Verify processing locally

The optional conformance test needs Python 3.11, PySpark 3.5.6 and Java 17. A
dedicated virtual environment with `pyspark==3.5.6` and `jdk4py==17.0.9.2` supplies
the tested runtime. Set `INGESTRON_SPARK_PYTHON` to that environment's Python:

```sh
pnpm test:transformations:spark
```

The actual local Spark fixture expects NZ revenue `35.50` from two orders and AU
revenue `7.00` from one. It checks cancellation of the latest revision, replay,
same-count wrong-value rejection, ambiguous ties, duplicate join keys, required
nulls and identical duplicates. Only this bounded test collects synthetic output
rows; generated reconciliation does distributed comparisons.

This test executes the generated transformation runtime and parses notebook
syntax. It does not execute Databricks widgets, Delta writes, Unity Catalog
permissions, the ADF pipeline or native job scheduling.

## What is still missing

Do not deploy this sample unchanged. Native compute/identity bindings still use
explicit placeholders. Source discovery, AI proposal materialisation into this
graph, incremental checkpoints, late-arriving data and deletes, atomic shared
product fencing, an ADF-to-Databricks execution handoff, native failure/recovery
proof and workload-scale measurements remain phase-one work. Full-snapshot
generation must not be advertised as incremental ingestion or customer-ready
installation. Labs remains parked; no restore is part of this walkthrough.
