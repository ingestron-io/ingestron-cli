import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

import type { CommandRunner } from "../src/adf.js";
import {
  azureAdfConfig,
  azureInit,
  azureInstall,
  azurePlan,
  azurePlanUninstall,
  azureRollback,
  azureStatus,
  azureUninstall,
  azureUpgrade,
  azureVerify,
  type ArtifactDownloader,
  type ArtifactVerifier,
  type LocalRunner,
} from "../src/azure.js";
import { CliError } from "../src/errors.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const subscription = "22222222-2222-4222-8222-222222222222";
const apiClient = "33333333-3333-4333-8333-333333333333";
const callerClient = "44444444-4444-4444-8444-444444444444";
const callerPrincipal = "55555555-5555-4555-8555-555555555555";
const imageDigest =
  "0e539a4bbf8d74b83e8b2e479c8e192376c5ebca66cb1cf2cc11b174004e7107";
const namespaceImageDigest =
  "896991d8f565c8dda1224361a17e89ad405d0f49dee4e961eaa262e5d4db74e7";
const copyReconciliationImageDigest =
  "0355cb140bb204e5c88d22568d927cb61d3a19db378a2c71bea691a000ffe558";
const groupName = "rg-ing-pb040-test";
const groupId = `/subscriptions/${subscription}/resourceGroups/${groupName}`;
const integration = {
  endpoint: "https://func-ing-j-testj01.azurewebsites.net",
  audience: `api://${apiClient}`,
  tenantId: tenant,
  storageAccount: "ingjtestj01",
  sourceContainer: "source",
  packageContainer: "packages",
};
const resourcesOutput = {
  storageAccount: "ingjtestj01",
  queue: "jobs",
  statusTable: "JobStatus",
  connectionsTable: "Connections",
  environment: "cae-ing-j-testj01",
  job: "job-ing-j-testj01",
  functionApp: "func-ing-j-testj01",
  ingressMode: "entra-public",
  privateEndpoint: "",
};
const resourceIds = [
  `${groupId}/providers/Microsoft.ContainerRegistry/registries/ingjcrtestj01`,
  `${groupId}/providers/Microsoft.Storage/storageAccounts/ingjtestj01`,
  `${groupId}/providers/Microsoft.Web/sites/func-ing-j-testj01`,
].sort();

const artifactVerifier: ArtifactVerifier = async (configPath) =>
  resolve(dirname(resolve(configPath)), "jobs.zip");
const localRunner: LocalRunner = async () =>
  "Azure One Deploy completed; the expected function was discovered and temporary Blob access was removed.";

async function bundleDigest(version = "1.1.0") {
  const bytes = await readFile(
    resolve(`bundles/azure/profile-j/${version}/manifest.json`),
  );
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function configuration(version = "1.1.0") {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-azure-"));
  const path = join(directory, "ingestron.azure.yaml");
  await writeFile(
    path,
    stringify({
      apiVersion: "ingestron.azure/v1",
      kind: "AzureInstallation",
      metadata: { name: "test" },
      target: {
        tenantId: tenant,
        subscriptionId: subscription,
        subscriptionName: "Example subscription",
        resourceGroupName: groupName,
        location: "australiaeast",
      },
      profile: {
        name: "profile-j",
        resourceSuffix: "testj01",
        deploymentMode: "temporary-proof",
        apiIngressMode: "entra-public",
      },
      identity: {
        entraApplicationClientId: apiClient,
        allowedClientApplicationIds: [callerClient],
        pipelineCallerPrincipalId: callerPrincipal,
      },
      artifacts: {
        workerImageSource: `https://source.azurecr.io/ingestron-jobs-worker@sha256:${imageDigest}`,
        jobsFunctionsPackage: "jobs.zip",
      },
      cost: { plannedUsd: 3 },
      tags: {
        "ingestron:owner": "customer",
        "ingestron:purpose": "test",
        "ingestron:expires-on": "2026-08-26",
      },
      bundle: { version, digest: await bundleDigest(version) },
    }),
  );
  return path;
}

function fakeAzure(
  options: {
    existing?: boolean;
    drift?: boolean;
    failCreateOnce?: boolean;
    foundationNoise?: boolean;
    workerDigest?: string;
  } = {},
) {
  let exists = options.existing ?? false;
  let failCreateOnce = options.failCreateOnce ?? false;
  const workerDigest = options.workerDigest ?? imageDigest;
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === "account")
      return {
        id: subscription,
        tenantId: tenant,
        name: "Example subscription",
      };
    if (args[0] === "group" && args[1] === "exists") return exists;
    if (args[0] === "group" && args[1] === "show")
      return {
        id: groupId,
        tags: {
          "ingestron:programme": "ingestron",
          "ingestron:profile": "profile-j",
          "ingestron:lifecycle": "temporary-proof",
          "ingestron:managed-by": "bicep",
          "ingestron:monthly-cost-ceiling-usd": "50",
        },
      };
    if (args[0] === "group" && args[1] === "delete") {
      exists = false;
      return {};
    }
    if (
      args[0] === "deployment" &&
      args[1] === "sub" &&
      args.includes("what-if") &&
      options.foundationNoise
    )
      return {
        changes: [
          {
            changeType: "Modify",
            resourceId: `${groupId}/providers/Microsoft.ContainerRegistry/registries/ingjcrtestj01`,
            delta: [
              {
                path: "properties.anonymousPullEnabled",
                propertyChangeType: "Delete",
                before: false,
                after: null,
              },
            ],
          },
          {
            changeType: "Modify",
            resourceId: `${groupId}/providers/Microsoft.ContainerRegistry/registries/ingjcrtestj01/providers/Microsoft.Authorization/roleAssignments/77777777-7777-4777-8777-777777777777`,
            delta: [
              {
                path: "properties.principalId",
                propertyChangeType: "Modify",
                before: "66666666-6666-4666-8666-666666666666",
                after: "[reference('/subscriptions/...').principalId]",
              },
              {
                path: "properties.principalType",
                propertyChangeType: "NoEffect",
                before: null,
                after: "ServicePrincipal",
              },
            ],
          },
        ],
      };
    if (args[0] === "deployment" && args.includes("what-if"))
      return {
        changes: [
          {
            changeType: exists ? "Ignore" : "Create",
            resourceId: exists
              ? `${groupId}/providers/Microsoft.Storage/storageAccounts/ingjtestj01`
              : groupId,
          },
        ],
      };
    if (args[0] === "deployment" && args[1] === "sub" && args[2] === "create") {
      exists = true;
      return {
        properties: { outputs: { registryName: { value: "ingjcrtestj01" } } },
      };
    }
    if (args[0] === "acr" && args[1] === "import") return {};
    if (args[0] === "acr" && args[1] === "manifest")
      return { digest: `sha256:${workerDigest}` };
    if (
      args[0] === "deployment" &&
      args[1] === "group" &&
      args[2] === "create"
    ) {
      if (failCreateOnce) {
        failCreateOnce = false;
        throw new CliError("AZ_COMMAND_FAILED", "simulated interruption", 4);
      }
      return {
        properties: {
          outputs: {
            resources: { value: resourcesOutput },
            integration: { value: integration },
          },
        },
      };
    }
    if (args[0] === "resource" && args[1] === "list")
      return [
        ...resourceIds.map((id) => ({ id })),
        ...(options.drift
          ? [{ id: `${groupId}/providers/Test/drift/unowned` }]
          : []),
      ];
    if (args[0] === "deployment" && args[1] === "group" && args[2] === "show")
      return {
        properties: {
          outputs: {
            integration: { value: integration },
            jobsPackage: {
              value: {
                version: "0.1.0-preview.1",
                sha256:
                  "cd28333435a4fa68e528bf49334e3f2499d46ca615b0af395c4b9f6a6d73a340",
              },
            },
          },
        },
      };
    if (args[0] === "resource" && args[1] === "show")
      return {
        properties: {
          identityProviders: {
            azureActiveDirectory: {
              registration: { clientId: apiClient },
              validation: {
                allowedAudiences: [`api://${apiClient}`],
                defaultAuthorizationPolicy: {
                  allowedApplications: [callerClient],
                },
              },
            },
          },
        },
      };
    if (args[0] === "containerapp")
      return {
        properties: {
          template: {
            containers: [
              {
                image: `ingjcrtestj01.azurecr.io/ingestron-jobs-worker@sha256:${workerDigest}`,
              },
            ],
          },
        },
      };
    if (args[0] === "functionapp")
      return [{ name: "func-ing-j-testj01/submitIngestronJob" }];
    return {};
  };
  return { calls, runner };
}

test("azure init requires and resolves the explicit subscription target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-azure-init-"));
  const packagePath = join(directory, "jobs.zip");
  await writeFile(packagePath, "synthetic fixture");
  const path = join(directory, "ingestron.azure.yaml");
  const fake = fakeAzure();
  await azureInit(
    path,
    {
      name: "test",
      subscriptionId: subscription,
      resourceGroupName: groupName,
      location: "australiaeast",
      resourceSuffix: "testj01",
      deploymentMode: "temporary-proof",
      apiIngressMode: "entra-public",
      entraApplicationClientId: apiClient,
      allowedClientApplicationIds: [callerClient],
      pipelineCallerPrincipalId: callerPrincipal,
      workerImageSource: `https://source.azurecr.io/ingestron-jobs-worker@sha256:${imageDigest}`,
      jobsFunctionsPackage: packagePath,
      plannedUsd: 3,
      expiresOn: "2026-08-26",
    },
    fake.runner,
    artifactVerifier,
  );
  const config = parse(await readFile(path, "utf8"));
  assert.equal(config.target.subscriptionId, subscription);
  assert.equal(config.target.tenantId, tenant);
  assert.ok(
    fake.calls.some(
      (args) =>
        args[0] === "account" &&
        args.includes("--subscription") &&
        args.includes(subscription),
    ),
  );
  assert.match(config.bundle.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(config).includes("secret"), false);
});

test("azure init downloads the pinned Function package and defaults the worker digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-azure-download-"));
  const path = join(directory, "ingestron.azure.yaml");
  const downloads: Parameters<ArtifactDownloader>[] = [];
  const downloader: ArtifactDownloader = async (...parameters) => {
    downloads.push(parameters);
  };
  await azureInit(
    path,
    {
      name: "test",
      subscriptionId: subscription,
      resourceGroupName: groupName,
      location: "australiaeast",
      resourceSuffix: "testj01",
      deploymentMode: "temporary-proof",
      apiIngressMode: "entra-public",
      entraApplicationClientId: apiClient,
      allowedClientApplicationIds: [callerClient],
      pipelineCallerPrincipalId: callerPrincipal,
      plannedUsd: 3,
      expiresOn: "2026-08-26",
    },
    fakeAzure().runner,
    artifactVerifier,
    downloader,
  );
  const config = parse(await readFile(path, "utf8"));
  assert.deepEqual(downloads, [
    [
      "https://github.com/ingestron-io/ingestron-azure/releases/download/v0.4.4-preview.1/ingestron-jobs-0.3.0-preview.1-8db305318e82.zip",
      join(
        directory,
        "artifacts",
        "ingestron-jobs-0.3.0-preview.1-8db305318e82.zip",
      ),
      "8db305318e8215ab1c2240b83992fae49a430b38b992e7bd592229ead7b81bd5",
    ],
  ]);
  assert.equal(
    config.artifacts.workerImageSource,
    `https://ghcr.io/ingestron-io/ingestron-jobs-worker@sha256:${copyReconciliationImageDigest}`,
  );
  assert.equal(
    config.artifacts.jobsFunctionsPackage,
    "artifacts/ingestron-jobs-0.3.0-preview.1-8db305318e82.zip",
  );
  assert.equal(config.bundle.version, "1.4.0");
});

test("plan defers runtime what-if until the Bicep foundation exists", async () => {
  const path = await configuration();
  const plan = await azurePlan(path, fakeAzure().runner, artifactVerifier);
  assert.equal(plan.runtime.deferredUntilFoundation, true);
  assert.equal(plan.cost.liveBudgetPreflight, "operator-owned");
});

test("plan ignores only exact Azure foundation provider noise", async () => {
  const path = await configuration();
  const plan = await azurePlan(
    path,
    fakeAzure({ existing: true, foundationNoise: true }).runner,
    artifactVerifier,
  );
  assert.deepEqual(
    plan.foundation.map((change) => change.changeType),
    ["Ignore", "Ignore"],
  );
});

test("install refuses to adopt an existing tagged group without a lock", async () => {
  const path = await configuration();
  await assert.rejects(
    () =>
      azureInstall(
        path,
        true,
        fakeAzure({ existing: true }).runner,
        localRunner,
        artifactVerifier,
      ),
    (error: unknown) =>
      error instanceof CliError && error.code === "OWNERSHIP_COLLISION",
  );
});

test("install is confirmed, retryable after interruption and exactly locked", async () => {
  const path = await configuration();
  const azure = fakeAzure({ failCreateOnce: true });
  await assert.rejects(
    () =>
      azureInstall(path, false, azure.runner, localRunner, artifactVerifier),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIRMATION_REQUIRED",
  );
  await assert.rejects(() =>
    azureInstall(path, true, azure.runner, localRunner, artifactVerifier),
  );
  const pending = parse(
    await readFile(join(dirname(path), "ingestron.azure.lock.yaml"), "utf8"),
  );
  assert.equal(pending.state, "installing");
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  const lock = parse(
    await readFile(join(dirname(path), "ingestron.azure.lock.yaml"), "utf8"),
  );
  assert.equal(lock.state, "installed");
  assert.deepEqual(lock.ownedResources, resourceIds);
  assert.deepEqual(lock.directoryObjects, []);
  assert.ok(
    azure.calls.some((call) => call[0] === "acr" && call[1] === "manifest"),
  );
});

test("status and verify reconcile exact inventory and integration outputs", async () => {
  const path = await configuration();
  const azure = fakeAzure();
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  assert.equal((await azureStatus(path, azure.runner)).installed, true);
  const verified = await azureVerify(path, azure.runner);
  assert.equal(verified.valid, true);
  assert.equal(verified.integration?.endpoint, integration.endpoint);
});

test("status fails closed when safe config changes after installation", async () => {
  const path = await configuration();
  const azure = fakeAzure();
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  const config = parse(await readFile(path, "utf8"));
  config.cost.plannedUsd = 2;
  await writeFile(path, stringify(config));
  await assert.rejects(
    () => azureStatus(path, azure.runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONFIG_DRIFT",
  );
});

test("upgrade and rollback retain the last verified bundle", async () => {
  const path = await configuration();
  const azure = fakeAzure();
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  const upgraded = await azureUpgrade(
    path,
    "1.1.1",
    true,
    azure.runner,
    localRunner,
    artifactVerifier,
  );
  assert.equal(upgraded.to, "1.1.1");
  assert.equal(parse(await readFile(path, "utf8")).bundle.version, "1.1.1");
  const rolledBack = await azureRollback(
    path,
    true,
    azure.runner,
    localRunner,
    artifactVerifier,
  );
  assert.equal(rolledBack.to, "1.1.0");
  assert.equal(parse(await readFile(path, "utf8")).bundle.version, "1.1.0");
  assert.equal((await azureVerify(path, azure.runner)).valid, true);
  const lockText = await readFile(
    join(dirname(path), "ingestron.azure.lock.yaml"),
    "utf8",
  );
  assert.doesNotMatch(lockText, /(?:^|\s)[&*][a-zA-Z0-9_-]+/m);
});

test("public namespace bundles upgrade from 1.2.0 and roll back exactly", async () => {
  const path = await configuration("1.2.0");
  const azure = fakeAzure({ workerDigest: namespaceImageDigest });
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  const upgraded = await azureUpgrade(
    path,
    "1.2.1",
    true,
    azure.runner,
    localRunner,
    artifactVerifier,
  );
  assert.equal(upgraded.from, "1.2.0");
  assert.equal(upgraded.to, "1.2.1");
  assert.equal(parse(await readFile(path, "utf8")).bundle.version, "1.2.1");
  const rolledBack = await azureRollback(
    path,
    true,
    azure.runner,
    localRunner,
    artifactVerifier,
  );
  assert.equal(rolledBack.from, "1.2.1");
  assert.equal(rolledBack.to, "1.2.0");
  assert.equal(parse(await readFile(path, "utf8")).bundle.version, "1.2.0");
  assert.equal((await azureVerify(path, azure.runner)).valid, true);
});

test("verified Azure outputs generate the existing customer-managed ADF config", async () => {
  const path = await configuration();
  const azure = fakeAzure();
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  const adfPath = join(dirname(path), "ingestron.adf.yaml");
  await azureAdfConfig(
    path,
    adfPath,
    `/subscriptions/${subscription}/resourceGroups/demo-rg/providers/Microsoft.DataFactory/factories/demo-adf`,
    "test",
    join(dirname(path), "recipe.yaml"),
    azure.runner,
  );
  const adf = parse(await readFile(adfPath, "utf8"));
  assert.equal(adf.profile, "customer-managed");
  assert.equal(adf.integration.endpoint, integration.endpoint);
  assert.equal(adf.integration.audience, integration.audience);
  assert.equal(adf.recipe.path, "recipe.yaml");
});

test("uninstall refuses drift and deletes only the exact owned group", async () => {
  const path = await configuration();
  const azure = fakeAzure();
  await azureInstall(path, true, azure.runner, localRunner, artifactVerifier);
  assert.equal(
    (await azurePlanUninstall(path, azure.runner)).resources.length,
    3,
  );
  const drifted = fakeAzure({ existing: true, drift: true });
  await assert.rejects(
    () => azurePlanUninstall(path, drifted.runner),
    (error: unknown) =>
      error instanceof CliError && error.code === "OWNERSHIP_COLLISION",
  );
  const result = await azureUninstall(path, true, azure.runner);
  assert.equal(result.orphanAudit.passed, true);
  assert.equal((await azureStatus(path, azure.runner)).installed, false);
  assert.equal(
    azure.calls.filter((call) => call[0] === "group" && call[1] === "delete")
      .length,
    1,
  );
});
