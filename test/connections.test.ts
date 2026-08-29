import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { adfPlan, type AdfProfile, type CommandRunner } from "../src/adf.js";
import {
  adfConnectionAdd,
  adfConnectionDiscover,
  adfConnectionPlan,
  adfConnectionTest,
} from "../src/connections.js";
import { CliError } from "../src/errors.js";

const subscription = "11111111-1111-1111-1111-111111111111";
const factoryId = `/subscriptions/${subscription}/resourceGroups/demo-rg/providers/Microsoft.DataFactory/factories/demo-adf`;

async function fixture(profile: AdfProfile = "hosted-transient") {
  const directory = await mkdtemp(join(tmpdir(), "ingestron-connections-"));
  const configPath = join(directory, "ingestron.yaml");
  const manifestBytes = await readFile(
    new URL("../bundles/adf/2.0.4/manifest.json", import.meta.url),
  );
  const bundleDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  await writeFile(
    join(directory, "recipe.yaml"),
    "outcome: workbook.to-governed-dataset\nsource:\n  connection: finance\n  path: monthly/close.xlsx\ndestination:\n  connection: governed\n  path: monthly/close/\n",
  );
  await writeFile(
    configPath,
    stringify({
      apiVersion: "ingestron.cli/v2",
      kind: "AdfInstallation",
      metadata: { name: "demo-install" },
      target: { factoryResourceId: factoryId },
      profile,
      recipe: { path: "recipe.yaml" },
      connections: {},
      integration: {
        endpoint:
          profile === "customer-managed"
            ? "https://customer.example.invalid"
            : "https://api.ingestron.io",
        audience: "api://22222222-2222-2222-2222-222222222222",
        pipelineName: `demo_${profile.replaceAll("-", "_")}_v1`,
      },
      bundle: { version: "2.0.4", digest: bundleDigest },
    }),
  );
  return { directory, configPath };
}

function azure() {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    if (args[0] === "account") return { id: subscription };
    if (args.includes("list"))
      return [
        {
          name: "finance-ls",
          properties: {
            type: "AzureBlobStorage",
            typeProperties: { accountKey: "must-not-leave-azure-output" },
          },
        },
        {
          name: "governed-ls",
          properties: {
            type: "AzureBlobFS",
            connectVia: { referenceName: "managed-ir" },
            typeProperties: { servicePrincipalKey: "must-not-leave-output" },
          },
        },
      ];
    if (args.includes("show")) {
      const name = args[args.indexOf("--name") + 1];
      return {
        name,
        properties: {
          type: name === "finance-ls" ? "AzureBlobStorage" : "AzureBlobFS",
          typeProperties: { credential: "must-not-leave-output" },
        },
      };
    }
    if (args.includes("what-if")) {
      const pipeline = args.find((arg) => arg.startsWith("pipelineName="))!;
      return {
        changes: [
          {
            changeType: "Create",
            resourceId: `${factoryId}/pipelines/${pipeline.slice("pipelineName=".length)}`,
          },
        ],
      };
    }
    return {};
  };
  return { calls, runner };
}

async function addBindings(configPath: string) {
  await adfConnectionAdd(configPath, "finance", {
    linkedService: "finance-ls",
    store: "AzureBlobStorage",
    account: "demostore",
    namespace: "source",
    capability: "read",
  });
  await adfConnectionAdd(configPath, "governed", {
    linkedService: "governed-ls",
    store: "AzureBlobFS",
    account: "demostore",
    namespace: "governed",
    capability: "write",
  });
}

test("guided connection workflow returns safe metadata only", async () => {
  const { configPath } = await fixture();
  await addBindings(configPath);
  const fake = azure();
  const discovered = await adfConnectionDiscover(configPath, fake.runner);
  assert.deepEqual(discovered.linkedServices, [
    {
      name: "finance-ls",
      type: "AzureBlobStorage",
      connectVia: "AutoResolveIntegrationRuntime",
    },
    { name: "governed-ls", type: "AzureBlobFS", connectVia: "managed-ir" },
  ]);
  assert.doesNotMatch(JSON.stringify(discovered), /key|credential|secret/i);
  const plan = await adfConnectionPlan(configPath, fake.runner);
  assert.equal(plan.bindings.length, 2);
  assert.equal(plan.secretsRequired, false);
  const tested = await adfConnectionTest(configPath, "finance", fake.runner);
  assert.equal(tested.definitionReachable, true);
  assert.equal(tested.dataPlaneProbed, false);
  assert.doesNotMatch(JSON.stringify(tested), /must-not-leave/);
});

test("connection add refuses replacement and capability escalation", async () => {
  const { configPath } = await fixture();
  await adfConnectionAdd(configPath, "finance", {
    linkedService: "finance-ls",
    store: "AzureBlobStorage",
    namespace: "source",
    capability: "write",
  });
  await assert.rejects(
    () =>
      adfConnectionAdd(configPath, "finance", {
        linkedService: "other",
        store: "AzureBlobStorage",
        namespace: "source",
        capability: "read",
      }),
    (error: unknown) =>
      error instanceof CliError && error.code === "CONNECTION_EXISTS",
  );
  await adfConnectionAdd(configPath, "governed", {
    linkedService: "governed-ls",
    store: "AzureBlobFS",
    namespace: "governed",
    capability: "write",
  });
  await assert.rejects(
    () => adfConnectionPlan(configPath, azure().runner),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "CONNECTION_CAPABILITY_MISMATCH",
  );
});

test("one unchanged recipe plans through all three profile bundles", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { configPath } = await fixture(profile);
    await addBindings(configPath);
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.profile, profile);
    assert.deepEqual(plan.recipe?.source, {
      connection: "finance",
      path: "monthly/close.xlsx",
    });
    assert.equal(
      plan.ownedResources.length,
      profile === "hosted-transient" ? 5 : 1,
    );
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    const joined = whatIf.join("\n");
    assert.doesNotMatch(joined, /idempotencyKey|expectedDigest|recipeVersion/);
    if (profile === "hosted-transient") {
      assert.match(joined, /sourceLinkedService=finance-ls/);
      assert.match(joined, /sourceDatasetName=demo_install_ingestron_source/);
      assert.doesNotMatch(joined, /sourceDatasetName=demo-install/);
      assert.doesNotMatch(joined, /recipeYaml=/);
    } else {
      assert.match(
        joined,
        /recipeYamlPrefix=outcome: workbook.to-governed-dataset/,
      );
      assert.match(joined, /recipeYamlSuffix=/);
      assert.doesNotMatch(joined, /recipeYaml=/);
      assert.match(joined, /sourceConnectionYaml=connection: finance/);
      assert.doesNotMatch(joined, /accountKey|password|token|secret/i);
    }
  }
});

test("landing batch recipe plans only through customer-managed Azure", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { directory, configPath } = await fixture(profile);
    await writeFile(
      join(directory, "recipe.yaml"),
      "outcome: landing.batch-contract-gate\nsource:\n  connection: finance\n  path: daily/landing-batch.yaml\ndestination:\n  connection: governed\n  path: quality/daily/\n",
    );
    await addBindings(configPath);
    if (profile !== "customer-managed") {
      await assert.rejects(
        () => adfPlan(configPath, azure().runner),
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "RECIPE_PROFILE_UNSUPPORTED",
      );
      continue;
    }
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.recipe?.outcome, "landing.batch-contract-gate");
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    assert.match(
      whatIf.join("\n"),
      /recipeYamlPrefix=outcome: landing.batch-contract-gate/,
    );
  }
});

test("copy reconciliation recipe plans only through customer-managed Azure", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { directory, configPath } = await fixture(profile);
    await writeFile(
      join(directory, "recipe.yaml"),
      "outcome: copy.batch-reconciliation-gate\nsource:\n  connection: finance\n  path: daily/copy-controls.yaml\ndestination:\n  connection: governed\n  path: reconciliation/daily/\n",
    );
    await addBindings(configPath);
    if (profile !== "customer-managed") {
      await assert.rejects(
        () => adfPlan(configPath, azure().runner),
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "RECIPE_PROFILE_UNSUPPORTED",
      );
      continue;
    }
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.recipe?.outcome, "copy.batch-reconciliation-gate");
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    assert.match(
      whatIf.join("\n"),
      /recipeYamlPrefix=outcome: copy.batch-reconciliation-gate/,
    );
    assert.match(whatIf.join("\n"), /sourcePath=daily\/copy-controls.yaml/);
    assert.match(whatIf.join("\n"), /recipeYamlMiddle=/);
  }
});

test("schema baseline recipe plans only through customer-managed Azure", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { directory, configPath } = await fixture(profile);
    await writeFile(
      join(directory, "recipe.yaml"),
      "outcome: schema.baseline-compatibility-gate\nsource:\n  connection: finance\n  path: contracts/orders/schema-baseline.yaml\ndestination:\n  connection: governed\n  path: decisions/schema/orders/\n",
    );
    await addBindings(configPath);
    if (profile !== "customer-managed") {
      await assert.rejects(
        () => adfPlan(configPath, azure().runner),
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "RECIPE_PROFILE_UNSUPPORTED",
      );
      continue;
    }
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.recipe?.outcome, "schema.baseline-compatibility-gate");
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    assert.match(
      whatIf.join("\n"),
      /recipeYamlPrefix=outcome: schema.baseline-compatibility-gate/,
    );
    assert.match(
      whatIf.join("\n"),
      /sourcePath=contracts\/orders\/schema-baseline.yaml/,
    );
  }
});

test("dataset quality recipe plans only through customer-managed Azure", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { directory, configPath } = await fixture(profile);
    await writeFile(
      join(directory, "recipe.yaml"),
      "outcome: dataset.quality-policy-gate\nsource:\n  connection: finance\n  path: controls/orders/dataset-quality.yaml\ndestination:\n  connection: governed\n  path: decisions/quality/orders/\n",
    );
    await addBindings(configPath);
    if (profile !== "customer-managed") {
      await assert.rejects(
        () => adfPlan(configPath, azure().runner),
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "RECIPE_PROFILE_UNSUPPORTED",
      );
      continue;
    }
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.recipe?.outcome, "dataset.quality-policy-gate");
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    assert.match(
      whatIf.join("\n"),
      /recipeYamlPrefix=outcome: dataset.quality-policy-gate/,
    );
    assert.match(
      whatIf.join("\n"),
      /sourcePath=controls\/orders\/dataset-quality.yaml/,
    );
  }
});

test("reference integrity recipe plans only through customer-managed Azure", async () => {
  for (const profile of [
    "hosted-transient",
    "hosted-registered-storage",
    "customer-managed",
  ] as const) {
    const { directory, configPath } = await fixture(profile);
    await writeFile(
      join(directory, "recipe.yaml"),
      "outcome: dataset.reference-integrity-gate\nsource:\n  connection: finance\n  path: controls/orders/reference-integrity.yaml\ndestination:\n  connection: governed\n  path: decisions/reference-integrity/orders/\n",
    );
    await addBindings(configPath);
    if (profile !== "customer-managed") {
      await assert.rejects(
        () => adfPlan(configPath, azure().runner),
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "RECIPE_PROFILE_UNSUPPORTED",
      );
      continue;
    }
    const fake = azure();
    const plan = await adfPlan(configPath, fake.runner);
    assert.equal(plan.recipe?.outcome, "dataset.reference-integrity-gate");
    const whatIf = fake.calls.find((call) => call.includes("what-if"))!;
    assert.match(
      whatIf.join("\n"),
      /recipeYamlPrefix=outcome: dataset.reference-integrity-gate/,
    );
    assert.match(
      whatIf.join("\n"),
      /sourcePath=controls\/orders\/reference-integrity.yaml/,
    );
  }
});

test("written connection config contains aliases but no credentials", async () => {
  const { configPath } = await fixture();
  await addBindings(configPath);
  const value = parse(await readFile(configPath, "utf8"));
  assert.equal(value.connections.finance.linkedService, "finance-ls");
  assert.doesNotMatch(
    await readFile(configPath, "utf8"),
    /password|token|secret/i,
  );
});
