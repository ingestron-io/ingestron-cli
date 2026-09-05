import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { createHash } from "node:crypto";
import {
  generatorCatalogue,
  requireBuiltinGenerator,
} from "../src/generator-catalogue.js";
import {
  buildGeneration,
  planGeneration,
  verifyGeneration,
} from "../src/project.js";

async function configureNativeIncrementalAdf(base: string) {
  const contractPath = join(base, "contracts/orders.yaml");
  const contract = YAML.parse(await readFile(contractPath, "utf8"));
  contract.source = {
    platform: "adf",
    schema: "dbo",
    dataset: "orders",
    incremental: {
      connector: "azure-sql",
      column: "ingestion_sequence",
      type: "int64",
    },
  };
  contract.schema.fields.push({
    name: "ingestion_sequence",
    type: "long",
    required: true,
  });
  await writeFile(contractPath, YAML.stringify(contract));
  const configPath = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.version = "1.3.0";
  config.contracts = ["orders"];
  config.schedule = { enabled: false };
  await writeFile(configPath, YAML.stringify(config));
  const standardPath = join(base, "standards/platform.yaml");
  const standard = YAML.parse(await readFile(standardPath, "utf8"));
  standard.compatibility.generators.adf.versions.push("1.3.0");
  await writeFile(standardPath, YAML.stringify(standard));
}

async function configureCompositeIncrementalAdf(base: string) {
  const contractPath = join(base, "contracts/orders.yaml");
  const contract = YAML.parse(await readFile(contractPath, "utf8"));
  contract.source = {
    platform: "adf",
    schema: "dbo",
    dataset: "orders",
    incremental: {
      connector: "azure-sql",
      type: "updated-at-int64",
      timestampColumn: "updated_at",
      tieBreakerColumn: "order_sequence",
      tieBreakerGuarantee: "stable-unique-non-negative-int64",
      updateGuarantee: "updated-at-advances-on-every-change",
      deletes: { mode: "soft-delete", column: "is_deleted" },
    },
  };
  contract.schema.fields.push(
    { name: "updated_at", type: "timestamp", required: true },
    { name: "order_sequence", type: "long", required: true },
    { name: "is_deleted", type: "boolean", required: true },
  );
  await writeFile(contractPath, YAML.stringify(contract));
  const configPath = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  config.version = "1.4.0";
  config.contracts = ["orders"];
  config.schedule = { enabled: false };
  await writeFile(configPath, YAML.stringify(config));
  const standardPath = join(base, "standards/platform.yaml");
  const standard = YAML.parse(await readFile(standardPath, "utf8"));
  standard.compatibility.generators.adf.versions.push("1.4.0");
  await writeFile(standardPath, YAML.stringify(standard));
}

test("ADF 1.3 generates a reservation-scoped Azure SQL source window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-adf-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  const output = join(root, "out");
  await cp("examples/contract-base", base, { recursive: true });
  await configureNativeIncrementalAdf(base);
  await buildGeneration(base, "dev", "adf", output);

  const pipeline = JSON.parse(
    await readFile(
      join(output, "factory/pipelines/pl_fin_dev_orders.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(pipeline.properties.parameters).sort(), [
    "handoff_contract",
    "plan_digest",
    "reservation_digest",
    "storage_binding_digest",
    "watermark_from",
    "watermark_to",
  ]);
  assert.equal(
    pipeline.properties.parameters.reservation_digest.defaultValue,
    undefined,
  );
  const copy = pipeline.properties.activities.find(
    (activity: { type: string }) => activity.type === "Copy",
  );
  assert.equal(copy.typeProperties.validateDataConsistency, true);
  assert.equal(copy.validateDataConsistency, undefined);
  assert.deepEqual(copy.typeProperties.source, {
    type: "AzureSqlSource",
    sqlReaderQuery: {
      type: "Expression",
      value:
        "@concat('SELECT * FROM [dbo].[orders] WHERE [ingestion_sequence] > ', pipeline().parameters.watermark_from, ' AND [ingestion_sequence] <= ', pipeline().parameters.watermark_to)",
    },
  });
  assert.deepEqual(copy.outputs[0].parameters.batch_path, {
    type: "Expression",
    value:
      "@concat('batches/', replace(pipeline().parameters.reservation_digest, 'sha256:', ''), '/data')",
  });
  const dataset = JSON.parse(
    await readFile(
      join(output, "factory/datasets/ds_fin_dev_orders_bronze.json"),
      "utf8",
    ),
  );
  const sourceDataset = JSON.parse(
    await readFile(
      join(output, "factory/datasets/ds_fin_dev_orders.json"),
      "utf8",
    ),
  );
  assert.equal(sourceDataset.properties.type, "AzureSqlTable");
  assert.deepEqual(sourceDataset.properties.typeProperties, {
    schema: "dbo",
    table: "orders",
  });
  assert.deepEqual(dataset.properties.parameters, {
    batch_path: { type: "String" },
  });
  assert.deepEqual(dataset.properties.typeProperties.location.folderPath, {
    type: "Expression",
    value: "@dataset().batch_path",
  });
  await assert.rejects(
    readFile(join(output, "factory/triggers/trg_fin_dev_orders.json")),
    /ENOENT/,
  );
  assert.equal((await verifyGeneration(output)).valid, true);
});

test("ADF 1.3 rejects unsafe incremental source configurations before rendering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-adf-window-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  await configureNativeIncrementalAdf(base);
  const contractPath = join(base, "contracts/orders.yaml");
  const generatorPath = join(base, "generators/adf.yaml");
  const originalContract = await readFile(contractPath, "utf8");
  const originalGenerator = await readFile(generatorPath, "utf8");

  for (const alter of [
    (contract: Record<string, any>) => {
      contract.source.incremental.type = "string";
    },
    (contract: Record<string, any>) => {
      contract.source.schema = "dbo; DROP TABLE orders";
    },
    (contract: Record<string, any>) => {
      contract.source.adf = { source: { type: "AzureSqlSource" } };
    },
    (contract: Record<string, any>) => {
      contract.target.adf = { datasetReference: "customerDataset" };
    },
  ]) {
    const contract = YAML.parse(originalContract);
    alter(contract);
    await writeFile(contractPath, YAML.stringify(contract));
    await assert.rejects(
      planGeneration(base, "dev", "adf"),
      /ADF 1\.3\.0 requires one generated Azure SQL source/,
    );
  }
  await writeFile(contractPath, originalContract);
  const generator = YAML.parse(originalGenerator);
  generator.schedule.enabled = true;
  await writeFile(generatorPath, YAML.stringify(generator));
  await assert.rejects(
    planGeneration(base, "dev", "adf"),
    /checkpoint-aware Runner must supply the reserved interval/,
  );
});

test("ADF 1.4 generates an exact composite update window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-adf-composite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  const output = join(root, "out");
  await cp("examples/contract-base", base, { recursive: true });
  await configureCompositeIncrementalAdf(base);
  await buildGeneration(base, "dev", "adf", output);
  const pipeline = JSON.parse(
    await readFile(
      join(output, "factory/pipelines/pl_fin_dev_orders.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(pipeline.properties.parameters).sort(), [
    "cursor_from_tie_breaker",
    "cursor_from_timestamp",
    "cursor_to_tie_breaker",
    "cursor_to_timestamp",
    "handoff_contract",
    "plan_digest",
    "reservation_digest",
    "storage_binding_digest",
  ]);
  const copy = pipeline.properties.activities.find(
    (activity: { type: string }) => activity.type === "Copy",
  );
  assert.equal(copy.typeProperties.validateDataConsistency, true);
  assert.equal(
    copy.typeProperties.source.sqlReaderQuery.value,
    "@concat('SELECT * FROM [dbo].[orders] WHERE ([updated_at] > CONVERT(datetime2(7), ''', pipeline().parameters.cursor_from_timestamp, ''', 127) OR ([updated_at] = CONVERT(datetime2(7), ''', pipeline().parameters.cursor_from_timestamp, ''', 127) AND [order_sequence] > ', pipeline().parameters.cursor_from_tie_breaker, ')) AND ([updated_at] < CONVERT(datetime2(7), ''', pipeline().parameters.cursor_to_timestamp, ''', 127) OR ([updated_at] = CONVERT(datetime2(7), ''', pipeline().parameters.cursor_to_timestamp, ''', 127) AND [order_sequence] <= ', pipeline().parameters.cursor_to_tie_breaker, ')) ORDER BY [updated_at], [order_sequence]')",
  );
  assert.equal(
    copy.outputs[0].parameters.batch_path.value,
    "@concat('batches/', replace(pipeline().parameters.reservation_digest, 'sha256:', ''), '/data')",
  );
  await assert.rejects(
    readFile(join(output, "factory/triggers/trg_fin_dev_orders.json")),
    /ENOENT/,
  );
  assert.equal((await verifyGeneration(output)).valid, true);
});

test("ADF 1.4 rejects incomplete composite source guarantees", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "ingestron-adf-composite-invalid-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  await configureCompositeIncrementalAdf(base);
  const contractPath = join(base, "contracts/orders.yaml");
  const original = await readFile(contractPath, "utf8");
  for (const alter of [
    (contract: Record<string, any>) => {
      contract.source.incremental.updateGuarantee = "best-effort";
    },
    (contract: Record<string, any>) => {
      contract.source.incremental.tieBreakerColumn = "updated_at";
    },
    (contract: Record<string, any>) => {
      contract.source.incremental.tieBreakerGuarantee = "unique-ish";
    },
    (contract: Record<string, any>) => {
      contract.schema.fields.find(
        (field: { name: string }) => field.name === "updated_at",
      ).required = false;
    },
    (contract: Record<string, any>) => {
      contract.source.incremental.deletes = {
        mode: "soft-delete",
        column: "missing",
      };
    },
    (contract: Record<string, any>) => {
      contract.source.adf = {
        source: { type: "AzureSqlSource", sqlReaderQuery: "SELECT secret" },
      };
    },
  ]) {
    const contract = YAML.parse(original);
    alter(contract);
    await writeFile(contractPath, YAML.stringify(contract));
    await assert.rejects(
      planGeneration(base, "dev", "adf"),
      /ADF 1\.4\.0 requires a generated Azure SQL source/,
    );
  }
});

test("ADF 1.2.1 nests copy consistency correctly for both ADF and Synapse and retains ownership evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-copy-consistency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const standardPath = join(base, "standards/platform.yaml");
  const standard = YAML.parse(await readFile(standardPath, "utf8"));
  standard.compatibility.generators.adf.versions.push("1.2.0", "1.2.1");
  standard.compatibility.generators.synapse.versions.push("1.2.0", "1.2.1");
  await writeFile(standardPath, YAML.stringify(standard));
  for (const generator of ["adf", "synapse"]) {
    const configPath = join(base, `generators/${generator}.yaml`);
    const config = YAML.parse(await readFile(configPath, "utf8"));
    const out = join(root, generator);
    const emitted = [];
    for (const version of ["1.2.0", "1.2.1"]) {
      config.version = version;
      await writeFile(configPath, YAML.stringify(config));
      const plan = await buildGeneration(base, "dev", generator, out);
      const pipeline = JSON.parse(
        await readFile(
          join(out, "factory/pipelines/pl_fin_dev_orders.json"),
          "utf8",
        ),
      );
      const copy = pipeline.properties.activities.find(
        (activity: { type: string }) => activity.type === "Copy",
      );
      assert.equal(
        copy.typeProperties.validateDataConsistency,
        version === "1.2.1" ? true : undefined,
      );
      assert.equal(
        Object.hasOwn(copy, "validateDataConsistency"),
        version === "1.2.0",
      );
      assert.equal(copy.policy.secureInput, true);
      assert.equal(copy.policy.secureOutput, true);
      assert.equal(pipeline.properties.activities[1].type, "IfCondition");
      assert.ok(
        pipeline.properties.annotations.some((value: string) =>
          value.startsWith("ingestron-owner:"),
        ),
      );
      const ownership = JSON.parse(
        await readFile(join(out, "resource-ownership.json"), "utf8"),
      );
      assert.ok(ownership.resources.length > 0);
      assert.equal((await verifyGeneration(out)).valid, true);
      emitted.push(plan.planDigest);
    }
    assert.notEqual(
      emitted[0],
      emitted[1],
      "an explicit version upgrade changes the reviewed plan digest",
    );
  }
});

test("ADF 1.2 emits stable contract ownership while legacy profiles remain unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-owner-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const path = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(path, "utf8"));
  const out = join(root, "out");
  await buildGeneration(base, "dev", "adf", out);
  const pipelinePath = join(out, "factory/pipelines/pl_fin_dev_orders.json");
  assert.equal(
    JSON.parse(
      await readFile(pipelinePath, "utf8"),
    ).properties.annotations.some((value: string) =>
      value.startsWith("ingestron-owner:"),
    ),
    false,
  );
  config.version = "1.2.0";
  await writeFile(path, YAML.stringify(config));
  const standardsPath = join(base, "standards/platform.yaml");
  const standard = YAML.parse(await readFile(standardsPath, "utf8"));
  standard.compatibility.generators.adf.versions.push("1.2.0");
  await writeFile(standardsPath, YAML.stringify(standard));
  await buildGeneration(base, "dev", "adf", out);
  const owner = `ingestron-owner:${createHash("sha256")
    .update(JSON.stringify(["finance-platform", "dev", "orders"]))
    .digest("hex")}`;
  assert.ok(
    JSON.parse(
      await readFile(pipelinePath, "utf8"),
    ).properties.annotations.includes(owner),
  );
  for (const folder of ["datasets", "pipelines", "triggers"]) {
    for (const file of await readdir(join(out, "factory", folder))) {
      const annotations = JSON.parse(
        await readFile(join(out, "factory", folder, file), "utf8"),
      ).properties.annotations;
      assert.equal(
        annotations.filter((value: string) =>
          value.startsWith("ingestron-owner:"),
        ).length,
        1,
      );
    }
  }
  assert.equal((await verifyGeneration(out)).valid, true);
  const manifestPath = join(base, "ingestron.yaml");
  const manifest = YAML.parse(await readFile(manifestPath, "utf8"));
  manifest.metadata.id = "another-project";
  await writeFile(manifestPath, YAML.stringify(manifest));
  await buildGeneration(base, "dev", "adf", out);
  assert.equal(
    JSON.parse(
      await readFile(pipelinePath, "utf8"),
    ).properties.annotations.includes(owner),
    false,
  );
});

test("late rendering failure preserves the last bundle and cleans staging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-staged-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const output = join(root, "out");
  await buildGeneration(base, "dev", "adf", output);
  const before = await verifyGeneration(output);
  const path = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(path, "utf8"));
  config.schedule = { enabled: true, activation: "automatic" };
  await writeFile(path, YAML.stringify(config));
  await assert.rejects(
    buildGeneration(base, "dev", "adf", output),
    /activation must be manual/,
  );
  assert.deepEqual(await verifyGeneration(output), before);
  assert.deepEqual((await readdir(root)).sort(), ["base", "out"]);
  config.schedule = { enabled: false };
  await writeFile(path, YAML.stringify(config));
  await buildGeneration(base, "dev", "adf", output);
  assert.equal((await verifyGeneration(output)).valid, true);
  assert.deepEqual((await readdir(root)).sort(), ["base", "out"]);
});

test("generation rejects unowned output, links, base aliases and active locks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-output-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const output = join(root, "out");
  await mkdir(output);
  await writeFile(join(output, "keep.txt"), "user work");
  await assert.rejects(
    buildGeneration(base, "dev", "adf", output),
    /Non-empty output/,
  );
  assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "user work");
  const link = join(root, "linked");
  await symlink(output, link);
  await assert.rejects(buildGeneration(base, "dev", "adf", link), /not a link/);
  const alias = join(root, "alias");
  await symlink(base, alias);
  await assert.rejects(
    buildGeneration(base, "dev", "adf", join(alias, "contracts")),
    /outside the contract base/,
  );
  const lock = join(root, ".fresh.ingestron-build.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.txt"), "another writer");
  await assert.rejects(
    buildGeneration(base, "dev", "adf", join(root, "fresh")),
    /Output is locked/,
  );
  assert.equal(
    await readFile(join(lock, "owner.txt"), "utf8"),
    "another writer",
  );
});

test("installed generator catalogue is isolated and rejects invented versions", () => {
  const catalogue = generatorCatalogue();
  for (const entry of catalogue.generators)
    for (const version of entry.versions)
      assert.equal(
        requireBuiltinGenerator(entry.implementation, version).version,
        version,
      );
  catalogue.generators[0]!.versions.push("fake" as never);
  assert.throws(() => requireBuiltinGenerator("adf", "fake"), /Unsupported/);
  for (const version of [null, 1, "", "latest", "^1.0.0", "99.0.0"])
    assert.throws(() => requireBuiltinGenerator("adf", version), /Unsupported/);
  assert.throws(() => requireBuiltinGenerator("shell", "1.0.0"), /Unsupported/);
  assert.equal(requireBuiltinGenerator("adf", undefined).version, "1.0.0");
});

test("unsupported version fails before overwriting existing output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-generator-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await cp("examples/contract-base", base, { recursive: true });
  const output = join(root, "out");
  await buildGeneration(base, "dev", "adf", output);
  const before = await readFile(join(output, "ingestron.lock.yaml"));
  const path = join(base, "generators/adf.yaml");
  const config = YAML.parse(await readFile(path, "utf8"));
  config.version = "99.0.0";
  await writeFile(path, YAML.stringify(config));
  await assert.rejects(
    planGeneration(base, "dev", "adf"),
    /Unsupported adf version/,
  );
  await assert.rejects(
    buildGeneration(base, "dev", "adf", output),
    /Unsupported adf version/,
  );
  assert.deepEqual(await readFile(join(output, "ingestron.lock.yaml")), before);
});

test("complete generated inventory detects extras, plan edits and malformed locks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-generator-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "out");
  await buildGeneration("examples/contract-base", "dev", "adf", output);
  assert.equal(
    (await verifyGeneration(output)).verificationScope,
    "complete-file-inventory",
  );
  const extra = join(output, "unexpected.json");
  await writeFile(extra, "{}");
  await assert.rejects(verifyGeneration(output), /Unrecorded/);
  await rm(extra);
  const plan = join(output, "generation-plan.json");
  const original = await readFile(plan);
  await writeFile(plan, "{}");
  await assert.rejects(verifyGeneration(output), /digest mismatch/);
  await writeFile(plan, original);
  const lockPath = join(output, "ingestron.lock.yaml");
  const lock = YAML.parse(await readFile(lockPath, "utf8"));
  for (const change of [
    { files: [], fileDigests: {} },
    { files: [...lock.files, lock.files[0]] },
    { fileInventory: "unknown" },
    { files: ["../outside"], fileDigests: { "../outside": "sha256:fake" } },
  ]) {
    await writeFile(lockPath, YAML.stringify({ ...lock, ...change }));
    await assert.rejects(verifyGeneration(output), /inventory is invalid/);
  }
  delete lock.fileInventory;
  lock.files = lock.files.filter(
    (path: string) => !["README.md", "generation-plan.json"].includes(path),
  );
  delete lock.fileDigests["README.md"];
  delete lock.fileDigests["generation-plan.json"];
  await writeFile(lockPath, YAML.stringify(lock));
  assert.equal(
    (await verifyGeneration(output)).verificationScope,
    "legacy-recorded-files",
  );
  await writeFile(extra, "{}");
  await assert.rejects(verifyGeneration(output), /Unrecorded/);
});
