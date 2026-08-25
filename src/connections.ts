import { lstat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import {
  assertIdentity,
  azRunner,
  readAdfConfig,
  targetParts,
  type AdfConnection,
  type AdfStore,
  type CommandRunner,
  type ConnectionCapability,
} from "./adf.js";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";
import { readRecipe } from "./recipe.js";

export type ConnectionInput = {
  linkedService: string;
  store: AdfStore;
  account?: string;
  namespace: string;
  capability: ConnectionCapability;
  replace?: boolean;
};

const supports = (actual: ConnectionCapability, required: "read" | "write") =>
  actual === required || actual === "read-write";

async function writeConfig(path: string, config: unknown) {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new CliError(
      "CONFIG_UNSAFE",
      "Refusing to update a symbolic, missing or non-regular config",
      5,
    );
  await writeFile(absolute, stringify(config, { lineWidth: 0 }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
}

export async function adfConnectionAdd(
  configPath: string,
  alias: string,
  input: ConnectionInput,
) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(alias))
    throw new CliError("CONFIG_INVALID", "Connection alias is invalid");
  const config = await readAdfConfig(configPath);
  if (config.apiVersion !== "ingestron.cli/v2")
    throw new CliError(
      "CONFIG_MIGRATION_REQUIRED",
      "Connection commands require ingestron.cli/v2; run adf migrate",
    );
  if (config.connections[alias] && !input.replace)
    throw new CliError(
      "CONNECTION_EXISTS",
      `Connection alias already exists: ${alias}`,
    );
  const candidate: AdfConnection = {
    linkedService: input.linkedService,
    store: input.store,
    ...(input.account === undefined ? {} : { account: input.account }),
    namespace: input.namespace,
    capability: input.capability,
  };
  config.connections[alias] = candidate;
  await writeConfig(configPath, config);
  await readAdfConfig(configPath);
  return {
    action: "connection-add",
    alias,
    connection: candidate,
    configPath: resolve(configPath),
    secretsStored: false,
  };
}

function safeLinkedServices(value: unknown) {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.value)
      ? value.value
      : undefined;
  if (!entries)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure returned no linked-service list",
      4,
    );
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string")
      throw new CliError(
        "AZ_OUTPUT_INVALID",
        "Azure returned a malformed linked service",
        4,
      );
    const properties = isRecord(entry.properties) ? entry.properties : {};
    const connectVia = isRecord(properties.connectVia)
      ? String(
          properties.connectVia.referenceName ??
            "AutoResolveIntegrationRuntime",
        )
      : "AutoResolveIntegrationRuntime";
    return {
      name: entry.name,
      type: String(properties.type ?? "unknown"),
      connectVia,
    };
  });
}

export async function adfConnectionDiscover(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  const target = await assertIdentity(config, runner);
  const value = await runner([
    "datafactory",
    "linked-service",
    "list",
    "--subscription",
    target.subscriptionId,
    "--resource-group",
    target.resourceGroup,
    "--factory-name",
    target.factoryName,
    "--output",
    "json",
  ]);
  return {
    action: "connection-discover",
    factory: config.target.factoryResourceId,
    linkedServices: safeLinkedServices(value),
    securePropertiesReturned: false,
  };
}

async function boundConnections(configPath: string) {
  const config = await readAdfConfig(configPath);
  if (!config.recipe)
    throw new CliError(
      "CONFIG_MIGRATION_REQUIRED",
      "A v2 recipe binding is required",
    );
  const recipePath = resolve(dirname(resolve(configPath)), config.recipe.path);
  const recipe = await readRecipe(recipePath);
  const requirements = [
    {
      role: "source",
      alias: recipe.source.connection,
      capability: "read" as const,
    },
    {
      role: "destination",
      alias: recipe.destination.connection,
      capability: "write" as const,
    },
  ];
  const bindings = requirements.map((requirement) => {
    const connection = config.connections[requirement.alias];
    if (!connection)
      throw new CliError(
        "CONNECTION_MISSING",
        `Recipe alias is not configured: ${requirement.alias}`,
      );
    if (!supports(connection.capability, requirement.capability))
      throw new CliError(
        "CONNECTION_CAPABILITY_MISMATCH",
        `${requirement.alias} does not grant ${requirement.capability}`,
      );
    return { ...requirement, ...connection };
  });
  return { config, recipe, recipePath, bindings };
}

export async function adfConnectionPlan(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const { config, recipePath, bindings } = await boundConnections(configPath);
  const discovered = await adfConnectionDiscover(configPath, runner);
  const byName = new Map(
    discovered.linkedServices.map((entry) => [entry.name, entry]),
  );
  for (const binding of bindings) {
    const actual = byName.get(binding.linkedService);
    if (!actual)
      throw new CliError(
        "CONNECTION_NOT_FOUND",
        `ADF linked service was not found: ${binding.linkedService}`,
        4,
      );
    if (actual.type !== binding.store)
      throw new CliError(
        "CONNECTION_TYPE_MISMATCH",
        `${binding.alias} expects ${binding.store}, found ${actual.type}`,
        4,
      );
  }
  return {
    action: "connection-plan",
    profile: config.profile,
    recipePath,
    bindings,
    secretsRequired: false,
  };
}

export async function adfConnectionTest(
  configPath: string,
  alias: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  const connection = config.connections[alias];
  if (!connection)
    throw new CliError(
      "CONNECTION_MISSING",
      `Unknown connection alias: ${alias}`,
    );
  const target = await assertIdentity(config, runner);
  const value = await runner([
    "datafactory",
    "linked-service",
    "show",
    "--subscription",
    target.subscriptionId,
    "--resource-group",
    target.resourceGroup,
    "--factory-name",
    target.factoryName,
    "--name",
    connection.linkedService,
    "--output",
    "json",
  ]);
  if (!isRecord(value) || value.name !== connection.linkedService)
    throw new CliError(
      "CONNECTION_TEST_FAILED",
      "ADF did not return the exact linked-service definition",
      4,
    );
  const properties = isRecord(value.properties) ? value.properties : {};
  if (properties.type !== connection.store)
    throw new CliError(
      "CONNECTION_TYPE_MISMATCH",
      `Expected ${connection.store}, found ${String(properties.type)}`,
      4,
    );
  return {
    action: "connection-test",
    alias,
    linkedService: connection.linkedService,
    definitionReachable: true,
    dataPlaneProbed: false,
    note: "This safe test verifies the exact ADF definition. The install verification run proves data-plane access without returning credentials.",
    securePropertiesReturned: false,
  };
}
