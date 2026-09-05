import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLayeredBase } from "../examples/create-layered-base.mjs";
import {
  resolveStandardsRelease,
  assertReleaseGenerator,
} from "../src/standards-release.js";
import {
  buildGeneration,
  resolveProject,
  planGeneration,
} from "../src/project.js";

const fixture = JSON.parse(
  await readFile("examples/standards-release.json", "utf8"),
);

test("release declaration is deterministic and preserves explicit unknown output terms", () => {
  const lock = resolveStandardsRelease(fixture, "pack.release")!;
  assert.deepEqual(
    lock,
    resolveStandardsRelease(structuredClone(fixture), "pack.release"),
  );
  assert.equal(lock.outputLicence, "NOASSERTION");
  assert.match(lock.declarationDigest, /^sha256:[a-f0-9]{64}$/);
  assertReleaseGenerator(lock, "adf", "1.1.0");
  assert.throws(
    () => assertReleaseGenerator(lock, "adf", "1.0.0"),
    /no declared/,
  );
  assert.equal(resolveStandardsRelease(undefined, "pack.release"), undefined);
});

test("release rejects unknown fields, unpinned versions and external template engines", () => {
  assert.throws(
    () => resolveStandardsRelease({ ...fixture, execute: "shell" }, "release"),
    /unknown fields/,
  );
  for (const change of [
    { engine: "jinja2" },
    { version: "^1.0.0" },
    { generatorVersion: "latest" },
    { generator: "unknown" },
  ]) {
    const altered = structuredClone(fixture);
    Object.assign(altered.templates[0], change);
    assert.throws(() => resolveStandardsRelease(altered, "release"));
  }
});

test("release rejects missing output terms and duplicate template identities", () => {
  const missing = structuredClone(fixture);
  delete missing.templates[0].outputLicence;
  assert.throws(
    () => resolveStandardsRelease(missing, "release"),
    /outputLicence.*required/,
  );
  assert.throws(
    () =>
      resolveStandardsRelease(
        { ...fixture, templates: [fixture.templates[0], fixture.templates[0]] },
        "release",
      ),
    /duplicate/,
  );
});

test("dependency inventory requires exact versions, kind and explicit integrity", () => {
  const dependency = {
    name: "synthetic-library",
    version: "1.2.3",
    kind: "library",
    licence: "NOASSERTION",
    integrity: "NOASSERTION",
  };
  const raw = { ...fixture, dependencies: [dependency] };
  assert.equal(
    resolveStandardsRelease(raw, "release")!.dependencies[0]?.integrity,
    "NOASSERTION",
  );
  assert.throws(() =>
    resolveStandardsRelease(
      { ...raw, dependencies: [{ ...dependency, integrity: "" }] },
      "release",
    ),
  );
  assert.throws(
    () =>
      resolveStandardsRelease(
        { ...raw, dependencies: [dependency, dependency] },
        "release",
      ),
    /duplicate/,
  );
});

test("release inventory survives resolution, plan and generated manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ingestron-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await createLayeredBase(base, { releaseInventory: true });
  const resolution = await resolveProject(base, "dev");
  const release =
    resolution.deliveryStandards!.products["customer-orders"]!.elt.release;
  assert.ok(release);
  assert.ok(
    resolution.findings.some(
      (finding) => finding.code === "STANDARDS_RELEASE_UNVERIFIED",
    ),
  );
  const plan = await planGeneration(base, "dev", "adf");
  assert.deepEqual(
    plan.deliveryStandards!.products["customer-orders"]!.elt.release,
    release,
  );
  const built = await buildGeneration(base, "dev", "adf", join(root, "output"));
  assert.deepEqual(
    (built.deliveryStandards as typeof resolution.deliveryStandards)!.products[
      "customer-orders"
    ]!.elt.release,
    release,
  );
});
