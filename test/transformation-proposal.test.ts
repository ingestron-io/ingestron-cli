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
import test from "node:test";
import YAML from "yaml";
import {
  previewTransformation,
  applyTransformation,
} from "../src/transformation-proposal.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "ingestron-proposal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createPhaseOneBase } = await import(
    new URL("../examples/create-phase-one-base.mjs", import.meta.url).href
  );
  const base = await createPhaseOneBase(join(root, "base"));
  const graph = JSON.parse(
    await readFile("examples/phase-one-transformation.json", "utf8"),
  );
  const candidate = {
    contract: "ingestron.transformation-proposal/v1",
    contractId: "orders",
    evidence: [
      {
        id: "req-1",
        sourceDigest: `sha256:${"a".repeat(64)}`,
        location: "Synthetic section 1",
        statement:
          "Use the latest completed orders to calculate country revenue.",
      },
    ],
    transformation: { nodes: graph.nodes, outputs: graph.outputs },
  };
  const path = join(root, "candidate.json");
  await writeFile(path, JSON.stringify(candidate));
  return { base, path, candidate, target: join(base, "contracts/orders.yaml") };
}

test("preview is read-only; exact review applies typed graph and preserves evidence and source metadata", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.target, "utf8");
  const review = await previewTransformation(f.base, "dev", f.path);
  assert.equal(review.applied, false);
  assert.equal(review.evidenceAuthenticated, false);
  assert.equal(await readFile(f.target, "utf8"), before);
  assert.equal(
    (await previewTransformation(f.base, "dev", f.path)).reviewDigest,
    review.reviewDigest,
  );
  const result = await applyTransformation(
    f.base,
    "dev",
    f.path,
    review.reviewDigest,
  );
  assert.equal(result.applied, true);
  assert.equal(result.deploymentApproved, false);
  const saved = YAML.parse(await readFile(f.target, "utf8"));
  assert.deepEqual(saved.schema, YAML.parse(before).schema);
  assert.deepEqual(
    saved["x-ingestron-transformation-evidence"],
    f.candidate.evidence,
  );
  assert.deepEqual(saved.transformation.review.requirements, ["req-1"]);
  await assert.rejects(
    applyTransformation(f.base, "dev", f.path, review.reviewDigest),
    /changed/,
  );
});

test("source and candidate changes invalidate review without changing target", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.target, "utf8");
  const review = await previewTransformation(f.base, "dev", f.path);
  f.candidate.evidence[0]!.statement = "Changed business rule";
  await writeFile(f.path, JSON.stringify(f.candidate));
  await assert.rejects(
    applyTransformation(f.base, "dev", f.path, review.reviewDigest),
    /changed/,
  );
  const updated = await previewTransformation(f.base, "dev", f.path);
  await writeFile(
    join(f.base, "contracts/customers.yaml"),
    (await readFile(join(f.base, "contracts/customers.yaml"), "utf8")) +
      "\n# reviewed metadata changed\n",
  );
  await assert.rejects(
    applyTransformation(f.base, "dev", f.path, updated.reviewDigest),
    /changed/,
  );
  assert.equal(await readFile(f.target, "utf8"), before);
});

test("malicious or unsupported proposals and concurrent apply fail closed", async (t) => {
  const f = await fixture(t);
  const review = await previewTransformation(f.base, "dev", f.path);
  await mkdir(join(f.base, ".ingestron-transformation.lock"));
  await assert.rejects(
    applyTransformation(f.base, "dev", f.path, review.reviewDigest),
    /Another transformation/,
  );
  for (const mutate of [
    (c: any) => {
      c.evidence = [];
    },
    (c: any) => {
      c.evidence[0].sourceDigest = "unknown";
    },
    (c: any) => {
      c.transformation.nodes[1].sql = "DROP TABLE orders";
    },
    (c: any) => {
      c.transformation.review = { status: "approved" };
    },
    (c: any) => {
      c.contractId = "../other";
    },
  ]) {
    const candidate = structuredClone(f.candidate);
    mutate(candidate);
    await writeFile(f.path, JSON.stringify(candidate));
    await assert.rejects(previewTransformation(f.base, "dev", f.path));
  }
  const link = f.path + ".link";
  await symlink(f.path, link);
  await assert.rejects(
    previewTransformation(f.base, "dev", link),
    /regular JSON/,
  );
});
