import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBlueprint } from "../src/product.js";

test("CLI delegates a bounded product command using machine output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ingestron-product-client-"));
  const executable = join(dir, "plan");
  await writeFile(
    executable,
    'process.stdout.write(\'{"contract":"ingestron.physical-plan/v1","assetCount":100}\\n\');\n',
  );
  assert.deepEqual(
    await runBlueprint("plan", ["--safe"], process.execPath, dir),
    {
      contract: "ingestron.physical-plan/v1",
      assetCount: 100,
    },
  );
});

test("CLI refuses unknown product commands", async () => {
  await assert.rejects(() => runBlueprint("apply", []), /unsupported/);
});

test("CLI permits review commands but never infrastructure apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ingestron-product-review-"));
  const executable = join(dir, "resolve-requirements");
  await writeFile(
    executable,
    'process.stdout.write(\'{"contract":"ingestron.requirement-resolution/v1"}\\n\');\n',
  );
  assert.deepEqual(
    await runBlueprint(
      "resolve-requirements",
      ["--proposals", "safe.json"],
      process.execPath,
      dir,
    ),
    { contract: "ingestron.requirement-resolution/v1" },
  );
  await assert.rejects(
    () => runBlueprint("deploy", [], process.execPath, dir),
    /unsupported/,
  );
});
