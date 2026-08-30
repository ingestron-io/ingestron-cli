import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  buildGeneration,
  deploymentPlan,
  planGeneration,
  resolveProject,
  verifyGeneration,
} from "../src/project.js";
import { evaluateExpression, renderTemplateValue } from "../src/template.js";

const base = "examples/contract-base";

test("template expressions preserve types, use missing-only defaults and declared values", () => {
  const context = {
    env: { values: { count: 0, enabled: false, empty: "" } },
    inputs: { releaseName: "candidate" },
  };
  assert.equal(renderTemplateValue("{{ env.values.count }}", context), 0);
  assert.equal(renderTemplateValue("{{ env.values.enabled }}", context), false);
  assert.equal(
    renderTemplateValue(
      "{{ env.values.empty | default('fallback') }}",
      context,
    ),
    "",
  );
  assert.equal(
    renderTemplateValue("release-{{ inputs.releaseName }}", context),
    "release-candidate",
  );
  assert.equal(
    evaluateExpression(
      "env.values.count == 0 and not env.values.enabled",
      context,
    ),
    true,
  );
  assert.throws(
    () => renderTemplateValue("{{ env.values.unknown }}", context),
    /Missing value/,
  );
});

test("contract base resolves references, environments and typed declared inputs", async () => {
  const project = await resolveProject(base, "dev", {
    releaseName: "candidate-1",
    includeMaintenance: "false",
  });
  assert.equal(project.contract, "ingestron.contract-base-resolution/v1");
  assert.equal(project.project.id, "finance-platform");
  assert.deepEqual(Object.keys(project.products), ["customer-orders"]);
  assert.deepEqual(Object.keys(project.contracts), ["customers", "orders"]);
  assert.equal(project.products["customer-orders"]!.release, "candidate-1");
  assert.equal(
    (project.contracts.orders!.target as Record<string, unknown>).name,
    "fin_dev_orders",
  );
  assert.equal(
    (project.contracts.orders!.controls as Record<string, unknown>)
      .retentionDays,
    14,
  );
  assert.equal(
    (project.contracts.orders!.controls as Record<string, unknown>).maintenance,
    false,
  );
  assert.match(project.digest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(
    () => resolveProject(base, "dev", { undeclared: "value" }),
    /Undeclared/,
  );
});

test("Fabric plan and build are deterministic and independently verifiable", async () => {
  const plan = await planGeneration(base, "dev", "fabric");
  assert.equal(plan.generator.implementation, "fabric");
  assert.equal(plan.assets.length, 2);
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/);

  const first = await mkdtemp(join(tmpdir(), "ingestron-build-a-"));
  const second = await mkdtemp(join(tmpdir(), "ingestron-build-b-"));
  await buildGeneration(base, "dev", "fabric", first);
  await buildGeneration(base, "dev", "fabric", second);
  assert.equal(
    await readFile(
      join(first, "definitions/pl_fin_dev_orders.create.json"),
      "utf8",
    ),
    await readFile(
      join(second, "definitions/pl_fin_dev_orders.create.json"),
      "utf8",
    ),
  );
  const lock = YAML.parse(
    await readFile(join(first, "ingestron.lock.yaml"), "utf8"),
  );
  assert.equal(lock.deployed, false);
  assert.equal(lock.generator.version, "1.0.0");
  assert.match(
    await readFile(
      join(
        first,
        "items/nb_fin_dev_orders_land_bronze.Notebook/notebook-content.py",
      ),
      "utf8",
    ),
    /saveAsTable/,
  );
  const verification = await verifyGeneration(first);
  assert.equal(verification.valid, true);
});

test("ADF and Databricks built-ins generate independently verifiable native source", async () => {
  for (const generator of ["adf", "databricks"] as const) {
    const plan = await planGeneration(base, "test", generator);
    assert.equal(plan.generator.implementation, generator);
    assert.equal(plan.assets.length, 2);
    const output = await mkdtemp(
      join(tmpdir(), `ingestron-${generator}-build-`),
    );
    const built = await buildGeneration(base, "test", generator, output);
    assert.equal(built.target, generator);
    const verification = await verifyGeneration(output);
    assert.equal(verification.valid, true);
    if (generator === "adf") {
      assert.match(
        await readFile(
          join(output, "factory/pipelines/pl_fin_test_orders.json"),
          "utf8",
        ),
        /copy_to_bronze/,
      );
      assert.match(
        await readFile(
          join(output, "factory/datasets/ds_fin_test_orders_bronze.json"),
          "utf8",
        ),
        /__BIND_TARGET_LINKED_SERVICE__/,
      );
    } else {
      assert.match(
        await readFile(join(output, "databricks.yml"), "utf8"),
        /production|development/,
      );
      assert.match(
        await readFile(join(output, "src/orders.py"), "utf8"),
        /saveAsTable/,
      );
      assert.match(
        await readFile(join(output, "src/reconcile.py"), "utf8"),
        /asset.reconciled/,
      );
    }
  }
});

test("generated source verification rejects a changed declared asset", async () => {
  const output = await mkdtemp(join(tmpdir(), "ingestron-tampered-build-"));
  await buildGeneration(base, "dev", "fabric", output);
  await writeFile(
    join(output, "items/pl_fin_dev_orders.DataPipeline/pipeline-content.json"),
    "{}\n",
  );
  await assert.rejects(() => verifyGeneration(output), /digest mismatch/);
});

test("deployment plan is a credential-free customer-side handoff", async () => {
  const handoff = await deploymentPlan(base, "test", "fabric");
  assert.equal(handoff.contract, "ingestron.deployment-handoff/v1");
  assert.equal(handoff.mutatesTarget, false);
  assert.equal(handoff.requiredExecution, "customer-terminal-or-ci");
  assert.equal(handoff.applyAvailable, false);
  assert.deepEqual(handoff.requiredApprovals, ["semantic", "platform"]);
  assert.deepEqual(handoff.targetBinding, {
    platform: "fabric",
    workspaceId: "33333333-3333-3333-3333-333333333333",
  });
  assert.match(String(handoff.targetBindingDigest), /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(handoff), /fabricIdentity|clientId/);
});
