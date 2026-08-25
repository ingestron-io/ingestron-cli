import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import {
  adfInit,
  adfInstall,
  adfMigrate,
  adfPlan,
  adfPlanUninstall,
  adfRollback,
  adfStatus,
  adfUninstall,
  adfUpgrade,
  adfVerify,
  type CommandRunner,
} from "../src/adf.js";
import { CliError } from "../src/errors.js";

const subscription = "11111111-1111-1111-1111-111111111111";
const factoryId = `/subscriptions/${subscription}/resourceGroups/demo-rg/providers/Microsoft.DataFactory/factories/demo-adf`;

async function configuration() {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-adf-"));
  const path = join(directory, "ingestron.yaml");
  await writeFile(
    path,
    stringify({
      apiVersion: "ingestron.cli/v1",
      kind: "AdfInstallation",
      metadata: { name: "demo" },
      target: { factoryResourceId: factoryId },
      integration: {
        endpoint: "https://api.ingestron.io",
        audience: "api://22222222-2222-2222-2222-222222222222",
        pipelineName: "ingestron_hosted_job_v1",
      },
      bundle: { version: "1.0.0" },
    }),
  );
  return path;
}

const fake = () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === "account")
      return {
        id: subscription,
        user: { type: "servicePrincipal", name: "redacted" },
      };
    if (args.includes("what-if"))
      return {
        changes: [
          {
            changeType: "Create",
            resourceId: `${factoryId}/pipelines/ingestron_hosted_job_v1`,
          },
        ],
      };
    if (args.includes("show"))
      return {
        id: `${factoryId}/pipelines/ingestron_hosted_job_v1`,
        properties: { provisioningState: "Succeeded" },
      };
    return {};
  };
  return { calls, runner };
};

test("init writes a pinned hosted config and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-init-"));
  const path = join(directory, "ingestron.yaml");
  const result = await adfInit(path, factoryId, "demo");
  assert.match(String(result.bundle.digest), /^sha256:[a-f0-9]{64}$/);
  const config = parse(await readFile(path, "utf8"));
  assert.equal(config.integration.endpoint, "https://api.ingestron.io");
  assert.equal(config.apiVersion, "ingestron.cli/v2");
  assert.equal(config.profile, "hosted-transient");
  assert.equal(config.integration.pipelineName, "demo_hosted_transient_v1");
  await assert.rejects(
    () => adfInit(path, factoryId, "demo"),
    (error: unknown) =>
      error instanceof CliError && error.code === "FILE_EXISTS",
  );
});

test("v1 migration is explicit, backed up and preserves the owned pipeline", async () => {
  const path = await configuration();
  await assert.rejects(
    () => adfMigrate(path, "hosted-registered-storage", "recipe.yaml", false),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIRMATION_REQUIRED",
  );
  const result = await adfMigrate(
    path,
    "hosted-registered-storage",
    "recipe.yaml",
    true,
  );
  const config = parse(await readFile(path, "utf8"));
  const backup = parse(await readFile(`${path}.v1.bak`, "utf8"));
  assert.equal(result.to, "ingestron.cli/v2");
  assert.equal(config.apiVersion, "ingestron.cli/v2");
  assert.equal(config.integration.pipelineName, "ingestron_hosted_job_v1");
  assert.match(config.bundle.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(backup.apiVersion, "ingestron.cli/v1");
});

test("plan verifies identity, immutable bundle and ARM what-if", async () => {
  const path = await configuration();
  const azure = fake();
  const plan = await adfPlan(path, azure.runner);
  assert.equal(plan.action, "plan");
  assert.match(plan.bundle.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(azure.calls.some((call) => call.includes("what-if")));
  assert.ok(azure.calls.every((call) => !call.join(" ").includes("secret")));
});

test("install requires confirmation and writes exact ownership lock", async () => {
  const path = await configuration();
  const azure = fake();
  await assert.rejects(
    () => adfInstall(path, false, azure.runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIRMATION_REQUIRED",
  );
  await adfInstall(path, true, azure.runner);
  const lock = parse(
    await readFile(join(dirname(path), "ingestron.lock.yaml"), "utf8"),
  );
  assert.deepEqual(lock.ownedResources, [
    `${factoryId}/pipelines/ingestron_hosted_job_v1`,
  ]);
  assert.ok(azure.calls.some((call) => call.includes("create")));
});

test("status, verify, repeat install, upgrade and rollback are deterministic", async () => {
  const path = await configuration();
  const azure = fake();
  await adfInstall(path, true, azure.runner);
  assert.equal((await adfStatus(path, azure.runner)).installed, true);
  assert.equal((await adfVerify(path, azure.runner)).valid, true);
  await adfInstall(path, true, azure.runner);
  await adfUpgrade(path, true, azure.runner);
  await adfRollback(path, true, azure.runner);
  assert.equal(azure.calls.filter((call) => call.includes("create")).length, 4);
});

test("uninstall refuses a changed ownership lock and deletes only the exact resource", async () => {
  const path = await configuration();
  const azure = fake();
  await adfInstall(path, true, azure.runner);
  const lockPath = join(dirname(path), "ingestron.lock.yaml");
  const lock = parse(await readFile(lockPath, "utf8"));
  lock.ownedResources.push(`${factoryId}/pipelines/customer_pipeline`);
  await writeFile(lockPath, stringify(lock));
  await assert.rejects(
    () => adfPlanUninstall(path, azure.runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "OWNERSHIP_COLLISION",
  );
  lock.ownedResources.pop();
  await writeFile(lockPath, stringify(lock));
  const result = await adfUninstall(path, true, azure.runner);
  assert.deepEqual(result.deleted, [
    `${factoryId}/pipelines/ingestron_hosted_job_v1`,
  ]);
  const deletes = azure.calls.filter(
    (call) => call[0] === "resource" && call[1] === "delete",
  );
  assert.equal(deletes.length, 1);
});

test("status reports an exact uninstall as absent and verify fails closed", async () => {
  const path = await configuration();
  const azure = fake();
  await adfInstall(path, true, azure.runner);
  const missing: CommandRunner = async (args) => {
    if (args[0] === "resource" && args[1] === "show")
      throw new CliError(
        "AZ_COMMAND_FAILED",
        "ERROR: (NotFound) missing\nCode: NotFound",
        4,
      );
    return azure.runner(args);
  };
  const status = await adfStatus(path, missing);
  assert.equal(status.installed, false);
  assert.deepEqual(status.resources, []);
  assert.deepEqual(status.missingResources, [
    `${factoryId}/pipelines/ingestron_hosted_job_v1`,
  ]);
  await assert.rejects(
    () => adfVerify(path, missing),
    (error: unknown) =>
      error instanceof CliError && error.code === "RESOURCE_MISSING",
  );
});

test("active subscription mismatch fails before what-if", async () => {
  const path = await configuration();
  const calls: string[][] = [];
  await assert.rejects(
    () =>
      adfPlan(path, async (args) => {
        calls.push(args);
        return { id: "different" };
      }),
    (error: unknown) =>
      error instanceof CliError && error.code === "AZ_SUBSCRIPTION_MISMATCH",
  );
  assert.equal(calls.length, 1);
});

test("config rejects unknown secret-shaped fields and credentialed endpoints", async () => {
  const path = await configuration();
  const config = parse(await readFile(path, "utf8"));
  config.clientSecret = "must-not-be-accepted";
  await writeFile(path, stringify(config));
  await assert.rejects(
    () => adfPlan(path, fake().runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIG_INVALID",
  );
  delete config.clientSecret;
  config.integration.endpoint = "https://user:password@api.ingestron.io";
  await writeFile(path, stringify(config));
  await assert.rejects(
    () => adfPlan(path, fake().runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIG_INVALID",
  );
});

test("what-if rejects deletion and changes outside exact ownership", async () => {
  const path = await configuration();
  for (const change of [
    {
      changeType: "Delete",
      resourceId: `${factoryId}/pipelines/ingestron_hosted_job_v1`,
    },
    {
      changeType: "Modify",
      resourceId: `${factoryId}/pipelines/customer_pipeline`,
    },
  ]) {
    const runner: CommandRunner = async (args) =>
      args[0] === "account" ? { id: subscription } : { changes: [change] };
    await assert.rejects(
      () => adfPlan(path, runner),
      (error: unknown) =>
        error instanceof CliError &&
        ["UNEXPECTED_DELETE", "OWNERSHIP_COLLISION"].includes(error.code),
    );
  }
});
