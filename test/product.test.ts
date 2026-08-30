import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBlueprint } from "../src/product.js";

test("CLI delegates a bounded product command using machine output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ingestron-product-client-"));
  const executable = join(dir, "blueprint");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"contract":"ingestron.physical-plan/v1","assetCount":100}\'\n',
  );
  await chmod(executable, 0o700);
  assert.deepEqual(await runBlueprint("plan", ["--safe"], executable), {
    contract: "ingestron.physical-plan/v1",
    assetCount: 100,
  });
});

test("CLI refuses unknown product commands", async () => {
  await assert.rejects(() => runBlueprint("apply", []), /unsupported/);
});

test("CLI permits review commands but never infrastructure apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ingestron-product-review-"));
  const executable = join(dir, "blueprint");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf '%s\\n' '{\"contract\":\"ingestron.requirement-resolution/v1\"}'\n",
  );
  await chmod(executable, 0o700);
  assert.deepEqual(
    await runBlueprint(
      "resolve-requirements",
      ["--proposals", "safe.json"],
      executable,
    ),
    { contract: "ingestron.requirement-resolution/v1" },
  );
  await assert.rejects(
    () => runBlueprint("deploy", [], executable),
    /unsupported/,
  );
});
