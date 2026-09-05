import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { compileTransformation } from "../src/transformations.js";
import {
  buildGeneration,
  planGeneration,
  verifyGeneration,
} from "../src/project.js";

const graph = JSON.parse(
  await readFile("examples/phase-one-transformation.json", "utf8"),
);
export const contracts = {
  orders: {
    schema: {
      fields: ["order_id", "customer_id", "amount", "status", "updated_at"].map(
        (name) => ({ name, type: "string", required: true }),
      ),
    },
  },
  customers: {
    schema: {
      fields: ["customer_id", "country_code"].map((name) => ({
        name,
        type: "string",
        required: true,
      })),
    },
  },
};

test("reviewed graph compiles typed joins, casts, filters, deduplication and aggregates", () => {
  const plan = compileTransformation(graph, contracts, "orders")!;
  assert.deepEqual(plan.sources, ["customers", "orders"]);
  assert.equal(plan.schemas.gold!.revenue, "decimal(28,2)");
  assert.equal(plan.schemas.gold!.orders, "long");
  assert.deepEqual(
    compileTransformation(structuredClone(graph), contracts, "orders"),
    plan,
  );
});

test("graph rejects unreviewed decisions, executable text, unknown columns, cycles and incompatible keys", () => {
  for (const change of [
    (g: any) => {
      g.review.status = "pending";
    },
    (g: any) => {
      g.review.requirements = [];
    },
    (g: any) => {
      g.nodes[1].sql = "DROP TABLE customer";
    },
    (g: any) => {
      g.nodes[1].input = "gold";
    },
    (g: any) => {
      g.nodes[1].columns = { amount: "decimal(99,2)" };
    },
    (g: any) => {
      g.nodes[1].columns = { missing: "string" };
    },
    (g: any) => {
      g.nodes[1].columns = { customer_id: "long" };
    },
    (g: any) => {
      g.nodes[2].orderBy = [];
    },
    (g: any) => {
      g.nodes[5].how = "cross";
    },
    (g: any) => {
      g.nodes[6].metrics[0].function = "eval";
    },
    (g: any) => {
      g.outputs.silver = "customers_raw";
      g.nodes[5].right = "orders_raw";
    },
  ]) {
    const altered = structuredClone(graph);
    change(altered);
    assert.throws(() => compileTransformation(altered, contracts, "orders"));
  }
});

test("Databricks 1.1 generation retains transformation and uses value-aware reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-transform-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const orderPath = join(base, "contracts/orders.yaml");
  const order = YAML.parse(await readFile(orderPath, "utf8"));
  order.schema = contracts.orders.schema;
  order.transformation = graph;
  await writeFile(orderPath, YAML.stringify(order));
  const generatorPath = join(base, "generators/databricks.yaml");
  const generator = YAML.parse(await readFile(generatorPath, "utf8"));
  generator.version = "1.1.0";
  generator.contracts = ["orders"];
  Object.assign(generator.target, { catalog: "demo", schema: "customer360" });
  Object.assign(generator.handoff, {
    immutable: true,
    snapshotId: "snapshot_001",
    bronzeRootPath: "/synthetic/bronze",
  });
  await writeFile(generatorPath, YAML.stringify(generator));
  const standardPath = join(base, "standards/platform.yaml");
  const standard = YAML.parse(await readFile(standardPath, "utf8"));
  standard.compatibility.generators.databricks.versions = ["1.0.0", "1.1.0"];
  await writeFile(standardPath, YAML.stringify(standard));
  const plan = await planGeneration(base, "dev", "databricks");
  assert.equal(plan.assets[0]!.transformation!.nodes.length, 7);
  const output = join(root, "output");
  await buildGeneration(base, "dev", "databricks", output);
  assert.equal((await verifyGeneration(output)).valid, true);
  const notebook = await readFile(join(output, "src/orders.py"), "utf8");
  assert.match(notebook, /exceptAll/);
  assert.match(notebook, /Refusing to overwrite an unowned table/);
  assert.match(notebook, /snapshot_001\/fin_dev_customers/);
  const resource = YAML.parse(
    await readFile(join(output, "resources/orders.job.yml"), "utf8"),
  );
  assert.equal(
    resource.resources.jobs.pl_fin_dev_orders.tasks[3].notebook_task
      .base_parameters.stage,
    "reconcile",
  );
  assert.equal(
    resource.resources.jobs.pl_fin_dev_orders.tasks[0].notebook_task
      .base_parameters.silver_table,
    "demo.customer360.fin_dev_orders_silver",
  );
  generator.version = "1.2.0";
  standard.compatibility.generators.databricks.versions.push("1.2.0");
  await writeFile(generatorPath, YAML.stringify(generator));
  await writeFile(standardPath, YAML.stringify(standard));
  const evidenceOutput = join(root, "evidence-output");
  await buildGeneration(base, "dev", "databricks", evidenceOutput);
  assert.equal((await verifyGeneration(evidenceOutput)).valid, true);
  const evidenceResource = YAML.parse(
    await readFile(join(evidenceOutput, "resources/orders.job.yml"), "utf8"),
  ).resources.jobs.pl_fin_dev_orders;
  assert.equal(
    evidenceResource.tags.owner_digest,
    `sha256:${createHash("sha256")
      .update(JSON.stringify(["finance-platform", "dev", "orders"]))
      .digest("hex")}`,
  );
  assert.deepEqual(
    evidenceResource.parameters.map(
      (parameter: { name: string }) => parameter.name,
    ),
    [
      "plan_digest",
      "owner_digest",
      "reservation_digest",
      "storage_binding_digest",
      "source_digest",
    ],
  );
  assert.equal(
    evidenceResource.tasks[3].notebook_task.base_parameters.reservation_digest,
    "{{job.parameters.reservation_digest}}",
  );
  const evidenceNotebook = await readFile(
    join(evidenceOutput, "src/orders.py"),
    "utf8",
  );
  assert.equal(
    evidenceResource.tags.source_digest,
    `sha256:${createHash("sha256").update(evidenceNotebook).digest("hex")}`,
  );
  assert.match(evidenceNotebook, /DESCRIBE HISTORY/);
  assert.match(
    evidenceNotebook,
    /ingestron\.databricks-publication-result\/v1/,
  );
  generator.version = "1.3.0";
  standard.compatibility.generators.databricks.versions.push("1.3.0");
  await writeFile(generatorPath, YAML.stringify(generator));
  await writeFile(standardPath, YAML.stringify(standard));
  const pinnedOutput = join(root, "pinned-output");
  await buildGeneration(base, "dev", "databricks", pinnedOutput);
  assert.equal((await verifyGeneration(pinnedOutput)).valid, true);
  const pinnedResource = YAML.parse(
    await readFile(join(pinnedOutput, "resources/orders.job.yml"), "utf8"),
  ).resources.jobs.pl_fin_dev_orders;
  assert.equal(pinnedResource.tasks.length, 5);
  assert.deepEqual(pinnedResource.tasks[4], {
    task_key: "verify_publication",
    depends_on: [{ task_key: "reconcile" }],
    notebook_task: {
      notebook_path: "../src/orders.py",
      base_parameters: {
        asset_id: "orders",
        plan_digest: "{{job.parameters.plan_digest}}",
        owner_digest: "{{job.parameters.owner_digest}}",
        reservation_digest: "{{job.parameters.reservation_digest}}",
        storage_binding_digest: "{{job.parameters.storage_binding_digest}}",
        handoff_contract: "ingestron.medallion-handoff/v1",
        bronze_path: "/synthetic/bronze/snapshot_001/fin_dev_orders",
        silver_table: "demo.customer360.fin_dev_orders_silver",
        gold_table: "demo.customer360.fin_dev_orders_gold",
        snapshot_id: "snapshot_001",
        stage: "verify_publication",
        published_version: "{{tasks.reconcile.values.delta_version}}",
        expected_count: "{{tasks.reconcile.values.gold_count}}",
        source_digest: "{{job.parameters.source_digest}}",
      },
    },
    job_cluster_key: "__BIND_JOB_CLUSTER__",
  });
  const pinnedNotebook = await readFile(
    join(pinnedOutput, "src/orders.py"),
    "utf8",
  );
  assert.match(pinnedNotebook, /taskValues\.set\(key="delta_version"/);
  assert.match(pinnedNotebook, /option\("versionAsOf", int\(version\)\)/);
  assert.match(pinnedNotebook, /pinned gold publication/);
  assert.equal(
    pinnedResource.tags.source_digest,
    `sha256:${createHash("sha256").update(pinnedNotebook).digest("hex")}`,
  );
  const policy = JSON.parse(
    await readFile(
      join(pinnedOutput, "policies/orders.publication.json"),
      "utf8",
    ),
  );
  assert.deepEqual(policy, {
    contract: "ingestron.phase-one-publication-policy/v1",
    generator: { implementation: "databricks", version: "1.3.0" },
    planDigest: pinnedResource.tags.plan_digest,
    ownerDigest: pinnedResource.tags.owner_digest,
    sourceDigest: pinnedResource.tags.source_digest,
    checks: [
      {
        id: "silver-gold-row-count",
        assertion: "exact-row-count",
        producerTask: "verify_publication",
        subject: "pinned-gold",
      },
    ],
  });
  order.transformation.review.status = "pending";
  await writeFile(orderPath, YAML.stringify(order));
  await assert.rejects(
    buildGeneration(base, "dev", "databricks", output),
    /approved review/,
  );
  assert.equal((await verifyGeneration(output)).valid, true);
});
