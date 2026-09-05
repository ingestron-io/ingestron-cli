import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { draftDiscovery } from "../src/discovery-draft.js";
import { buildGeneration, resolveProject } from "../src/project.js";

function inventory() {
  return {
    contract: "ingestron.discovery.adf/v1",
    product: "sales-discovery",
    factory: "synthetic-factory",
    datasets: [
      {
        name: "sales_orders",
        table: "orders",
        schemaName: "sales",
        linkedService: "approved-sql",
        type: "AzureSqlTable",
        columns: [
          { name: "id", logicalType: "string", nullable: false },
          {
            name: "amount",
            logicalType: "decimal(28,8)",
            nullable: true,
            nativeType: "decimal",
            precision: 28,
            scale: 8,
          },
          { name: "ratio", logicalType: "number", nullable: true },
          { name: "opaque", logicalType: "geography" },
        ],
      },
    ],
  };
}

async function fixture(t: TestContext, value: unknown = inventory()) {
  const root = await mkdtemp(join(tmpdir(), "ingestron-discovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base"),
    source = join(root, "source.json");
  await cp("examples/contract-base", base, { recursive: true });
  await writeFile(source, JSON.stringify(value));
  return { root, base, source };
}

async function tree(
  root: string,
  prefix = "",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(files, await tree(root, path));
    else files[path] = await readFile(join(root, path), "utf8");
  }
  return files;
}

test("draft preview is read-only; import preserves facts, unknowns, provenance and existing selections", async (t) => {
  const { base, source } = await fixture(t);
  const before = await tree(base);
  const draft = await draftDiscovery(base, source);
  assert.equal(draft.applied, false);
  assert.deepEqual(await tree(base), before);
  const imported = await draftDiscovery(base, source, {
    apply: true,
    sourceDigest: draft.sourceDigest,
  });
  assert.deepEqual(imported.files, draft.files);
  assert.equal(imported.imported, 1);
  assert.equal(imported.reviewRequired, true);
  assert.equal(imported.unresolvedFields, 1);
  const document = YAML.parse(
    await readFile(join(base, "contracts/sales-orders.yaml"), "utf8"),
  );
  assert.equal(document.schema.fields[1].type, "decimal(28,8)");
  assert.equal(document.schema.fields[1]["x-discovery"].precision, 28);
  assert.equal(document.schema.fields[2].type, "number");
  assert.equal(document.schema.fields[3].type, "unknown");
  assert.equal(
    document.schema.fields[3]["x-discovery"].logicalType,
    "geography",
  );
  assert.equal(document.schema.fields[3].required, undefined);
  assert.equal(document.metadata.owner, undefined);
  assert.equal(document.target, undefined);
  assert.equal(document.controls, undefined);
  assert.equal(document.evidence.digest, imported.sourceDigest);
  assert.equal(document.evidence.pointer, "/datasets/0");
  assert.equal(document.evidence.completeness, "unknown");
  assert.equal(document.review.status, "required");
  const after = await tree(base);
  for (const [path, content] of Object.entries(before))
    assert.equal(after[path], content);
  const resolved = await resolveProject(base, "dev");
  assert.ok(
    resolved.findings.some(
      (finding) => finding.code === "DISCOVERY_REVIEW_REQUIRED",
    ),
  );
});

test("malformed later metadata causes no partial writes", async (t) => {
  const value = inventory();
  value.datasets.push({
    ...value.datasets[0]!,
    name: "second",
    columns: [{ name: "bad name", logicalType: "string", nullable: true }],
  });
  const { base, source } = await fixture(t, value);
  const before = await tree(base);
  await assert.rejects(
    draftDiscovery(base, source, { apply: true }),
    /invalid or duplicate column/,
  );
  assert.deepEqual(await tree(base), before);
});

test("discovery rejects digest mismatch, templates, duplicate IDs/columns and invalid decimal metadata", async (t) => {
  const { base, source } = await fixture(t);
  const before = await tree(base);
  await assert.rejects(
    draftDiscovery(base, source, {
      apply: true,
      sourceDigest: `sha256:${"0".repeat(64)}`,
    }),
    /expected source digest/,
  );
  const values = [
    { ...inventory(), factory: "{{ env.values.secret }}" },
    {
      ...inventory(),
      datasets: [
        inventory().datasets[0],
        { ...inventory().datasets[0], name: "sales-orders" },
      ],
    },
    {
      ...inventory(),
      datasets: [
        {
          ...inventory().datasets[0],
          columns: [{ name: "x", logicalType: "decimal(2,3)" }],
        },
      ],
    },
    {
      ...inventory(),
      datasets: [
        {
          ...inventory().datasets[0],
          columns: [
            { name: "x", logicalType: "string" },
            { name: "x", logicalType: "integer" },
          ],
        },
      ],
    },
  ];
  for (const value of values) {
    await writeFile(source, JSON.stringify(value));
    await assert.rejects(draftDiscovery(base, source, { apply: true }));
    assert.deepEqual(await tree(base), before);
  }
});

test("existing products are never overwritten; partial inventories never remove absent contracts", async (t) => {
  const { base, source } = await fixture(t);
  const before = await tree(base);
  await assert.rejects(
    draftDiscovery(base, source, { apply: true, productId: "customer-orders" }),
    /already exists/,
  );
  assert.deepEqual(await tree(base), before);
  const value = inventory();
  value.datasets.push({ ...value.datasets[0]!, name: "orders" });
  await writeFile(source, JSON.stringify(value));
  const result = await draftDiscovery(base, source, { apply: true });
  assert.deepEqual(result.conflicts, ["orders"]);
  assert.equal(result.imported, 1);
  assert.equal(
    await readFile(join(base, "contracts/orders.yaml"), "utf8"),
    before["contracts/orders.yaml"],
  );
  const product = YAML.parse(
    await readFile(join(base, "products/sales-discovery.yaml"), "utf8"),
  );
  assert.deepEqual(product.product["x-ingestron"].contracts, [
    "contract://sales-orders",
  ]);
  const after = await tree(base);
  await assert.rejects(
    draftDiscovery(base, source, { apply: true }),
    /already exists/,
  );
  assert.deepEqual(await tree(base), after);
});

test("custom nested manifest paths work and symbolic directory traversal is rejected", async (t) => {
  const { root, base, source } = await fixture(t);
  await mkdir(join(base, "model"));
  await rename(join(base, "contracts"), join(base, "model/contracts"));
  const manifestPath = join(base, "ingestron.yaml");
  const manifest = YAML.parse(await readFile(manifestPath, "utf8"));
  manifest.paths = { ...manifest.paths, contracts: "model/contracts" };
  await writeFile(manifestPath, YAML.stringify(manifest));
  await draftDiscovery(base, source, { apply: true });
  assert.ok(await readFile(join(base, "model/contracts/sales-orders.yaml")));
  await rename(join(base, "model"), join(root, "outside"));
  await symlink(join(root, "outside"), join(base, "model"));
  await assert.rejects(draftDiscovery(base, source), /non-symbolic directory/);
});

test("overlapping imports are fenced; existing files with different IDs are not overwritten", async (t) => {
  const { base, source } = await fixture(t);
  const before = await tree(base);
  await mkdir(join(base, ".ingestron-discovery.lock"));
  await assert.rejects(
    draftDiscovery(base, source, { apply: true }),
    /holds the lock/,
  );
  await rm(join(base, ".ingestron-discovery.lock"), { recursive: true });
  assert.deepEqual(await tree(base), before);
  await writeFile(
    join(base, "contracts/sales-orders.yaml"),
    "metadata:\n  id: unrelated\nschema:\n  fields: []\n",
  );
  const withConflict = await tree(base);
  await assert.rejects(
    draftDiscovery(base, source, { apply: true }),
    /destination already exists/,
  );
  assert.deepEqual(await tree(base), withConflict);
});

test("selected discovery drafts cannot erase build output or generate before review", async (t) => {
  const { root, base, source } = await fixture(t);
  const out = join(root, "output");
  await buildGeneration(base, "dev", "adf", out);
  await draftDiscovery(base, source, { apply: true });
  const configPath = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.contracts = ["sales-orders"];
  config.products = ["sales-discovery"];
  await writeFile(configPath, YAML.stringify(config));
  await writeFile(join(out, "preserved.txt"), "prior output");
  await assert.rejects(
    buildGeneration(base, "dev", "adf", out),
    /approved review/,
  );
  assert.equal(
    await readFile(join(out, "preserved.txt"), "utf8"),
    "prior output",
  );
  const contractPath = join(base, "contracts/sales-orders.yaml");
  const document = YAML.parse(await readFile(contractPath, "utf8"));
  document.review.status = "approved";
  document.target = { name: "sales_orders", layer: "bronze" };
  await writeFile(contractPath, YAML.stringify(document));
  await assert.rejects(
    buildGeneration(base, "dev", "adf", out),
    /resolved field types/,
  );
  document.schema.fields[3].type = "string";
  document.schema.fields[3].required = false;
  await writeFile(contractPath, YAML.stringify(document));
  const built = await buildGeneration(base, "dev", "adf", out);
  assert.equal(built.deployed, false);
});

test("500-table metadata corpus produces reviewable, resolvable drafts", async (t) => {
  const value = inventory();
  value.datasets = Array.from({ length: 500 }, (_, index) => ({
    ...value.datasets[0]!,
    name: `source_${index}`,
    table: `source_${index}`,
  }));
  const { base, source } = await fixture(t, value);
  const started = performance.now();
  const result = await draftDiscovery(base, source, { apply: true });
  assert.equal(result.imported, 500);
  const project = await resolveProject(base, "dev");
  assert.equal(Object.keys(project.contracts).length, 502);
  assert.equal(
    project.findings.filter(
      (finding) => finding.code === "DISCOVERY_REVIEW_REQUIRED",
    ).length,
    500,
  );
  t.diagnostic(
    `500 drafts and resolution: ${Math.round(performance.now() - started)} ms`,
  );
});

test("documented metadata example produces two drafts and preserves source-declared keys", async (t) => {
  const sample = JSON.parse(
    await readFile("examples/discovery/customer-orders.json", "utf8"),
  );
  const { base, source } = await fixture(t, sample);
  const result = await draftDiscovery(base, source, { apply: true });
  assert.equal(result.imported, 2);
  assert.equal(result.unresolvedFields, 1);
  assert.deepEqual(result.conflicts, []);
  const orders = YAML.parse(
    await readFile(join(base, "contracts/source-orders.yaml"), "utf8"),
  );
  assert.deepEqual(orders.source.declaredPrimaryKey, ["order_id"]);
  assert.equal(orders.schema.fields[1].type, "decimal(28,8)");
});
