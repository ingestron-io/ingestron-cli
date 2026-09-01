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
import { adfInventoryExport } from "./adf-inventory.js";
import { CliError } from "./errors.js";
import { asCliError, emit, type OutputMode } from "./io.js";
import { checkContract, validateRecipe, verifyPackage } from "./validate.js";
import { runBlueprint } from "./product.js";
import {
  buildGeneration,
  deploymentPlan,
  planGeneration,
  resolveProject,
  verifyGeneration,
} from "./project.js";
import {
  azureAdfConfig,
  azureCreate,
  azureDrop,
  azureInit,
  azureInstall,
  azurePause,
  azurePlan,
  azurePlanLifecycle,
  azurePlanUninstall,
  azureResume,
  azureRollback,
  azureStatus,
  azureUninstall,
  azureUpgrade,
  azureVerify,
  type AzureLifecycleScope,
} from "./azure.js";

const forwardedArgs = process.argv.slice(2);
const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
const output: OutputMode =
  args.includes("--output") && args[args.indexOf("--output") + 1] === "json"
    ? "json"
    : "human";
const requestedLogFormat =
  args.includes("--log-format") && args[args.indexOf("--log-format") + 1]
    ? args[args.indexOf("--log-format") + 1]
    : process.env.INGESTRON_CLI_LOG_FORMAT;
const logFormat =
  requestedLogFormat === "ndjson" ||
  requestedLogFormat === "pretty" ||
  requestedLogFormat === "quiet"
    ? requestedLogFormat
    : process.stderr.isTTY && output === "human"
      ? "pretty"
      : "quiet";
const filtered = args.filter(
  (arg, index) =>
    !(arg === "--output" || args[index - 1] === "--output") &&
    !(arg === "--log-format" || args[index - 1] === "--log-format") &&
    arg !== "--no-colour",
);
const command = filtered.slice(0, 2).join(" ") || "help";
const docsUrl = "https://docs.ingestron.io/docs/deployment/cli-reference";
const usage = `Commands: version; recipe validate; contract check; package verify; project validate|resolve; gen plan|build|verify; deploy plan; product import|requirements|resolve|plan|diff|approve|export-odcs|generate|verify; adf init|migrate|plan|install|status|verify|upgrade|rollback|plan-uninstall|uninstall; adf connection discover|add|plan|test; adf inventory export; azure init|plan|install|create|status|verify|plan-pause|pause|plan-resume|resume|upgrade|rollback|adf-config|plan-uninstall|uninstall|drop. Profiles: ${adfProfiles.join(", ")}. Docs: ${docsUrl}`;
const azureInitUsage =
  "ingestron azure init --subscription <subscription-id> --resource-group <name> --location <region> --resource-suffix <suffix> --deployment-mode <temporary-proof|persistent-demo> --ingress-mode <disabled|entra-public> --entra-application-client-id <id> --allowed-client-application-id <id> --pipeline-caller-principal-id <id> --planned-usd <amount> [--config <path>] [--name <name>] [--expires-on <date>]. Docs: " +
  docsUrl;

type ProgressLevel = "info" | "success" | "error";

function progress(
  phase: string,
  message: string,
  level: ProgressLevel = "info",
  data?: Record<string, unknown>,
): void {
  if (logFormat === "quiet") return;
  const event = {
    contract: "ingestron.cli-event/v1",
    timestamp: new Date().toISOString(),
    command,
    phase,
    level,
    message,
    ...(data ? { data } : {}),
  };
  if (logFormat === "ndjson") {
    process.stderr.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const colour =
    level === "success"
      ? "\u001b[32m"
      : level === "error"
        ? "\u001b[31m"
        : "\u001b[36m";
  const mark = level === "success" ? "✓" : level === "error" ? "✕" : "◆";
  process.stderr.write(`${colour}${mark}\u001b[0m ${message}\n`);
}

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
const requireCompleteAzureScope = () => {
  const scope = option("--scope");
  if (scope && scope !== "all")
    throw new CliError(
      "PARTIAL_LIFECYCLE_UNSUPPORTED",
      "Azure create and drop support only --scope all; use pause for cost-bearing compute",
      2,
    );
};
const declaredInputs = (): Record<string, string> => {
  const values: Record<string, string> = {};
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] !== "--set") continue;
    const assignment = filtered[index + 1];
    if (!assignment || !assignment.includes("="))
      throw new CliError("USAGE", "--set must be name=value", 2);
    const separator = assignment.indexOf("=");
    const name = assignment.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
      throw new CliError("USAGE", "--set input name is invalid", 2);
    if (Object.hasOwn(values, name))
      throw new CliError(
        "USAGE",
        `--set ${name} was provided more than once`,
        2,
      );
    values[name] = assignment.slice(separator + 1);
  }
  return values;
};

async function run(): Promise<unknown> {
  if (filtered.includes("--help") || filtered[0] === "help")
    return {
      usage:
        filtered[0] === "azure" && filtered[1] === "init"
          ? azureInitUsage
          : usage,
    };
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
  if (filtered[0] === "project") {
    const base = requiredPath(2, "contract-base path");
    const environment = requiredOption("--environment");
    progress("project.resolve", `Resolving contract base for ${environment}`);
    const resolution = await resolveProject(
      base,
      environment,
      declaredInputs(),
    );
    progress(
      "project.resolve",
      `Resolved ${Object.keys(resolution.contracts).length} contracts`,
      "success",
      {
        environment,
        digest: resolution.digest,
        products: Object.keys(resolution.products).length,
        contracts: Object.keys(resolution.contracts).length,
      },
    );
    if (filtered[1] === "resolve") return resolution;
    if (filtered[1] === "validate")
      return {
        contract: "ingestron.project-validation/v1",
        valid: !resolution.findings.some(
          (finding) => finding.severity === "error",
        ),
        project: resolution.project,
        environment: resolution.environment,
        digest: resolution.digest,
        products: Object.keys(resolution.products).length,
        contracts: Object.keys(resolution.contracts).length,
        generators: Object.keys(resolution.generators).length,
        findings: resolution.findings,
      };
    throw new CliError("USAGE", "Commands: project validate|resolve", 2);
  }
  if (filtered[0] === "gen") {
    if (filtered[1] === "verify") {
      const path = requiredPath(2, "output path");
      progress("generation.verify", "Verifying generated files and digests");
      const result = await verifyGeneration(path);
      progress("generation.verify", "Generated output verified", "success");
      return result;
    }
    const base = requiredPath(2, "contract-base path");
    const environment = requiredOption("--environment");
    const generator = requiredOption("--generator");
    if (filtered[1] === "plan") {
      progress(
        "generation.plan",
        `Planning ${generator} assets for ${environment}`,
      );
      const result = await planGeneration(
        base,
        environment,
        generator,
        declaredInputs(),
      );
      progress(
        "generation.plan",
        `Planned ${result.assets.length} ${generator} assets`,
        "success",
        {
          planDigest: result.planDigest,
        },
      );
      return result;
    }
    if (filtered[1] === "build") {
      progress(
        "generation.build",
        `Building deterministic ${generator} source`,
      );
      const result = await buildGeneration(
        base,
        environment,
        generator,
        requiredOption("--out"),
        declaredInputs(),
      );
      progress("generation.build", `${generator} source built`, "success", {
        files: Array.isArray(result.files) ? result.files.length : undefined,
        planDigest: result.planDigest,
      });
      return result;
    }
    throw new CliError("USAGE", "Commands: gen plan|build|verify", 2);
  }
  if (filtered[0] === "deploy" && filtered[1] === "plan")
    return deploymentPlan(
      requiredPath(2, "contract-base path"),
      requiredOption("--environment"),
      requiredOption("--generator"),
      declaredInputs(),
    );
  if (filtered[0] === "product") {
    const mapped =
      filtered[1] === "import"
        ? "import-inventory"
        : filtered[1] === "requirements"
          ? "extract-requirements"
          : filtered[1] === "resolve"
            ? "resolve-requirements"
            : (filtered[1] ?? "");
    return runBlueprint(mapped, filtered.slice(2));
  }
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
    if (filtered[1] === "inventory") {
      if (filtered[2] !== "export")
        throw new CliError("USAGE", "Commands: adf inventory export");
      return adfInventoryExport(
        config,
        requiredOption("--product"),
        option("--domain") ?? "default",
        requiredOption("--out"),
      );
    }
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
        subscriptionId: requiredOption("--subscription"),
        resourceGroupName: requiredOption("--resource-group"),
        location: requiredOption("--location"),
        resourceSuffix: requiredOption("--resource-suffix"),
        deploymentMode: requiredOption("--deployment-mode") as
          "temporary-proof" | "persistent-demo",
        apiIngressMode: requiredOption("--ingress-mode") as
          "disabled" | "entra-public",
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
    const lifecycleScope = (option("--scope") ??
      "cost-bearing") as AzureLifecycleScope;
    switch (filtered[1]) {
      case "plan":
        return azurePlan(config);
      case "install":
        return azureInstall(config, yes);
      case "create":
        requireCompleteAzureScope();
        return azureCreate(config, yes);
      case "status":
        return azureStatus(config);
      case "verify":
        return azureVerify(config);
      case "plan-pause":
        return azurePlanLifecycle(config, "pause", lifecycleScope);
      case "pause":
        return azurePause(config, lifecycleScope, yes);
      case "plan-resume":
        return azurePlanLifecycle(config, "resume", lifecycleScope);
      case "resume":
        return azureResume(config, lifecycleScope, yes);
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
      case "drop":
        requireCompleteAzureScope();
        return azureDrop(config, yes);
    }
  }
  throw new CliError("USAGE", usage);
}

try {
  progress("command.start", `ingestron ${command}`);
  const result = await run();
  progress("command.complete", `ingestron ${command} completed`, "success");
  emit(
    { contract: "ingestron.cli-output/v1", ok: true, command, result },
    output,
  );
} catch (error) {
  const cliError = asCliError(error);
  progress("command.failed", cliError.message, "error", {
    code: cliError.code,
  });
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
