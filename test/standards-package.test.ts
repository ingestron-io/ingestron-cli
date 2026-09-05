import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { promisify } from "node:util";
import YAML from "yaml";
import { createStandardsPackage } from "../examples/create-standards-package.mjs";
import {
  verifyStandardsPackage,
  importStandardsPackage,
  catalogueStandardsPackages,
} from "../src/standards-package.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "ingestron-standards-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const registry = join(root, "registry");
  await createStandardsPackage(source);
  return { root, source, registry };
}
async function edit(source: string, fn: (manifest: any) => void) {
  const path = join(source, "standards-package.yaml");
  const manifest = YAML.parse(await readFile(path, "utf8"));
  fn(manifest);
  await writeFile(path, YAML.stringify(manifest));
}

test("real CLI verifies, imports, lists and enforces the reviewed digest", async (t) => {
  const { source, registry } = await fixture(t);
  const execute = promisify(execFile);
  async function run(args: string[]) {
    const { stdout } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "standards",
        ...args,
        "--output",
        "json",
      ],
      {
        timeout: 20_000,
        maxBuffer: 1_048_576,
        env: { PATH: process.env.PATH },
      },
    );
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    return response.result;
  }
  const verified = await run(["verify", source]);
  assert.equal(
    (
      await run([
        "import",
        source,
        "--registry",
        registry,
        "--digest",
        verified.digest,
      ])
    ).imported,
    true,
  );
  assert.equal(
    (await run(["catalogue", registry])).packages[0].digest,
    verified.digest,
  );
  assert.equal(
    (await run(["verify", source, "--digest", verified.digest])).valid,
    true,
  );
  await assert.rejects(run(["verify", source, "--digest", "wrong"]));
  await assert.rejects(run(["import", source, "--registry", registry]));
});

test("package verification inventories real template bytes and explicit unknown terms", async (t) => {
  const { source } = await fixture(t);
  const verified = await verifyStandardsPackage(source);
  assert.equal(
    verified.files.filter((file) => file.role === "template").length,
    1,
  );
  assert.equal(verified.executable, false);
  assert.equal(verified.warnings.length, 1);
  assert.deepEqual(
    await verifyStandardsPackage(source, verified.digest),
    verified,
  );
  await assert.rejects(
    verifyStandardsPackage(source, "sha256:wrong"),
    /reviewed digest/,
  );
  await writeFile(join(source, "templates/inspect.sql.jinja"), "altered");
  await assert.rejects(verifyStandardsPackage(source), /digest mismatch/);
});

test("registry keeps two exact versions, replays identical imports and rejects replacement", async (t) => {
  const { root, source, registry } = await fixture(t);
  const first = await verifyStandardsPackage(source);
  assert.equal(
    (await importStandardsPackage(source, registry, first.digest)).imported,
    true,
  );
  assert.equal(
    (await importStandardsPackage(source, registry, first.digest)).imported,
    false,
  );
  const secondPath = join(root, "second");
  await createStandardsPackage(secondPath, "1.1.0");
  const second = await verifyStandardsPackage(secondPath);
  await importStandardsPackage(secondPath, registry, second.digest);
  const catalogue = await catalogueStandardsPackages(registry);
  assert.deepEqual(
    catalogue.packages.map((pack) => pack.version),
    ["1.0.0", "1.1.0"],
  );
  assert.equal(catalogue.automaticUpgrade, false);
  assert.equal(catalogue.packages[0]!.fileCount, 3);
  assert.equal(catalogue.packages[0]!.templateCount, 1);
  assert.equal(Object.hasOwn(catalogue.packages[0]!, "files"), false);
  await edit(source, (manifest) => {
    manifest.publisher = "Changed declaration";
  });
  const changed = await verifyStandardsPackage(source);
  await assert.rejects(
    importStandardsPackage(source, registry, changed.digest),
    /already contains different bytes/,
  );
  assert.equal(
    (await catalogueStandardsPackages(registry)).packages[0]!.digest,
    first.digest,
  );
  assert.deepEqual(await readdir(registry), ["synthetic-relational"]);
});

test("unreviewed import does not create a registry", async (t) => {
  const { source, registry } = await fixture(t);
  await assert.rejects(
    importStandardsPackage(source, registry, "wrong"),
    /reviewed digest/,
  );
  await assert.rejects(readdir(registry), { code: "ENOENT" });
});

test("import rejects source overlap including parent aliases without changing the package", async (t) => {
  const { root, source } = await fixture(t);
  const before = await verifyStandardsPackage(source);
  await assert.rejects(
    importStandardsPackage(source, source, before.digest),
    /inside the source package/,
  );
  await assert.rejects(
    importStandardsPackage(source, join(source, "registry"), before.digest),
    /inside the source package/,
  );
  const alias = join(root, "alias");
  await symlink(source, alias);
  await assert.rejects(
    importStandardsPackage(source, join(alias, "registry"), before.digest),
    /inside the source package/,
  );
  assert.deepEqual(await verifyStandardsPackage(source), before);
});

test("package rejects unsafe paths, duplicates, unknown fields and invalid identities", async (t) => {
  const { source } = await fixture(t);
  const original = await readFile(join(source, "standards-package.yaml"));
  for (const mutate of [
    (m: any) => {
      m.files[0].path = "../outside.yaml";
    },
    (m: any) => {
      m.files[0].path = "/outside.yaml";
    },
    (m: any) => {
      m.files.push(m.files[0]);
    },
    (m: any) => {
      m.execute = "shell";
    },
    (m: any) => {
      m.id = "../other";
    },
    (m: any) => {
      m.version = "1.0.0-01";
    },
    (m: any) => {
      m.layer = "unknown";
    },
    (m: any) => {
      m.standard = "README.md";
    },
    (m: any) => {
      delete m.files[0].outputLicence;
    },
  ]) {
    await writeFile(join(source, "standards-package.yaml"), original);
    await edit(source, mutate);
    await assert.rejects(verifyStandardsPackage(source));
  }
});

test("unrecorded files, oversized content and symbolic package entries fail closed", async (t) => {
  const { root, source } = await fixture(t);
  const extra = join(source, "extra.txt");
  await writeFile(extra, "unrecorded");
  await assert.rejects(verifyStandardsPackage(source), /unrecorded/);
  await writeFile(extra, Buffer.alloc(1_048_577));
  await assert.rejects(verifyStandardsPackage(source), /1 MiB/);
  await rm(extra);
  await symlink(join(root, "outside"), extra);
  await assert.rejects(verifyStandardsPackage(source), /Symbolic/);
  await rm(extra);
  const alias = join(root, "alias");
  await symlink(source, alias);
  await assert.rejects(verifyStandardsPackage(alias), /non-symbolic/);
});

test("registry rejects active locks, symbolic families and tampered stored packages", async (t) => {
  const { root, source, registry } = await fixture(t);
  const verified = await verifyStandardsPackage(source);
  await mkdir(registry);
  const lock = join(registry, ".ingestron-registry.lock");
  await mkdir(lock);
  await assert.rejects(
    importStandardsPackage(source, registry, verified.digest),
    /locked/,
  );
  await assert.rejects(catalogueStandardsPackages(registry), /active/);
  await rm(lock, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  const family = join(registry, verified.id);
  await symlink(outside, family);
  await assert.rejects(
    importStandardsPackage(source, registry, verified.digest),
    /non-symbolic/,
  );
  assert.deepEqual(await readdir(outside), []);
  await rm(family);
  await importStandardsPackage(source, registry, verified.digest);
  await writeFile(join(family, verified.version, "README.md"), "tampered");
  await assert.rejects(catalogueStandardsPackages(registry), /digest mismatch/);
});

test("changing standard identity with a valid file hash still fails package verification", async (t) => {
  const { source } = await fixture(t);
  const file = join(source, "standard.yaml");
  const standard = YAML.parse(await readFile(file, "utf8"));
  standard.metadata.version = "2.0.0";
  const bytes = YAML.stringify(standard);
  await writeFile(file, bytes);
  await edit(source, (m) => {
    m.files[0].digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  });
  await assert.rejects(verifyStandardsPackage(source), /does not match/);
});
