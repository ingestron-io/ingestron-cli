import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lstat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { CliError, redact } from "./errors.js";
import { isRecord, readSafeFile, readYaml } from "./files.js";
import {
  assertRecipeProfile,
  readRecipe,
  serialiseJobIntent,
  serialiseRecipe,
  type Recipe,
} from "./recipe.js";

export const adfProfiles = [
  "hosted-transient",
  "hosted-registered-storage",
  "customer-managed",
] as const;
export type AdfProfile = (typeof adfProfiles)[number];
export type ConnectionCapability = "read" | "write" | "read-write";
export type AdfStore = "AzureBlobStorage" | "AzureBlobFS";
export type AdfConnection = {
  linkedService: string;
  store: AdfStore;
  account?: string;
  namespace: string;
  capability: ConnectionCapability;
};

export type AdfConfig = {
  apiVersion: "ingestron.cli/v1" | "ingestron.cli/v2";
  kind: "AdfInstallation";
  metadata: { name: string };
  target: { factoryResourceId: string };
  profile: AdfProfile;
  recipe?: { path: string };
  connections: Record<string, AdfConnection>;
  integration: { endpoint: string; audience: string; pipelineName: string };
  bundle: { version: string; digest?: string };
};

export type CommandRunner = (args: string[]) => Promise<unknown>;

const factoryPattern =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DataFactory\/factories\/([^/]+)$/i;
const bundleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../bundles/adf",
);
const hostedDefaults = {
  endpoint: "https://api.ingestron.io",
  audience: "api://b7144c86-df2a-4e24-a1fa-8b6d995a95d2",
  pipelineName: "ingestron_hosted_job_v1",
  bundleVersion: "2.1.0",
};

export type AdfInitOptions = {
  profile?: AdfProfile;
  recipePath?: string;
  endpoint?: string;
  audience?: string;
};

export async function adfInit(
  outputPath: string,
  factoryResourceId: string,
  name = "ingestron",
  options: AdfInitOptions = {},
) {
  if (!factoryPattern.test(factoryResourceId))
    throw new CliError(
      "CONFIG_INVALID",
      "--factory-resource-id must be an exact Data Factory resource ID",
    );
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new CliError("CONFIG_INVALID", "--name must be a safe identifier");
  const profile = options.profile ?? "hosted-transient";
  if (!adfProfiles.includes(profile))
    throw new CliError("CONFIG_INVALID", "--profile is unsupported");
  if (
    profile === "customer-managed" &&
    (!options.endpoint || !options.audience)
  )
    throw new CliError(
      "CONFIG_INVALID",
      "customer-managed init requires --endpoint and --audience",
    );
  const endpoint = options.endpoint ?? hostedDefaults.endpoint;
  const audience = options.audience ?? hostedDefaults.audience;
  if (!isSafeEndpoint(endpoint) || !/^api:\/\/[0-9a-f-]{36}$/i.test(audience))
    throw new CliError(
      "CONFIG_INVALID",
      "endpoint and audience must be safe HTTPS/Entra values",
    );
  const draft: AdfConfig = {
    apiVersion: "ingestron.cli/v2",
    kind: "AdfInstallation",
    metadata: { name },
    target: { factoryResourceId },
    profile,
    recipe: { path: options.recipePath ?? "recipe.yaml" },
    connections: {},
    integration: {
      endpoint,
      audience,
      pipelineName: `${name}_${profile.replaceAll("-", "_")}_v1`,
    },
    bundle: { version: hostedDefaults.bundleVersion },
  };
  const bundle = await loadBundle(draft);
  draft.bundle.digest = bundle.manifestDigest;
  const absolute = resolve(outputPath);
  try {
    await writeFile(absolute, stringify(draft), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST")
      throw new CliError("FILE_EXISTS", `Refusing to overwrite: ${absolute}`);
    throw error;
  }
  return {
    action: "init",
    configPath: absolute,
    profile,
    endpoint,
    next: [
      `ingestron adf connection discover --config ${absolute}`,
      `ingestron adf connection add <alias> --config ${absolute} ...`,
    ],
    bundle: draft.bundle,
  };
}

export async function adfMigrate(
  configPath: string,
  profile: AdfProfile,
  recipePath: string,
  yes: boolean,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Migration requires --yes after reviewing the v1-to-v2 changes",
      3,
    );
  if (!adfProfiles.includes(profile))
    throw new CliError("CONFIG_INVALID", "--profile is unsupported");
  const current = await readAdfConfig(configPath);
  if (current.apiVersion !== "ingestron.cli/v1")
    throw new CliError(
      "CONFIG_MIGRATION_UNNECESSARY",
      "Only ingestron.cli/v1 configurations can be migrated",
    );
  const migrated: AdfConfig = {
    ...current,
    apiVersion: "ingestron.cli/v2",
    profile,
    recipe: { path: recipePath },
    connections: {},
    bundle: { version: hostedDefaults.bundleVersion },
  };
  const bundle = await loadBundle(migrated);
  migrated.bundle.digest = bundle.manifestDigest;
  const absolute = resolve(configPath);
  const backupPath = `${absolute}.v1.bak`;
  const original = await readSafeFile(absolute);
  try {
    await writeFile(backupPath, original, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST")
      throw new CliError(
        "FILE_EXISTS",
        `Refusing to overwrite migration backup: ${backupPath}`,
      );
    throw error;
  }
  await writeFile(absolute, stringify(migrated, { lineWidth: 0 }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  return {
    action: "migrate",
    from: "ingestron.cli/v1",
    to: "ingestron.cli/v2",
    profile,
    configPath: absolute,
    backupPath,
    next: "Discover and add the source/destination connection aliases before planning the upgrade.",
  };
}

export async function readAdfConfig(path: string): Promise<AdfConfig> {
  const value = await readYaml(path);
  if (
    !isRecord(value) ||
    !["ingestron.cli/v1", "ingestron.cli/v2"].includes(
      String(value.apiVersion),
    ) ||
    value.kind !== "AdfInstallation"
  )
    throw new CliError(
      "CONFIG_UNSUPPORTED",
      "Expected ingestron.cli/v1 or ingestron.cli/v2 AdfInstallation",
    );
  const isV2 = value.apiVersion === "ingestron.cli/v2";
  assertOnlyKeys(value, [
    "apiVersion",
    "kind",
    "metadata",
    "target",
    ...(isV2 ? ["profile", "recipe", "connections"] : []),
    "integration",
    "bundle",
  ]);
  const metadata = value.metadata;
  const target = value.target;
  const integration = value.integration;
  const bundle = value.bundle;
  const recipe = value.recipe;
  const connections = value.connections;
  if (isRecord(metadata)) assertOnlyKeys(metadata, ["name"]);
  if (isRecord(target)) assertOnlyKeys(target, ["factoryResourceId"]);
  if (isRecord(integration))
    assertOnlyKeys(integration, ["endpoint", "audience", "pipelineName"]);
  if (isRecord(bundle)) assertOnlyKeys(bundle, ["version", "digest"]);
  if (isV2 && isRecord(recipe)) assertOnlyKeys(recipe, ["path"]);
  if (
    !isRecord(metadata) ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(String(metadata.name ?? ""))
  )
    throw new CliError(
      "CONFIG_INVALID",
      "metadata.name must be a safe identifier",
    );
  if (
    !isRecord(target) ||
    !factoryPattern.test(String(target.factoryResourceId ?? ""))
  )
    throw new CliError(
      "CONFIG_INVALID",
      "target.factoryResourceId must be an exact Data Factory resource ID",
    );
  if (!isRecord(integration) || !isSafeEndpoint(integration.endpoint))
    throw new CliError(
      "CONFIG_INVALID",
      "integration.endpoint must be an HTTPS origin/path without query credentials",
    );
  if (!/^api:\/\/[0-9a-f-]{36}$/i.test(String(integration.audience ?? "")))
    throw new CliError(
      "CONFIG_INVALID",
      "integration.audience must be an Entra api:// application ID",
    );
  if (
    !/^[A-Za-z][A-Za-z0-9_-]{0,126}$/.test(
      String(integration.pipelineName ?? ""),
    )
  )
    throw new CliError("CONFIG_INVALID", "integration.pipelineName is invalid");
  if (
    !isRecord(bundle) ||
    !/^\d+\.\d+\.\d+$/.test(String(bundle.version ?? ""))
  )
    throw new CliError(
      "CONFIG_INVALID",
      "bundle.version must be an exact semantic version",
    );
  if (
    bundle.digest !== undefined &&
    !/^sha256:[a-f0-9]{64}$/.test(String(bundle.digest))
  )
    throw new CliError(
      "CONFIG_INVALID",
      "bundle.digest must be sha256:<64 lowercase hex>",
    );
  if (isV2 && bundle.digest === undefined)
    throw new CliError(
      "CONFIG_INVALID",
      "ingestron.cli/v2 requires an immutable bundle.digest",
    );
  if (!isV2) {
    return {
      ...(value as unknown as Omit<AdfConfig, "profile" | "connections">),
      profile: "hosted-registered-storage",
      connections: {},
    };
  }
  if (!adfProfiles.includes(value.profile as AdfProfile))
    throw new CliError("CONFIG_INVALID", "profile is unsupported");
  if (
    !isRecord(recipe) ||
    typeof recipe.path !== "string" ||
    !isSafeRelativePath(recipe.path)
  )
    throw new CliError(
      "CONFIG_INVALID",
      "recipe.path must be a safe relative path",
    );
  if (!isRecord(connections))
    throw new CliError("CONFIG_INVALID", "connections must be an object");
  const parsedConnections: Record<string, AdfConnection> = {};
  for (const [alias, connection] of Object.entries(connections)) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(alias) || !isRecord(connection))
      throw new CliError(
        "CONFIG_INVALID",
        `Invalid connection alias: ${alias}`,
      );
    assertOnlyKeys(connection, [
      "linkedService",
      "store",
      "account",
      "namespace",
      "capability",
    ]);
    const linkedService = String(connection.linkedService ?? "");
    const store = String(connection.store ?? "");
    const account =
      connection.account === undefined ? undefined : String(connection.account);
    const namespace = String(connection.namespace ?? "");
    const capability = String(connection.capability ?? "");
    if (!/^[A-Za-z0-9_][A-Za-z0-9 _-]{0,126}$/.test(linkedService))
      throw new CliError("CONFIG_INVALID", `${alias}.linkedService is invalid`);
    if (!["AzureBlobStorage", "AzureBlobFS"].includes(store))
      throw new CliError("CONFIG_INVALID", `${alias}.store is unsupported`);
    if (account !== undefined && !/^[a-z0-9]{3,24}$/.test(account))
      throw new CliError("CONFIG_INVALID", `${alias}.account is invalid`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace))
      throw new CliError("CONFIG_INVALID", `${alias}.namespace is invalid`);
    if (!["read", "write", "read-write"].includes(capability))
      throw new CliError("CONFIG_INVALID", `${alias}.capability is invalid`);
    parsedConnections[alias] = {
      linkedService,
      store: store as AdfStore,
      ...(account === undefined ? {} : { account }),
      namespace,
      capability: capability as ConnectionCapability,
    };
  }
  return {
    ...(value as unknown as AdfConfig),
    connections: parsedConnections,
  };
}

function isSafeRelativePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((part) => !part || part === "..")
  );
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected)
    throw new CliError(
      "CONFIG_INVALID",
      `Unsupported configuration field: ${unexpected}`,
    );
}

function isSafeEndpoint(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export const targetParts = (config: AdfConfig) => {
  const match = factoryPattern.exec(config.target.factoryResourceId);
  if (!match)
    throw new CliError("CONFIG_INVALID", "Invalid factory resource ID");
  return {
    subscriptionId: match[1]!,
    resourceGroup: match[2]!,
    factoryName: match[3]!,
  };
};

export const azRunner: CommandRunner = (args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.INGESTRON_AZ_PATH ?? "az", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", () =>
      reject(new CliError("AZ_NOT_AVAILABLE", "Azure CLI is not available", 4)),
    );
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new CliError(
            "AZ_COMMAND_FAILED",
            redact(stderr || "Azure CLI command failed"),
            4,
          ),
        );
      try {
        resolvePromise(stdout.trim() ? JSON.parse(stdout) : {});
      } catch {
        reject(
          new CliError(
            "AZ_OUTPUT_INVALID",
            "Azure CLI returned malformed JSON",
            4,
          ),
        );
      }
    });
  });

async function loadBundle(config: AdfConfig) {
  const directory = resolve(bundleRoot, config.bundle.version);
  const relativeDirectory = relative(bundleRoot, directory);
  if (
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    relativeDirectory === ""
  )
    throw new CliError("BUNDLE_UNSUPPORTED", "Unsafe bundle version");
  const manifestBytes = await readSafeFile(resolve(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (
    !isRecord(manifest) ||
    manifest.contract !== "ingestron.adf-bundle/v1" ||
    manifest.version !== config.bundle.version
  )
    throw new CliError("BUNDLE_INVALID", "Bundle manifest is incompatible");
  const profileTemplates = isRecord(manifest.profiles)
    ? manifest.profiles
    : undefined;
  const selected = profileTemplates
    ? profileTemplates[config.profile]
    : {
        template: manifest.template,
        templateDigest: manifest.templateDigest,
      };
  if (
    !isRecord(selected) ||
    typeof selected.template !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(String(selected.templateDigest))
  )
    throw new CliError(
      "BUNDLE_PROFILE_UNSUPPORTED",
      `Bundle ${config.bundle.version} does not support ${config.profile}`,
    );
  const templateBytes = await readSafeFile(
    resolve(directory, selected.template),
    4 * 1024 * 1024,
  );
  const actual = `sha256:${createHash("sha256").update(templateBytes).digest("hex")}`;
  if (selected.templateDigest !== actual)
    throw new CliError(
      "BUNDLE_TAMPERED",
      "ADF template digest does not match its manifest",
      5,
    );
  const manifestDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  if (config.bundle.digest && config.bundle.digest !== manifestDigest)
    throw new CliError(
      "BUNDLE_TAMPERED",
      "Pinned bundle manifest digest does not match",
      5,
    );
  return {
    directory,
    manifest,
    manifestDigest,
    templatePath: resolve(directory, selected.template),
  };
}

export async function assertIdentity(config: AdfConfig, runner: CommandRunner) {
  const target = targetParts(config);
  const account = await runner(["account", "show", "--output", "json"]);
  if (
    !isRecord(account) ||
    String(account.id).toLowerCase() !== target.subscriptionId.toLowerCase()
  )
    throw new CliError(
      "AZ_SUBSCRIPTION_MISMATCH",
      "Active Azure subscription does not match the exact factory target",
      4,
    );
  return target;
}

const deploymentArgs = (
  verb: "what-if" | "create",
  config: AdfConfig,
  templatePath: string,
  recipe?: Recipe,
) => {
  const target = targetParts(config);
  const args = [
    "deployment",
    "group",
    verb,
    "--subscription",
    target.subscriptionId,
    "--resource-group",
    target.resourceGroup,
    "--name",
    `ingestron-cli-${config.metadata.name}`,
    "--template-file",
    templatePath,
    "--parameters",
    `factoryName=${target.factoryName}`,
    `pipelineName=${config.integration.pipelineName}`,
    `endpoint=${config.integration.endpoint.replace(/\/$/, "")}`,
    `audience=${config.integration.audience}`,
  ];
  if (recipe && config.profile !== "hosted-transient") {
    const runtimeIntent = serialiseRuntimeJobIntent(recipe);
    args.push(
      `recipeYamlPrefix=${runtimeIntent.prefix}`,
      `recipeYamlSuffix=${runtimeIntent.suffix}`,
      `sourceConnectionYaml=${serialiseConnectionRegistration(recipe.source.connection, config.connections[recipe.source.connection]!)}`,
      `destinationConnectionYaml=${serialiseConnectionRegistration(recipe.destination.connection, config.connections[recipe.destination.connection]!)}`,
    );
  }
  if (config.profile === "hosted-transient") {
    if (!recipe)
      throw new CliError(
        "CONFIG_MIGRATION_REQUIRED",
        "Hosted transient requires a v2 recipe binding",
      );
    const source = config.connections[recipe.source.connection]!;
    const destination = config.connections[recipe.destination.connection]!;
    const separator = recipe.source.path.lastIndexOf("/");
    const names = managedResourceNames(config);
    args.push(
      `sourceLinkedService=${source.linkedService}`,
      `sourceStore=${source.store}`,
      `sourceNamespace=${source.namespace}`,
      `sourceFolder=${separator < 0 ? "" : recipe.source.path.slice(0, separator)}`,
      `sourceFile=${recipe.source.path.slice(separator + 1)}`,
      `destinationLinkedService=${destination.linkedService}`,
      `destinationStore=${destination.store}`,
      `destinationNamespace=${destination.namespace}`,
      `destinationPath=${recipe.destination.path.replace(/\/+$/, "")}/`,
      `transferLinkedServiceName=${names.transferLinkedService}`,
      `sourceDatasetName=${names.sourceDataset}`,
      `destinationDatasetName=${names.destinationDataset}`,
      `transferDatasetName=${names.transferDataset}`,
    );
  }
  args.push("--output", "json");
  if (verb === "what-if") args.push("--no-pretty-print");
  return args;
};

function hasCapability(
  actual: ConnectionCapability,
  required: "read" | "write",
) {
  return actual === required || actual === "read-write";
}

async function resolveConfiguredRecipe(
  configPath: string,
  config: AdfConfig,
): Promise<Recipe | undefined> {
  if (!config.recipe) return undefined;
  const recipe = await readRecipe(
    resolve(dirname(resolve(configPath)), config.recipe.path),
  );
  assertRecipeProfile(recipe, config.profile);
  for (const requirement of [
    { alias: recipe.source.connection, capability: "read" as const },
    { alias: recipe.destination.connection, capability: "write" as const },
  ]) {
    const connection = config.connections[requirement.alias];
    if (!connection)
      throw new CliError(
        "CONNECTION_MISSING",
        `Recipe alias is not configured: ${requirement.alias}`,
      );
    if (!hasCapability(connection.capability, requirement.capability))
      throw new CliError(
        "CONNECTION_CAPABILITY_MISMATCH",
        `${requirement.alias} does not grant ${requirement.capability}`,
      );
    if (config.profile !== "hosted-transient" && !connection.account)
      throw new CliError(
        "CONNECTION_ACCOUNT_REQUIRED",
        `${requirement.alias} requires an Azure storage account for ${config.profile}`,
      );
  }
  return recipe;
}

function serialiseConnectionRegistration(
  alias: string,
  connection: AdfConnection,
) {
  return stringify({
    connection: alias,
    storage: {
      account: connection.account,
      namespace: connection.namespace,
    },
    capabilities:
      connection.capability === "read-write"
        ? ["read", "write"]
        : [connection.capability],
  });
}

function serialiseRuntimeJobIntent(recipe: Recipe) {
  const marker = "__INGESTRON_ADF_RUN_ID__";
  const basePath = recipe.destination.path.replace(/\/+$/, "");
  const runtimeIntent = serialiseJobIntent({
    ...recipe,
    destination: {
      ...recipe.destination,
      path: `${basePath}/${marker}/`,
    },
  });
  const fragments = runtimeIntent.split(marker);
  if (fragments.length !== 2)
    throw new CliError(
      "RECIPE_INVALID",
      "Could not derive the ADF runtime package path",
      2,
    );
  return { prefix: fragments[0]!, suffix: fragments[1]! };
}

const managedResourceNames = (config: AdfConfig) => {
  // ADF's internal Copy expression composer emits resource names as property
  // selectors. Hyphens are valid resource-name characters but invalid in those
  // generated selectors, so keep the user-facing installation name and derive
  // expression-safe managed child names.
  const base = config.metadata.name.replaceAll("-", "_");
  return {
    transferLinkedService: `${base}_ingestron_transfer`,
    sourceDataset: `${base}_ingestron_source`,
    destinationDataset: `${base}_ingestron_destination`,
    transferDataset: `${base}_ingestron_transfer`,
  };
};

const ownedResources = (config: AdfConfig) => {
  const resources = [
    `${config.target.factoryResourceId}/pipelines/${config.integration.pipelineName}`,
  ];
  if (config.profile === "hosted-transient") {
    const names = managedResourceNames(config);
    resources.push(
      `${config.target.factoryResourceId}/datasets/${names.sourceDataset}`,
      `${config.target.factoryResourceId}/datasets/${names.destinationDataset}`,
      `${config.target.factoryResourceId}/datasets/${names.transferDataset}`,
      `${config.target.factoryResourceId}/linkedservices/${names.transferLinkedService}`,
    );
  }
  return resources;
};

function inspectWhatIf(value: unknown, config: AdfConfig) {
  if (!isRecord(value) || !Array.isArray(value.changes))
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure what-if returned no change list",
      4,
    );
  const owned = new Set(ownedResources(config).map((id) => id.toLowerCase()));
  return value.changes.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.resourceId !== "string" ||
      typeof entry.changeType !== "string"
    )
      throw new CliError(
        "AZ_OUTPUT_INVALID",
        "Azure what-if returned a malformed change",
        4,
      );
    const change = {
      resourceId: entry.resourceId,
      changeType: entry.changeType,
    };
    if (entry.changeType === "Ignore") return change;
    if (!owned.has(entry.resourceId.toLowerCase()))
      throw new CliError(
        "OWNERSHIP_COLLISION",
        `Azure what-if would change an unowned resource: ${entry.resourceId}`,
        5,
      );
    if (entry.changeType === "Delete")
      throw new CliError(
        "UNEXPECTED_DELETE",
        `Azure what-if proposed deletion: ${entry.resourceId}`,
        5,
      );
    return change;
  });
}

export async function adfPlan(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  await assertIdentity(config, runner);
  const bundle = await loadBundle(config);
  const recipe = await resolveConfiguredRecipe(configPath, config);
  const whatIf = await runner(
    deploymentArgs("what-if", config, bundle.templatePath, recipe),
  );
  const changes = inspectWhatIf(whatIf, config);
  return {
    action: "plan",
    target: config.target.factoryResourceId,
    profile: config.profile,
    recipe: recipe
      ? {
          outcome: recipe.outcome,
          source: recipe.source,
          destination: recipe.destination,
          operationalFields: "resolved-by-owning-runtime",
        }
      : undefined,
    bundle: { version: config.bundle.version, digest: bundle.manifestDigest },
    ownedResources: ownedResources(config),
    changes,
  };
}

export async function adfInstall(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Install requires interactive confirmation or explicit --yes after reviewing plan",
      3,
    );
  const plan = await adfPlan(configPath, runner);
  const config = await readAdfConfig(configPath);
  const bundle = await loadBundle(config);
  const recipe = await resolveConfiguredRecipe(configPath, config);
  await runner(deploymentArgs("create", config, bundle.templatePath, recipe));
  const lock = {
    apiVersion:
      config.apiVersion === "ingestron.cli/v2"
        ? "ingestron.cli-lock/v2"
        : "ingestron.cli-lock/v1",
    installation: config.metadata.name,
    target: config.target,
    bundle: { version: config.bundle.version, digest: bundle.manifestDigest },
    ...(config.apiVersion === "ingestron.cli/v2"
      ? {
          profile: config.profile,
          recipeDigest: recipe
            ? `sha256:${createHash("sha256").update(serialiseRecipe(recipe)).digest("hex")}`
            : undefined,
        }
      : {}),
    ownedResources: ownedResources(config),
  };
  const lockPath = resolve(dirname(resolve(configPath)), "ingestron.lock.yaml");
  const existing = await lstat(lockPath).catch(() => undefined);
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new CliError(
      "LOCK_UNSAFE",
      "Refusing to write a symbolic or non-regular ownership lock",
      5,
    );
  await writeFile(lockPath, stringify(lock), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  const status = await adfStatus(configPath, runner);
  const appliedConfigPath = resolve(
    dirname(resolve(configPath)),
    "ingestron.applied.yaml",
  );
  await writeFile(appliedConfigPath, await readSafeFile(resolve(configPath)), {
    mode: 0o600,
    flag: "w",
  });
  return {
    action: "install",
    verified: true,
    lockPath,
    appliedConfigPath,
    plan,
    status,
  };
}

async function readLock(configPath: string, config?: AdfConfig) {
  const lockPath = resolve(dirname(resolve(configPath)), "ingestron.lock.yaml");
  const lock = await readYaml(lockPath);
  if (
    !isRecord(lock) ||
    !["ingestron.cli-lock/v1", "ingestron.cli-lock/v2"].includes(
      String(lock.apiVersion),
    ) ||
    !Array.isArray(lock.ownedResources)
  )
    throw new CliError(
      "LOCK_INVALID",
      "A valid ingestron.cli-lock/v1 or v2 ownership lock is required",
      5,
    );
  if (
    !isRecord(lock.target) ||
    typeof lock.target.factoryResourceId !== "string" ||
    !isRecord(lock.bundle) ||
    typeof lock.bundle.version !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(String(lock.bundle.digest)) ||
    !(lock.ownedResources as unknown[]).every(
      (id) => typeof id === "string" && id.startsWith("/subscriptions/"),
    )
  )
    throw new CliError("LOCK_INVALID", "Ownership lock fields are invalid", 5);
  if (
    config &&
    (lock.target.factoryResourceId.toLowerCase() !==
      config.target.factoryResourceId.toLowerCase() ||
      (lock.apiVersion === "ingestron.cli-lock/v2" &&
        lock.profile !== config.profile) ||
      JSON.stringify(lock.ownedResources) !==
        JSON.stringify(
          lock.apiVersion === "ingestron.cli-lock/v1"
            ? [
                `${config.target.factoryResourceId}/pipelines/${config.integration.pipelineName}`,
              ]
            : ownedResources(config),
        ))
  )
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Lock ownership does not exactly match the configured integration",
      5,
    );
  return { lock, lockPath };
}

export async function adfStatus(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  const target = await assertIdentity(config, runner);
  const { lock } = await readLock(configPath, config);
  const ids = lock.ownedResources as unknown[];
  const resources = [];
  const missingResources = [];
  for (const id of ids) {
    let resource: unknown;
    try {
      resource = await runner([
        "resource",
        "show",
        "--ids",
        String(id),
        "--subscription",
        target.subscriptionId,
        "--output",
        "json",
      ]);
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === "AZ_COMMAND_FAILED" &&
        /(?:\(NotFound\)|Code:\s*NotFound\b)/i.test(error.message)
      ) {
        missingResources.push(String(id));
        continue;
      }
      throw error;
    }
    if (
      !isRecord(resource) ||
      typeof resource.id !== "string" ||
      resource.id.toLowerCase() !== String(id).toLowerCase()
    )
      throw new CliError(
        "RESOURCE_DRIFT",
        `Azure did not return the exact owned resource: ${String(id)}`,
        5,
      );
    const properties = isRecord(resource.properties) ? resource.properties : {};
    resources.push({
      id: resource.id,
      provisioningState: properties.provisioningState ?? "Succeeded",
      annotations: properties.annotations ?? [],
    });
  }
  return {
    action: "status",
    installed: missingResources.length === 0,
    resources,
    missingResources,
    resource: resources[0],
    lock,
  };
}

export async function adfVerify(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  const bundle = await loadBundle(config);
  const { lock } = await readLock(configPath, config);
  const recipe = await resolveConfiguredRecipe(configPath, config);
  const recipeDigest = recipe
    ? `sha256:${createHash("sha256").update(serialiseRecipe(recipe)).digest("hex")}`
    : undefined;
  if (
    !isRecord(lock.bundle) ||
    lock.bundle.version !== config.bundle.version ||
    lock.bundle.digest !== bundle.manifestDigest ||
    (lock.apiVersion === "ingestron.cli-lock/v2" &&
      lock.recipeDigest !== recipeDigest)
  )
    throw new CliError(
      "LOCK_DRIFT",
      "Installed lock does not match configured immutable bundle",
      5,
    );
  const status = await adfStatus(configPath, runner);
  if (!status.installed)
    throw new CliError(
      "RESOURCE_MISSING",
      "One or more lock-owned ADF resources are not installed",
      5,
      { missingResources: status.missingResources },
    );
  return { action: "verify", valid: true, status };
}

export async function adfPlanUninstall(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAdfConfig(configPath);
  await assertIdentity(config, runner);
  const { lock } = await readLock(configPath, config);
  const expected = ownedResources(config);
  if (JSON.stringify(lock.ownedResources) !== JSON.stringify(expected))
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Lock ownership does not exactly match the configured integration",
      5,
    );
  return {
    action: "plan-uninstall",
    target: config.target.factoryResourceId,
    delete: expected,
  };
}

export async function adfUninstall(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Uninstall requires explicit --yes after reviewing plan",
      3,
    );
  const config = await readAdfConfig(configPath);
  const target = targetParts(config);
  const plan = await adfPlanUninstall(configPath, runner);
  for (const id of plan.delete) {
    await runner([
      "resource",
      "delete",
      "--ids",
      id,
      "--subscription",
      target.subscriptionId,
      "--output",
      "json",
    ]);
    await runner([
      "resource",
      "wait",
      "--deleted",
      "--ids",
      id,
      "--subscription",
      target.subscriptionId,
      "--output",
      "json",
    ]);
  }
  return {
    action: "uninstall",
    deleted: plan.delete,
    lockRetainedForAudit: true,
  };
}

export async function adfUpgrade(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Upgrade requires explicit --yes after reviewing plan",
      3,
    );
  await readLock(configPath, await readAdfConfig(configPath));
  const directory = dirname(resolve(configPath));
  const appliedPath = resolve(directory, "ingestron.applied.yaml");
  const previousPath = resolve(directory, "ingestron.previous.yaml");
  const previousLockPath = resolve(directory, "ingestron.previous.lock.yaml");
  await writeFile(previousPath, await readSafeFile(appliedPath), {
    mode: 0o600,
    flag: "w",
  });
  await writeFile(
    previousLockPath,
    await readSafeFile(resolve(directory, "ingestron.lock.yaml")),
    { mode: 0o600, flag: "w" },
  );
  return adfInstall(configPath, yes, runner);
}

export async function adfRollback(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Rollback requires explicit --yes after reviewing the previous snapshot",
      3,
    );
  const current = await readAdfConfig(configPath);
  await readLock(configPath, current);
  const directory = dirname(resolve(configPath));
  const previousPath = resolve(directory, "ingestron.previous.yaml");
  const previous = await readAdfConfig(previousPath);
  if (
    previous.metadata.name !== current.metadata.name ||
    previous.target.factoryResourceId.toLowerCase() !==
      current.target.factoryResourceId.toLowerCase()
  )
    throw new CliError(
      "ROLLBACK_UNSAFE",
      "Previous snapshot does not match the exact installation target",
      5,
    );
  await writeFile(
    resolve(directory, "ingestron.rollback-source.yaml"),
    await readSafeFile(resolve(configPath)),
    { mode: 0o600, flag: "w" },
  );
  await writeFile(resolve(configPath), await readSafeFile(previousPath), {
    mode: 0o600,
    flag: "w",
  });
  const result = await adfInstall(configPath, true, runner);
  return { action: "rollback", restoredFrom: previousPath, result };
}
