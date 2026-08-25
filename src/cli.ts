#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  adfProfiles,
  type AdfProfile,
} from "./adf.js";
import {
  adfConnectionAdd,
  adfConnectionDiscover,
  adfConnectionPlan,
  adfConnectionTest,
} from "./connections.js";
import { CliError } from "./errors.js";
import { asCliError, emit, type OutputMode } from "./io.js";
import { checkContract, validateRecipe, verifyPackage } from "./validate.js";
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
} from "./azure.js";

const forwardedArgs = process.argv.slice(2);
const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
const output: OutputMode =
  args.includes("--output") && args[args.indexOf("--output") + 1] === "json"
    ? "json"
    : "human";
const filtered = args.filter(
  (arg, index) =>
    !(arg === "--output" || args[index - 1] === "--output") &&
    arg !== "--no-colour",
);
const command = filtered.slice(0, 2).join(" ") || "help";
const usage = `Commands: version; recipe validate; contract check; package verify; adf init|migrate|plan|install|status|verify|upgrade|rollback|plan-uninstall|uninstall; adf connection discover|add|plan|test; azure init|plan|install|status|verify|upgrade|rollback|adf-config|plan-uninstall|uninstall. Profiles: ${adfProfiles.join(", ")}`;

const option = (name: string) => {
  const index = filtered.indexOf(name);
  return index >= 0 ? filtered[index + 1] : undefined;
};
const requiredOption = (name: string) => {
  const value = option(name);
  if (!value) throw new CliError("USAGE", `${name} is required`, 2);
  return value;
};
const requiredPath = (index: number, label: string) => {
  const value = filtered[index];
  if (!value) throw new CliError("USAGE", `${label} is required`, 2);
  return value;
};

async function run(): Promise<unknown> {
  if (filtered.includes("--help") || filtered[0] === "help") return { usage };
  if (filtered[0] === "version") {
    const packagePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    return { version: JSON.parse(await readFile(packagePath, "utf8")).version };
  }
  if (filtered[0] === "recipe" && filtered[1] === "validate")
    return validateRecipe(requiredPath(2, "recipe path"));
  if (filtered[0] === "contract" && filtered[1] === "check")
    return checkContract(requiredPath(2, "contract path"));
  if (filtered[0] === "package" && filtered[1] === "verify")
    return verifyPackage(requiredPath(2, "package directory"));
  if (filtered[0] === "adf") {
    if (filtered[1] === "init") {
      const factoryResourceId = option("--factory-resource-id");
      if (!factoryResourceId)
        throw new CliError("USAGE", "--factory-resource-id is required");
      return adfInit(
        option("--config") ?? "ingestron.yaml",
        factoryResourceId,
        option("--name"),
        {
          profile: option("--profile") as AdfProfile | undefined,
          recipePath: option("--recipe"),
          endpoint: option("--endpoint"),
          audience: option("--audience"),
        },
      );
    }
    const config = option("--config");
    if (!config) throw new CliError("USAGE", "--config is required");
    if (filtered[1] === "migrate") {
      const profile = requiredOption("--profile") as AdfProfile;
      return adfMigrate(
        config,
        profile,
        requiredOption("--recipe"),
        filtered.includes("--yes"),
      );
    }
    if (filtered[1] === "connection") {
      switch (filtered[2]) {
        case "discover":
          return adfConnectionDiscover(config);
        case "add": {
          const alias = requiredPath(3, "connection alias");
          const storeInput = requiredOption("--store");
          const store =
            {
              blob: "AzureBlobStorage",
              adls: "AzureBlobFS",
              AzureBlobStorage: "AzureBlobStorage",
              AzureBlobFS: "AzureBlobFS",
            }[storeInput] ?? undefined;
          if (!store)
            throw new CliError("USAGE", "--store must be blob or adls");
          const capability = requiredOption("--capability");
          if (!["read", "write", "read-write"].includes(capability))
            throw new CliError(
              "USAGE",
              "--capability must be read, write or read-write",
            );
          return adfConnectionAdd(config, alias, {
            linkedService: requiredOption("--linked-service"),
            store: store as "AzureBlobStorage" | "AzureBlobFS",
            account: option("--account"),
            namespace: requiredOption("--namespace"),
            capability: capability as "read" | "write" | "read-write",
            replace: filtered.includes("--replace"),
          });
        }
        case "plan":
          return adfConnectionPlan(config);
        case "test":
          return adfConnectionTest(config, requiredPath(3, "connection alias"));
      }
      throw new CliError(
        "USAGE",
        "Commands: adf connection discover|add|plan|test",
      );
    }
    const yes = filtered.includes("--yes");
    switch (filtered[1]) {
      case "plan":
        return adfPlan(config);
      case "install":
        return adfInstall(config, yes);
      case "status":
        return adfStatus(config);
      case "verify":
        return adfVerify(config);
      case "upgrade":
        return adfUpgrade(config, yes);
      case "rollback":
        return adfRollback(config, yes);
      case "plan-uninstall":
        return adfPlanUninstall(config);
      case "uninstall":
        return adfUninstall(config, yes);
    }
  }
  if (filtered[0] === "azure") {
    if (filtered[1] === "init") {
      const plannedUsd = Number(requiredOption("--planned-usd"));
      if (!Number.isFinite(plannedUsd))
        throw new CliError("USAGE", "--planned-usd must be a number", 2);
      return azureInit(option("--config") ?? "ingestron.azure.yaml", {
        name: option("--name"),
        resourceGroupName: requiredOption("--resource-group"),
        location: requiredOption("--location"),
        resourceSuffix: requiredOption("--resource-suffix"),
        deploymentMode: requiredOption("--deployment-mode") as
          | "temporary-proof"
          | "persistent-demo",
        apiIngressMode: requiredOption("--ingress-mode") as
          | "disabled"
          | "entra-public",
        entraApplicationClientId: requiredOption(
          "--entra-application-client-id",
        ),
        allowedClientApplicationIds: [
          requiredOption("--allowed-client-application-id"),
        ],
        pipelineCallerPrincipalId: requiredOption(
          "--pipeline-caller-principal-id",
        ),
        workerImageSource: option("--worker-image-source"),
        jobsFunctionsPackage: option("--jobs-functions-package"),
        plannedUsd,
        bundleVersion: option("--bundle-version"),
        expiresOn: option("--expires-on"),
      });
    }
    const config = option("--config");
    if (!config) throw new CliError("USAGE", "--config is required");
    const yes = filtered.includes("--yes");
    switch (filtered[1]) {
      case "plan":
        return azurePlan(config);
      case "install":
        return azureInstall(config, yes);
      case "status":
        return azureStatus(config);
      case "verify":
        return azureVerify(config);
      case "upgrade":
        return azureUpgrade(config, requiredOption("--to"), yes);
      case "rollback":
        return azureRollback(config, yes);
      case "adf-config":
        return azureAdfConfig(
          config,
          requiredOption("--adf-config"),
          requiredOption("--factory-resource-id"),
          option("--name"),
          option("--recipe"),
        );
      case "plan-uninstall":
        return azurePlanUninstall(config);
      case "uninstall":
        return azureUninstall(config, yes);
    }
  }
  throw new CliError("USAGE", usage);
}

try {
  const result = await run();
  emit(
    { contract: "ingestron.cli-output/v1", ok: true, command, result },
    output,
  );
} catch (error) {
  const cliError = asCliError(error);
  emit(
    {
      contract: "ingestron.cli-output/v1",
      ok: false,
      command,
      error: {
        code: cliError.code,
        message: cliError.message,
        details: cliError.details,
      },
    },
    output,
  );
  process.exitCode = cliError.exitCode;
}
