import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { createLayeredBase } from "../examples/create-layered-base.mjs";
import { assertDeliverySelection } from "../src/layered-standards.js";
import {
  buildGeneration,
  planGeneration,
  resolveProject,
} from "../src/project.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ingestron-layered-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const read = async (path: string) =>
    YAML.parse(await readFile(join(base, path), "utf8"));
  const write = async (path: string, value: unknown) =>
    writeFile(join(base, path), YAML.stringify(value));
  const pin = async (id: string) => ({
    id,
    version: "1.0.0",
    digest: `sha256:${createHash("sha256")
      .update(await readFile(join(base, `standards/${id}.yaml`)))
      .digest("hex")}`,
  });
  const elt = await read("standards/platform.yaml");
  Object.assign(elt, {
    layer: "elt",
    requires: ["adf.private-source", "adls.parquet", "databricks.delta"],
    infrastructureCompatibility: [{ id: "foundation", versions: ["1.0.0"] }],
  });
  await write("standards/platform.yaml", elt);
  await write("standards/foundation.yaml", {
    apiVersion: "ingestron.io/v1alpha1",
    kind: "StandardsPack",
    layer: "infrastructure",
    metadata: { id: "foundation", version: "1.0.0" },
    capabilities: ["adf.private-source", "adls.parquet", "databricks.delta"],
    handoffs: ["ingestron.medallion-handoff/v1"],
    network: { sourceAccess: "adf-only" },
  });
  await write("standards/organisation.yaml", {
    apiVersion: "ingestron.io/v1alpha1",
    kind: "StandardsPack",
    layer: "organisation",
    metadata: { id: "organisation", version: "1.0.0" },
    allowedInfrastructure: ["foundation"],
    allowedElt: ["platform"],
    invariants: {
      infrastructure: { "network.sourceAccess": "adf-only" },
      elt: {
        "logging.includePayload": false,
        "logging.correlationId": "required",
      },
    },
  });
  const updatePins = async () => {
    const manifest = await read("ingestron.yaml");
    manifest.delivery = { organisation: await pin("organisation") };
    await write("ingestron.yaml", manifest);
    const env = await read("environments/dev.yaml");
    env.delivery = { infrastructure: await pin("foundation") };
    await write("environments/dev.yaml", env);
    const product = await read("products/customer-orders.yaml");
    product.delivery = { elt: await pin("platform") };
    await write("products/customer-orders.yaml", product);
  };
  await updatePins();
  return { root, base, read, write, pin, updatePins };
}

test("mixed ELT releases require separate generator configurations", async (t) => {
  const { base } = await fixture(t);
  const project = await resolveProject(base, "dev");
  const lock = project.deliveryStandards!;
  const mixed = {
    ...lock,
    products: {
      ...lock.products,
      second: {
        elt: { ...lock.products["customer-orders"]!.elt, id: "another-elt" },
      },
    },
  };
  assert.throws(
    () =>
      assertDeliverySelection(
        mixed,
        ["customer-orders", "second"],
        ["platform", "another-elt"],
      ),
    /separate generator configurations/,
  );
});

test("documented layered example resolves in each environment and never overwrites a destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-layered-example-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = await createLayeredBase(join(root, "example"));
  for (const environment of ["dev", "test", "prod"]) {
    const project = await resolveProject(base, environment);
    assert.equal(project.deliveryStandards?.infrastructure.id, "foundation");
    assert.equal(
      project.deliveryStandards?.products["customer-orders"]?.elt.id,
      "platform",
    );
  }
  const before = await readFile(join(base, "ingestron.yaml"), "utf8");
  await assert.rejects(createLayeredBase(base), { code: "EEXIST" });
  assert.equal(await readFile(join(base, "ingestron.yaml"), "utf8"), before);
});

test("layered standards compile with exact locks and the pinned ELT pack drives source generation", async (t) => {
  const { root, base, read } = await fixture(t);
  const project = await resolveProject(base, "dev");
  assert.equal(project.deliveryStandards?.infrastructure.id, "foundation");
  assert.equal(
    project.deliveryStandards?.products["customer-orders"]?.elt.id,
    "platform",
  );
  const plan = await planGeneration(base, "dev", "adf");
  assert.deepEqual(plan.deliveryStandards, project.deliveryStandards);
  const built = await buildGeneration(
    base,
    "dev",
    "adf",
    join(root, "generated"),
  );
  assert.deepEqual(built.deliveryStandards, project.deliveryStandards);
  const output = await readFile(
    join(root, "generated/ingestron.lock.yaml"),
    "utf8",
  );
  assert.match(output, /ingestron.delivery-standards-lock\/v1/);
  assert.equal(
    (await read("standards/platform.yaml")).logging.includePayload,
    false,
  );
});

test("pack drift and incomplete pins fail rather than silently selecting latest", async (t) => {
  const { base, read, write } = await fixture(t);
  const standard = await read("standards/platform.yaml");
  standard.operations.retries = 9;
  await write("standards/platform.yaml", standard);
  await assert.rejects(resolveProject(base, "dev"), /pinned version\/digest/);
  const product = await read("products/customer-orders.yaml");
  delete product.delivery.elt.digest;
  await write("products/customer-orders.yaml", product);
  await assert.rejects(
    resolveProject(base, "dev"),
    /exact id, version and sha256/,
  );
});

test("repinning cannot bypass capability or organisation invariants", async (t) => {
  const { base, read, write, updatePins } = await fixture(t);
  const infra = await read("standards/foundation.yaml");
  infra.capabilities = ["adls.parquet"];
  await write("standards/foundation.yaml", infra);
  await updatePins();
  await assert.rejects(
    resolveProject(base, "dev"),
    /needs infrastructure capabilities/,
  );
  infra.capabilities = [
    "adf.private-source",
    "adls.parquet",
    "databricks.delta",
  ];
  await write("standards/foundation.yaml", infra);
  const elt = await read("standards/platform.yaml");
  elt.logging.includePayload = true;
  await write("standards/platform.yaml", elt);
  await updatePins();
  await assert.rejects(
    resolveProject(base, "dev"),
    /organisation invariant logging.includePayload/,
  );
});

test("handoff and infrastructure release compatibility must both match", async (t) => {
  const { base, read, write, updatePins } = await fixture(t);
  const infra = await read("standards/foundation.yaml");
  infra.handoffs = ["different-protocol/v1"];
  await write("standards/foundation.yaml", infra);
  await updatePins();
  await assert.rejects(resolveProject(base, "dev"), /handoff is not provided/);
  infra.handoffs = ["ingestron.medallion-handoff/v1"];
  await write("standards/foundation.yaml", infra);
  const elt = await read("standards/platform.yaml");
  elt.infrastructureCompatibility[0].versions = ["2.0.0"];
  await write("standards/platform.yaml", elt);
  await updatePins();
  await assert.rejects(
    resolveProject(base, "dev"),
    /does not support foundation/,
  );
});

test("generation cannot omit its bound ELT pack or select contracts outside product references", async (t) => {
  const { base, read, write } = await fixture(t);
  const config = await read("generators/adf.yaml");
  config.standards = ["organisation"];
  await write("generators/adf.yaml", config);
  await assert.rejects(
    planGeneration(base, "dev", "adf"),
    /must select the pinned ELT/,
  );
  config.standards = ["platform"];
  await write("generators/adf.yaml", config);
  const product = await read("products/customer-orders.yaml");
  product.contracts = ["contract://orders"];
  await write("products/customer-orders.yaml", product);
  await assert.rejects(
    planGeneration(base, "dev", "adf"),
    /not owned or referenced/,
  );
});

test("two products share a foundation and pack; unbound drafts cannot enter a layered build", async (t) => {
  const { base, read, write, pin } = await fixture(t);
  await write("products/customer-master.yaml", {
    apiVersion: "opendataproducts.org/v4.1.0",
    kind: "DataProduct",
    metadata: { id: "customer-master", name: "Customer master" },
    contracts: ["contract://customers"],
    delivery: { elt: await pin("platform") },
  });
  const config = await read("generators/adf.yaml");
  config.products.push("customer-master");
  await write("generators/adf.yaml", config);
  const plan = await planGeneration(base, "dev", "adf");
  assert.equal(Object.keys(plan.deliveryStandards!.products).length, 2);
  assert.equal(plan.deliveryStandards?.infrastructure.id, "foundation");
  const second = await read("products/customer-master.yaml");
  delete second.delivery;
  await write("products/customer-master.yaml", second);
  await assert.rejects(
    planGeneration(base, "dev", "adf"),
    /needs an ELT standard binding/,
  );
});

test("layered packs cannot resolve ambient inputs or unpinned external references", async (t) => {
  const { base, read, write, updatePins } = await fixture(t);
  const standard = await read("standards/platform.yaml");
  standard.naming = { $ref: "standard://organisation#/invariants" };
  await write("standards/platform.yaml", standard);
  await updatePins();
  await assert.rejects(resolveProject(base, "dev"), /self-contained/);
});
