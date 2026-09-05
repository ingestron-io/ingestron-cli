import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { createLayeredBase } from "../examples/create-layered-base.mjs";
import { bindStandard, inspectStandards } from "../src/standards-bindings.js";
import { resolveProject } from "../src/project.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ingestron-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await createLayeredBase(base);
  return base;
}
async function input(base: string, scope = "elt") {
  const catalogue = await inspectStandards(base);
  const target = catalogue.targets.find((item) => item.scope === scope)!;
  const pack = catalogue.packs.find((item) => item.layer === scope)!;
  return {
    scope,
    target: target.id,
    pack: pack.id,
    expectedTargetDigest: target.digest,
    expectedPackDigest: pack.digest,
  };
}

test("catalogue remains readable with stale pins and explicit repinning restores resolution", async (t) => {
  const base = await fixture(t);
  const catalogue = await inspectStandards(base);
  const pack = catalogue.packs.find((item) => item.layer === "elt")!;
  const path = join(base, pack.path);
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n# Reviewed pack change\n`,
  );
  await assert.rejects(resolveProject(base, "dev"));
  const before = await readFile(join(base, "generators/adf.yaml"));
  const result = await bindStandard(base, await input(base));
  assert.equal(result.applied, true);
  assert.equal(result.validationRequired, true);
  assert.equal(result.generatorsChanged, false);
  await resolveProject(base, "dev");
  assert.deepEqual(await readFile(join(base, "generators/adf.yaml")), before);
});

test("stale reviewed target or pack is rejected without overwriting", async (t) => {
  const base = await fixture(t);
  const request = await input(base);
  const catalogue = await inspectStandards(base);
  const target = catalogue.targets.find(
    (item) => item.id === request.target && item.scope === request.scope,
  )!;
  const path = join(base, target.path);
  const changed = `${await readFile(path, "utf8")}\n# external edit\n`;
  await writeFile(path, changed);
  await assert.rejects(
    bindStandard(base, request),
    /Source changed after review/,
  );
  assert.equal(await readFile(path, "utf8"), changed);
  await assert.rejects(
    bindStandard(base, {
      ...(await input(base)),
      expectedPackDigest: "sha256:old",
    }),
    /Source changed after review/,
  );
});

test("wrong-layer and arbitrary-path targets cannot be written", async (t) => {
  const base = await fixture(t);
  const request = await input(base);
  const catalogue = await inspectStandards(base);
  await assert.rejects(
    bindStandard(base, {
      ...request,
      pack: catalogue.packs.find((pack) => pack.layer === "organisation")!.id,
    }),
    /matching layer/,
  );
  await assert.rejects(
    bindStandard(base, { ...request, target: "../ingestron.yaml" }),
    /matching layer/,
  );
});

test("canonical products preserve comments and unrelated product fields", async (t) => {
  const base = await fixture(t);
  const catalogue = await inspectStandards(base);
  const target = catalogue.targets.find((item) => item.scope === "elt")!;
  const path = join(base, target.path);
  await writeFile(
    path,
    `# Product notes\napiVersion: opendataproducts.org/v4.1.0\nproduct:\n  en:\n    name: Customer orders\n    productID: ${target.id}\n  x-ingestron:\n    contracts: []\n`,
  );
  await bindStandard(base, await input(base));
  const source = await readFile(path, "utf8");
  assert.match(source, /# Product notes/);
  const doc = YAML.parse(source);
  assert.equal(doc.product.en.name, "Customer orders");
  assert.ok(doc.product["x-ingestron"].delivery.elt.digest);
  assert.equal(doc.delivery, undefined);
});

test("binding edit respects existing lock and rejects symbolic bases", async (t) => {
  const base = await fixture(t);
  const request = await input(base);
  await mkdir(join(base, ".ingestron-standards.lock"));
  await assert.rejects(bindStandard(base, request), /Another binding edit/);
  await symlink(base, `${base}-link`);
  await assert.rejects(inspectStandards(`${base}-link`));
});

test("organisation and infrastructure bindings update only their explicit owner", async (t) => {
  const base = await fixture(t);
  const catalogue = await inspectStandards(base);
  const product = catalogue.targets.find((item) => item.scope === "elt")!;
  const before = await readFile(join(base, product.path));
  await bindStandard(base, await input(base, "organisation"));
  await bindStandard(base, await input(base, "infrastructure"));
  assert.deepEqual(await readFile(join(base, product.path)), before);
  await resolveProject(base, "dev");
});
