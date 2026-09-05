import assert from "node:assert/strict";
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
  order.transformation.review.status = "pending";
  await writeFile(orderPath, YAML.stringify(order));
  await assert.rejects(
    buildGeneration(base, "dev", "databricks", output),
    /approved review/,
  );
  assert.equal((await verifyGeneration(output)).valid, true);
});
