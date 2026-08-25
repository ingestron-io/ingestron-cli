import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliError, redact } from "../src/errors.js";
import {
  checkContract,
  validateRecipe,
  verifyPackage,
} from "../src/validate.js";

const temporary = () => mkdtemp(join(tmpdir(), "ingestron-cli-"));

test("minimal nested recipe validates without advanced fields", async () => {
  const directory = await temporary();
  const path = join(directory, "recipe.yaml");
  await writeFile(
    path,
    "outcome: workbook.to-governed-dataset\nsource:\n  connection: finance\n  path: close.xlsx\ndestination:\n  connection: governed\n  path: close/\n",
  );
  assert.deepEqual(await validateRecipe(path), {
    valid: true,
    outcome: "workbook.to-governed-dataset",
    authorFields: [
      "outcome",
      "source.connection",
      "source.path",
      "destination.connection",
      "destination.path",
    ],
    defaultsResolvedBy: "execution-boundary",
  });
});

test("recipe rejects traversal and unexpected fields", async () => {
  const directory = await temporary();
  const path = join(directory, "recipe.yaml");
  await writeFile(
    path,
    "outcome: workbook.to-governed-dataset\nsource:\n  connection: finance\n  path: ../secret\ndestination:\n  connection: governed\n  path: close/\n",
  );
  await assert.rejects(
    () => validateRecipe(path),
    (error: unknown) =>
      error instanceof CliError && error.code === "RECIPE_INVALID",
  );
});

test("contract version is explicit", async () => {
  const directory = await temporary();
  const path = join(directory, "job.yaml");
  await writeFile(
    path,
    "contract: ingestron.job/v2\noutcome: x.y\nsource: {}\ndestination: {}\n",
  );
  await assert.rejects(
    () => checkContract(path),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONTRACT_UNSUPPORTED",
  );
});

test("package verification checks every digest", async () => {
  const directory = await temporary();
  await mkdir(join(directory, "data"));
  const bytes = Buffer.from("id,amount\n1,10\n");
  await writeFile(join(directory, "data", "accepted.csv"), bytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      contract: "ingestron.dataset-package/v1",
      files: [{ path: "data/accepted.csv", digest }],
    }),
  );
  assert.deepEqual(await verifyPackage(directory), {
    valid: true,
    contract: "ingestron.dataset-package/v1",
    filesVerified: 1,
  });
});

test("package verification rejects symlinks", async () => {
  const directory = await temporary();
  const outside = join(directory, "outside.csv");
  await writeFile(outside, "private");
  await symlink(outside, join(directory, "linked.csv"));
  const digest = `sha256:${createHash("sha256").update("private").digest("hex")}`;
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      contract: "ingestron.package/v1",
      files: [{ path: "linked.csv", digest }],
    }),
  );
  await assert.rejects(
    () => verifyPackage(directory),
    (error: unknown) =>
      error instanceof CliError && error.code === "PACKAGE_PATH_UNSAFE",
  );
});

test("credential-shaped output is redacted", () => {
  assert.equal(
    redact("https://x.test/a?sig=abc123&token=secret"),
    "https://x.test/a?sig=[REDACTED]&token=[REDACTED]",
  );
  assert.equal(redact("Bearer abc.def.ghi"), "Bearer [REDACTED]");
});
