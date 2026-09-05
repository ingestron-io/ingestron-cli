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
