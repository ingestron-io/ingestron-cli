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

### Review and apply a candidate from the terminal

The CLI now provides a separate review boundary for a proposed transformation.
It does not infer a graph from prose. An engineer or the private Studio drafting path must
produce the candidate, retaining source digests, locations and statements. This
private sample uses the checked-in synthetic design itself as evidence:

```sh
node examples/create-transformation-proposal.mjs "$sample_root/candidate.json"
node dist/cli.js project preview-transformation "$sample_root/base" --environment dev --candidate "$sample_root/candidate.json" --output json
```

Inspect `evidence`, the typed `plan` and `proposedYaml` in the result. The proposed
YAML shows what approval would write; preview itself does not change the base.
If the proposal is correct, copy its complete `reviewDigest` into this command:

```sh
node dist/cli.js project apply-transformation "$sample_root/base" --environment dev --candidate "$sample_root/candidate.json" --reviewed-digest '<sha256:review-digest>' --output json
```

This is an explicit local source approval, not deployment authorisation. It
replaces the selected contract's transformation and stores evidence under
`x-ingestron-transformation-evidence`, preserving other contract attributes.
Validate, regenerate and obtain fresh delivery approvals afterwards. Preserve
the preceding Git revision if you need to reverse the source change.

Changes to the candidate or base invalidate the digest. Review again rather than
retrying with an old digest. An unchanged apply is not silently replayed after a
source change. A lock prevents cooperating transformation writers from racing;
other editors must not modify source during apply. This is not an atomic
transaction across unrelated writers. A leftover `.ingestron-transformation.lock`
requires checking that no writer is running before manual recovery.

The candidate accepts only its versioned envelope, 1–128 unique evidence
references, a known target contract and supported typed graph nodes. Evidence
statements are data, not commands; digests are retained but their authenticity
and fidelity to original documents are not independently checked. The Studio
server adapter uses these same commands. The private Studio now offers explicit
single-source drafting from accepted, provenance-bearing requirements using a
configured customer Azure AI resource. Accepting a prose proposal alone does not
create or apply a candidate. Live model quality remains unverified.

### Apply the candidate in Studio

In the disposable Studio preview, open **Build → orders → Transformations →
Review a proposed transformation**. Paste the JSON from the generated candidate
file, then select **Preview candidate**. Browser candidates are limited to 8 KiB;
larger candidates need the CLI. The complete action request is capped at 16 KiB.

Read the supplied evidence and proposed contract YAML. These editors include line
numbers and syntax colours. Changing the candidate clears the prior review. If
the source has changed since preview, apply fails and you must preview again.
Save any existing structured edits before using this workflow.

Select **Apply reviewed transformation** only after checking the business rules.
An organisation administrator, product owner or engineer can apply; read-only
roles cannot. Studio queues a retained job, executes the CLI and refreshes the
graph when it succeeds. The terminal shows actual CLI completion. Delivery
approvals are reset, and the current editor is recorded; this is not independent
approval or deployment permission. Validate and regenerate before a fresh review.

The candidate is retained in the private job payload and its evidence is written
to the contract. Temporary candidate files are removed after execution. Do not
paste credentials or customer rows. A failed job does not grant approval; inspect
its message and re-preview changed source rather than blindly retrying a stale
digest. The browser journey has been exercised on a disposable synthetic base,
not against a live customer deployment.

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
explicit placeholders. Wider source discovery, live AI drafting acceptance,
incremental checkpoints, late-arriving data and deletes, atomic shared
product fencing, an ADF-to-Databricks execution handoff, native failure/recovery
proof and workload-scale measurements remain phase-one work. Full-snapshot
generation must not be advertised as incremental ingestion or customer-ready
installation. Labs remains parked; no restore is part of this walkthrough.
