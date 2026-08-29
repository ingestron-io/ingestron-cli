import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

import { adfInit, azRunner, type CommandRunner } from "./adf.js";
import { CliError, redact } from "./errors.js";
import { isRecord, readSafeFile, readYaml } from "./files.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^sha256:([a-f0-9]{64})$/;
const bundleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../bundles/azure/profile-j",
);
const expectedFunction = "submitIngestronJob";

export type AzureConfig = {
  apiVersion: "ingestron.azure/v1";
  kind: "AzureInstallation";
  metadata: { name: string };
  target: {
    tenantId: string;
    subscriptionId: string;
    subscriptionName: string;
    resourceGroupName: string;
    location: string;
  };
  profile: {
    name: "profile-j";
    resourceSuffix: string;
    deploymentMode: "temporary-proof" | "persistent-demo";
    apiIngressMode: "disabled" | "entra-public";
  };
  identity: {
    entraApplicationClientId: string;
    allowedClientApplicationIds: string[];
    pipelineCallerPrincipalId: string;
  };
  artifacts: {
    workerImageSource: string;
    jobsFunctionsPackage: string;
  };
  cost: { plannedUsd: number };
  tags: Record<string, string>;
  bundle: { version: string; digest: string };
};

type AzureManifest = {
  contract: "ingestron.azure-bundle/v1";
  bundleVersion: string;
  profile: "profile-j";
  minimumCliVersion: string;
  monthlyCostCeilingUsd: number;
  deploymentModes: string[];
  ingressModes: string[];
  templates: { foundation: string; runtime: string };
  applicationDeploymentHelper: string;
  applicationArtifacts: {
    jobsFunctions: {
      version: string;
      sha256: string;
      fileName: string;
      downloadUrl: string;
      license: string;
    };
    workerImage: {
      registry: string;
      repository: string;
      sha256: string;
      license: string;
    };
  };
  licensing: {
    source: string;
    runtime: string;
    runtimeLicenseFile: string;
  };
  changePolicy: {
    foundationAllowed: string[];
    runtimeAllowed: string[];
    deletionAllowed: false;
    replacementAllowed: false;
    ownedResourceGroup: true;
  };
  files: Record<string, { sha256: string; size: number }>;
};

type AzureLock = {
  apiVersion: "ingestron.azure-lock/v1";
  installation: string;
  state: "installing" | "installed" | "removed";
  target: AzureConfig["target"];
  profile: AzureConfig["profile"];
  configDigest: string;
  bundle: AzureConfig["bundle"];
  integration?: Record<string, string>;
  ownedResourceGroupId: string;
  ownedResources: string[];
  directoryObjects: string[];
  history: Array<{
    bundle: AzureConfig["bundle"];
    integration?: Record<string, string>;
  }>;
};

export type LocalRunner = (script: string, args: string[]) => Promise<string>;
export type ArtifactVerifier = (
  configPath: string,
  config: AzureConfig,
  manifest: AzureManifest,
) => Promise<string>;
export type ArtifactDownloader = (
  url: string,
  target: string,
  expectedSha256: string,
) => Promise<void>;

export type AzureInitOptions = {
  name?: string;
  subscriptionId: string;
  resourceGroupName: string;
  location: string;
  resourceSuffix: string;
  deploymentMode: AzureConfig["profile"]["deploymentMode"];
  apiIngressMode: AzureConfig["profile"]["apiIngressMode"];
  entraApplicationClientId: string;
  allowedClientApplicationIds: string[];
  pipelineCallerPrincipalId: string;
  workerImageSource?: string;
  jobsFunctionsPackage?: string;
  plannedUsd: number;
  bundleVersion?: string;
  expiresOn?: string;
};

const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected)
    throw new CliError(
      "CONFIG_INVALID",
      `Unsupported Azure configuration field: ${unexpected}`,
    );
};

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

const safeRelativePath = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !isAbsolute(value) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.split("/").some((part) => !part || part === "..");

const resourceGroupId = (config: AzureConfig) =>
  `/subscriptions/${config.target.subscriptionId}/resourceGroups/${config.target.resourceGroupName}`;

const lockPathFor = (configPath: string) =>
  resolve(dirname(resolve(configPath)), "ingestron.azure.lock.yaml");

const configDigest = (config: AzureConfig) =>
  `sha256:${sha256(stringify(config, { lineWidth: 0 }))}`;

const defaultLocalRunner: LocalRunner = (script, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", () =>
      reject(
        new CliError(
          "APPLICATION_DEPLOY_FAILED",
          "The Azure-owned application deployment helper could not start",
          4,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0)
        reject(
          new CliError(
            "APPLICATION_DEPLOY_FAILED",
            redact(stderr || "Application deployment failed"),
            4,
          ),
        );
      else resolvePromise(stdout.trim());
    });
  });

async function loadBundle(version: string, pinnedDigest?: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new CliError("BUNDLE_UNSUPPORTED", "Unsafe Azure bundle version");
  const directory = resolve(bundleRoot, version);
  const child = relative(bundleRoot, directory);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new CliError("BUNDLE_UNSUPPORTED", "Unsafe Azure bundle path");
  const manifestBytes = await readSafeFile(
    resolve(directory, "manifest.json"),
    4 * 1024 * 1024,
  );
  let manifest: AzureManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as AzureManifest;
  } catch {
    throw new CliError("BUNDLE_INVALID", "Azure bundle manifest is invalid");
  }
  if (
    manifest.contract !== "ingestron.azure-bundle/v1" ||
    manifest.bundleVersion !== version ||
    manifest.profile !== "profile-j" ||
    manifest.licensing?.source !== "Apache-2.0" ||
    manifest.licensing?.runtime !==
      "LicenseRef-Ingestron-Runtime-Preview-1.0" ||
    manifest.applicationArtifacts?.jobsFunctions?.license !==
      manifest.licensing.runtime ||
    manifest.applicationArtifacts?.workerImage?.license !==
      manifest.licensing.runtime ||
    !/^https:\/\/github\.com\/(?:intentlabs-dev|ingestron-io)\/ingestron-azure\/releases\/download\/v[0-9A-Za-z.-]+\/[A-Za-z0-9._-]+\.zip$/.test(
      manifest.applicationArtifacts.jobsFunctions.downloadUrl,
    ) ||
    !["ghcr.io/intentlabs-dev", "ghcr.io/ingestron-io"].includes(
      manifest.applicationArtifacts.workerImage.registry,
    ) ||
    manifest.changePolicy.deletionAllowed !== false ||
    manifest.changePolicy.replacementAllowed !== false ||
    manifest.changePolicy.ownedResourceGroup !== true
  )
    throw new CliError("BUNDLE_INVALID", "Azure bundle is incompatible");
  const manifestDigest = `sha256:${sha256(manifestBytes)}`;
  if (pinnedDigest && pinnedDigest !== manifestDigest)
    throw new CliError(
      "BUNDLE_TAMPERED",
      "Pinned Azure bundle manifest digest does not match",
      5,
    );
  for (const [fileName, expected] of Object.entries(manifest.files)) {
    if (
      !safeRelativePath(fileName) ||
      !digestPattern.test(`sha256:${expected.sha256}`)
    )
      throw new CliError("BUNDLE_INVALID", "Azure bundle file entry is unsafe");
    const bytes = await readSafeFile(
      resolve(directory, fileName),
      8 * 1024 * 1024,
    );
    if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256)
      throw new CliError(
        "BUNDLE_TAMPERED",
        `Azure bundle file digest mismatch: ${fileName}`,
        5,
      );
  }
  return {
    directory,
    manifest,
    manifestDigest,
    foundation: resolve(directory, manifest.templates.foundation),
    runtime: resolve(directory, manifest.templates.runtime),
    helper: resolve(directory, manifest.applicationDeploymentHelper),
  };
}

export async function readAzureConfig(path: string): Promise<AzureConfig> {
  const value = await readYaml(path);
  if (
    !isRecord(value) ||
    value.apiVersion !== "ingestron.azure/v1" ||
    value.kind !== "AzureInstallation"
  )
    throw new CliError(
      "CONFIG_UNSUPPORTED",
      "Expected ingestron.azure/v1 AzureInstallation",
    );
  onlyKeys(value, [
    "apiVersion",
    "kind",
    "metadata",
    "target",
    "profile",
    "identity",
    "artifacts",
    "cost",
    "tags",
    "bundle",
  ]);
  for (const section of [
    "metadata",
    "target",
    "profile",
    "identity",
    "artifacts",
    "cost",
    "tags",
    "bundle",
  ]) {
    if (!isRecord(value[section]))
      throw new CliError("CONFIG_INVALID", `${section} must be an object`);
  }
  const config = value as unknown as AzureConfig;
  onlyKeys(config.metadata, ["name"]);
  onlyKeys(config.target, [
    "tenantId",
    "subscriptionId",
    "subscriptionName",
    "resourceGroupName",
    "location",
  ]);
  onlyKeys(config.profile, [
    "name",
    "resourceSuffix",
    "deploymentMode",
    "apiIngressMode",
  ]);
  onlyKeys(config.identity, [
    "entraApplicationClientId",
    "allowedClientApplicationIds",
    "pipelineCallerPrincipalId",
  ]);
  onlyKeys(config.artifacts, ["workerImageSource", "jobsFunctionsPackage"]);
  onlyKeys(config.cost, ["plannedUsd"]);
  onlyKeys(config.bundle, ["version", "digest"]);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.metadata.name))
    throw new CliError("CONFIG_INVALID", "metadata.name is invalid");
  if (
    !uuidPattern.test(config.target.tenantId) ||
    !uuidPattern.test(config.target.subscriptionId) ||
    !config.target.subscriptionName ||
    !/^[A-Za-z0-9._()-]{1,90}$/.test(config.target.resourceGroupName) ||
    !/^[a-z0-9-]{2,40}$/.test(config.target.location)
  )
    throw new CliError("CONFIG_INVALID", "Azure target is invalid");
  if (
    config.profile.name !== "profile-j" ||
    !/^[a-z0-9]{6,12}$/.test(config.profile.resourceSuffix) ||
    !["temporary-proof", "persistent-demo"].includes(
      config.profile.deploymentMode,
    ) ||
    !["disabled", "entra-public"].includes(config.profile.apiIngressMode)
  )
    throw new CliError("CONFIG_INVALID", "Azure profile is invalid");
  if (
    !uuidPattern.test(config.identity.entraApplicationClientId) ||
    !uuidPattern.test(config.identity.pipelineCallerPrincipalId) ||
    !Array.isArray(config.identity.allowedClientApplicationIds) ||
    config.identity.allowedClientApplicationIds.length !== 1 ||
    !config.identity.allowedClientApplicationIds.every((id) =>
      uuidPattern.test(id),
    )
  )
    throw new CliError("CONFIG_INVALID", "Azure identity boundary is invalid");
  if (
    !safeRelativePath(config.artifacts.jobsFunctionsPackage) ||
    !/^https:\/\/[^/?#]+\/[^?#]+@sha256:[a-f0-9]{64}$/.test(
      config.artifacts.workerImageSource,
    )
  )
    throw new CliError("CONFIG_INVALID", "Azure artefact reference is invalid");
  if (!Number.isFinite(config.cost.plannedUsd) || config.cost.plannedUsd <= 0)
    throw new CliError("CONFIG_INVALID", "cost.plannedUsd must be positive");
  if (
    !/^\d+\.\d+\.\d+$/.test(config.bundle.version) ||
    !digestPattern.test(config.bundle.digest)
  )
    throw new CliError("CONFIG_INVALID", "Azure bundle pin is invalid");
  for (const [key, tagValue] of Object.entries(config.tags)) {
    if (
      !/^[A-Za-z0-9:._-]{1,128}$/.test(key) ||
      typeof tagValue !== "string" ||
      tagValue.length > 256
    )
      throw new CliError("CONFIG_INVALID", "Azure tag is invalid");
  }
  return config;
}

async function assertIdentity(config: AzureConfig, runner: CommandRunner) {
  const account = await runner(["account", "show", "--output", "json"]);
  if (
    !isRecord(account) ||
    String(account.id).toLowerCase() !==
      config.target.subscriptionId.toLowerCase() ||
    String(account.tenantId).toLowerCase() !==
      config.target.tenantId.toLowerCase() ||
    String(account.name) !== config.target.subscriptionName
  )
    throw new CliError(
      "AZ_IDENTITY_MISMATCH",
      "Active Azure tenant/subscription does not match the exact target",
      4,
    );
  return account;
}

async function verifyArtifacts(
  configPath: string,
  config: AzureConfig,
  manifest: AzureManifest,
) {
  const packagePath = resolve(
    dirname(resolve(configPath)),
    config.artifacts.jobsFunctionsPackage,
  );
  const packageBytes = await readSafeFile(packagePath, 64 * 1024 * 1024);
  if (
    sha256(packageBytes) !== manifest.applicationArtifacts.jobsFunctions.sha256
  )
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Jobs Function package digest does not match the Azure bundle",
      5,
    );
  const sourceDigest = config.artifacts.workerImageSource.split("@sha256:")[1];
  if (sourceDigest !== manifest.applicationArtifacts.workerImage.sha256)
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Worker image digest does not match the Azure bundle",
      5,
    );
  return packagePath;
}

const defaultArtifactDownloader: ArtifactDownloader = async (
  source,
  target,
  expectedSha256,
) => {
  try {
    const existing = await lstat(target);
    if (existing.isFile()) return;
    throw new CliError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "Runtime artefact target exists but is not a file",
      4,
    );
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  let current = new URL(source);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const initial = redirects === 0;
    const allowedHost =
      (initial && current.hostname === "github.com") ||
      (!initial &&
        (current.hostname === "release-assets.githubusercontent.com" ||
          current.hostname === "objects.githubusercontent.com" ||
          current.hostname.endsWith(".githubusercontent.com")));
    if (
      current.protocol !== "https:" ||
      current.username ||
      current.password ||
      current.hash ||
      !allowedHost ||
      (initial && current.search)
    )
      throw new CliError(
        "ARTIFACT_DOWNLOAD_FAILED",
        "Runtime artefact download boundary is invalid",
        4,
      );
    response = await fetch(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new CliError(
          "ARTIFACT_DOWNLOAD_FAILED",
          "Runtime artefact redirect is invalid",
          4,
        );
      current = new URL(location, current);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body)
    throw new CliError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "Runtime artefact could not be downloaded",
      4,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 64 * 1024 * 1024) {
      await reader.cancel();
      throw new CliError(
        "ARTIFACT_DOWNLOAD_FAILED",
        "Runtime artefact exceeds the 64 MiB limit",
        4,
      );
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expectedSha256)
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Downloaded runtime artefact digest does not match the bundle",
      5,
    );
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  }
};

const foundationArgs = (
  verb: "what-if" | "create",
  config: AzureConfig,
  templatePath: string,
) => [
  "deployment",
  "sub",
  verb,
  "--subscription",
  config.target.subscriptionId,
  "--location",
  config.target.location,
  "--name",
  `ingestron-${config.metadata.name}-foundation`,
  "--template-file",
  templatePath,
  "--parameters",
  `resourceGroupName=${config.target.resourceGroupName}`,
  `location=${config.target.location}`,
  `resourceSuffix=${config.profile.resourceSuffix}`,
  `deploymentMode=${config.profile.deploymentMode}`,
  `tags=${JSON.stringify(config.tags)}`,
  "monthlyCostCeilingUsd=50",
  ...(verb === "what-if" ? ["--no-pretty-print"] : []),
  "--output",
  "json",
];

const targetWorkerImage = (config: AzureConfig, manifest: AzureManifest) =>
  `ingjcr${config.profile.resourceSuffix}.azurecr.io/${manifest.applicationArtifacts.workerImage.repository}@sha256:${manifest.applicationArtifacts.workerImage.sha256}`;

const runtimeArgs = (
  verb: "what-if" | "create",
  config: AzureConfig,
  manifest: AzureManifest,
  templatePath: string,
) => [
  "deployment",
  "group",
  verb,
  "--subscription",
  config.target.subscriptionId,
  "--resource-group",
  config.target.resourceGroupName,
  "--name",
  `ingestron-${config.metadata.name}-runtime`,
  "--template-file",
  templatePath,
  "--parameters",
  `location=${config.target.location}`,
  `resourceSuffix=${config.profile.resourceSuffix}`,
  `workerImage=${targetWorkerImage(config, manifest)}`,
  `jobsPackageVersion=${manifest.applicationArtifacts.jobsFunctions.version}`,
  `jobsPackageSha256=${manifest.applicationArtifacts.jobsFunctions.sha256}`,
  `entraTenantId=${config.target.tenantId}`,
  `entraApplicationClientId=${config.identity.entraApplicationClientId}`,
  `allowedClientApplicationIds=${JSON.stringify(config.identity.allowedClientApplicationIds)}`,
  `pipelineCallerPrincipalId=${config.identity.pipelineCallerPrincipalId}`,
  `deploymentMode=${config.profile.deploymentMode}`,
  `apiIngressMode=${config.profile.apiIngressMode}`,
  `tags=${JSON.stringify(config.tags)}`,
  "monthlyCostCeilingUsd=50",
  ...(verb === "what-if" ? ["--no-pretty-print"] : []),
  "--output",
  "json",
];

function changesFrom(value: unknown) {
  if (!isRecord(value))
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure what-if returned no object",
      4,
    );
  const changes = Array.isArray(value.changes)
    ? value.changes
    : isRecord(value.properties) && Array.isArray(value.properties.changes)
      ? value.properties.changes
      : undefined;
  if (!changes)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure what-if returned no changes",
      4,
    );
  return changes;
}

function isExpectedFoundationProviderNoise(
  entry: Record<string, unknown>,
  config: AzureConfig,
) {
  if (entry.changeType !== "Modify" || typeof entry.resourceId !== "string")
    return false;
  const registryId =
    `${resourceGroupId(config)}/providers/Microsoft.ContainerRegistry/registries/ingjcr${config.profile.resourceSuffix}`.toLowerCase();
  const resourceId = entry.resourceId.toLowerCase();
  const delta = Array.isArray(entry.delta) ? entry.delta : [];
  if (!delta.length || !delta.every(isRecord)) return false;
  if (resourceId === registryId) {
    const expected = new Set([
      "properties.anonymousPullEnabled",
      "properties.encryption",
      "properties.policies.azureADAuthenticationAsArmPolicy",
    ]);
    return delta.every(
      (change) =>
        expected.has(String(change.path)) &&
        change.propertyChangeType === "Delete" &&
        change.after === null,
    );
  }
  if (
    resourceId.startsWith(
      `${registryId}/providers/microsoft.authorization/roleassignments/`,
    )
  ) {
    return (
      delta.some((change) => change.path === "properties.principalId") &&
      delta.every((change) => {
        if (change.path === "properties.principalId")
          return (
            change.propertyChangeType === "Modify" &&
            typeof change.before === "string" &&
            uuidPattern.test(change.before) &&
            typeof change.after === "string" &&
            change.after.startsWith("[reference(")
          );
        return (
          change.path === "properties.principalType" &&
          change.propertyChangeType === "NoEffect" &&
          change.before === null &&
          change.after === "ServicePrincipal"
        );
      })
    );
  }
  return false;
}

function inspectWhatIf(
  value: unknown,
  config: AzureConfig,
  allowed: string[],
  phase: "foundation" | "runtime",
) {
  const group = resourceGroupId(config).toLowerCase();
  return changesFrom(value).map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.changeType !== "string" ||
      typeof entry.resourceId !== "string"
    )
      throw new CliError("AZ_OUTPUT_INVALID", "Malformed Azure change", 4);
    const providerNoise =
      phase === "foundation" &&
      isExpectedFoundationProviderNoise(entry, config);
    const type = providerNoise ? "Ignore" : entry.changeType;
    const id = entry.resourceId;
    if (type === "Delete")
      throw new CliError(
        "UNEXPECTED_DELETE",
        `Azure proposed deletion: ${id}`,
        5,
      );
    if (!allowed.includes(type))
      throw new CliError(
        "UNEXPECTED_CHANGE",
        `Azure proposed unsupported ${type} change: ${id}`,
        5,
      );
    const lower = id.toLowerCase();
    const subscriptionDeployment =
      lower.startsWith(
        `/subscriptions/${config.target.subscriptionId.toLowerCase()}/providers/microsoft.resources/deployments/`,
      ) && lower.endsWith(`ingestron-${config.metadata.name}-foundation`);
    if (
      lower !== group &&
      !lower.startsWith(`${group}/`) &&
      !subscriptionDeployment
    )
      throw new CliError(
        "OWNERSHIP_COLLISION",
        `Azure what-if would change outside the owned group: ${id}`,
        5,
      );
    return { resourceId: id, changeType: type };
  });
}

async function groupExists(config: AzureConfig, runner: CommandRunner) {
  const result = await runner([
    "group",
    "exists",
    "--subscription",
    config.target.subscriptionId,
    "--name",
    config.target.resourceGroupName,
    "--output",
    "json",
  ]);
  return result === true;
}

async function assertGroupOwnership(
  config: AzureConfig,
  runner: CommandRunner,
) {
  const group = await runner([
    "group",
    "show",
    "--subscription",
    config.target.subscriptionId,
    "--name",
    config.target.resourceGroupName,
    "--output",
    "json",
  ]);
  if (!isRecord(group) || !isRecord(group.tags))
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Owned resource-group tags are absent",
      5,
    );
  const expectedProfile =
    config.profile.deploymentMode === "persistent-demo"
      ? "profile-j-demo"
      : "profile-j";
  if (
    group.tags["ingestron:programme"] !== "ingestron" ||
    group.tags["ingestron:profile"] !== expectedProfile ||
    group.tags["ingestron:lifecycle"] !== config.profile.deploymentMode ||
    group.tags["ingestron:managed-by"] !== "bicep" ||
    group.tags["ingestron:monthly-cost-ceiling-usd"] !== "50"
  )
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Resource group is not the exact Bicep-owned Ingestron boundary",
      5,
    );
}

export async function azureInit(
  outputPath: string,
  options: AzureInitOptions,
  runner: CommandRunner = azRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
  artifactDownloader: ArtifactDownloader = defaultArtifactDownloader,
) {
  if (!uuidPattern.test(options.subscriptionId))
    throw new CliError(
      "CONFIG_INVALID",
      "--subscription must be an Azure subscription ID",
      2,
    );
  const account = await runner([
    "account",
    "show",
    "--subscription",
    options.subscriptionId,
    "--output",
    "json",
  ]);
  if (!isRecord(account))
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure account context is invalid",
      4,
    );
  if (
    String(account.id ?? "").toLowerCase() !==
    options.subscriptionId.toLowerCase()
  ) {
    throw new CliError(
      "AZURE_CONTEXT_MISMATCH",
      "Azure returned a different subscription than the explicit --subscription target",
      4,
    );
  }
  const version = options.bundleVersion ?? "1.7.0";
  const bundle = await loadBundle(version);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.name ?? "ingestron"))
    throw new CliError("CONFIG_INVALID", "--name must be a safe identifier");
  const directory = dirname(resolve(outputPath));
  const packagePath = options.jobsFunctionsPackage
    ? resolve(options.jobsFunctionsPackage)
    : resolve(
        directory,
        "artifacts",
        bundle.manifest.applicationArtifacts.jobsFunctions.fileName,
      );
  if (!options.jobsFunctionsPackage) {
    await artifactDownloader(
      bundle.manifest.applicationArtifacts.jobsFunctions.downloadUrl,
      packagePath,
      bundle.manifest.applicationArtifacts.jobsFunctions.sha256,
    );
  }
  const packageRelative = relative(directory, packagePath).replaceAll(
    "\\",
    "/",
  );
  if (!safeRelativePath(packageRelative))
    throw new CliError(
      "CONFIG_INVALID",
      "Jobs Function package must be a portable path beneath or adjacent to the config",
    );
  const config: AzureConfig = {
    apiVersion: "ingestron.azure/v1",
    kind: "AzureInstallation",
    metadata: { name: options.name ?? "ingestron" },
    target: {
      tenantId: String(account.tenantId ?? ""),
      subscriptionId: String(account.id ?? ""),
      subscriptionName: String(account.name ?? ""),
      resourceGroupName: options.resourceGroupName,
      location: options.location,
    },
    profile: {
      name: "profile-j",
      resourceSuffix: options.resourceSuffix,
      deploymentMode: options.deploymentMode,
      apiIngressMode: options.apiIngressMode,
    },
    identity: {
      entraApplicationClientId: options.entraApplicationClientId,
      allowedClientApplicationIds: options.allowedClientApplicationIds,
      pipelineCallerPrincipalId: options.pipelineCallerPrincipalId,
    },
    artifacts: {
      workerImageSource:
        options.workerImageSource ??
        `https://${bundle.manifest.applicationArtifacts.workerImage.registry}/${bundle.manifest.applicationArtifacts.workerImage.repository}@sha256:${bundle.manifest.applicationArtifacts.workerImage.sha256}`,
      jobsFunctionsPackage: packageRelative,
    },
    cost: { plannedUsd: options.plannedUsd },
    tags: {
      "ingestron:owner": "customer",
      "ingestron:purpose": options.name ?? "ingestron",
      ...(options.expiresOn
        ? { "ingestron:expires-on": options.expiresOn }
        : {}),
    },
    bundle: { version, digest: bundle.manifestDigest },
  };
  const absolute = resolve(outputPath);
  await artifactVerifier(absolute, config, bundle.manifest);
  try {
    await writeFile(absolute, stringify(config, { lineWidth: 0 }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST")
      throw new CliError("FILE_EXISTS", `Refusing to overwrite: ${absolute}`);
    throw error;
  }
  await readAzureConfig(absolute);
  return {
    action: "init",
    configPath: absolute,
    target: config.target,
    profile: config.profile,
    bundle: config.bundle,
    next: `ingestron azure plan --config ${absolute}`,
  };
}

async function planConfig(
  configPath: string,
  config: AzureConfig,
  runner: CommandRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  await assertIdentity(config, runner);
  const bundle = await loadBundle(config.bundle.version, config.bundle.digest);
  await artifactVerifier(configPath, config, bundle.manifest);
  if (config.cost.plannedUsd > bundle.manifest.monthlyCostCeilingUsd)
    throw new CliError(
      "COST_BOUND_EXCEEDED",
      "Planned cost exceeds the Azure bundle ceiling",
      5,
    );
  const exists = await groupExists(config, runner);
  if (exists) await assertGroupOwnership(config, runner);
  const foundation = inspectWhatIf(
    await runner(foundationArgs("what-if", config, bundle.foundation)),
    config,
    bundle.manifest.changePolicy.foundationAllowed,
    "foundation",
  );
  const runtime = exists
    ? inspectWhatIf(
        await runner(
          runtimeArgs("what-if", config, bundle.manifest, bundle.runtime),
        ),
        config,
        bundle.manifest.changePolicy.runtimeAllowed,
        "runtime",
      )
    : undefined;
  return {
    action: "plan",
    target: config.target,
    profile: config.profile,
    bundle: config.bundle,
    cost: {
      plannedUsd: config.cost.plannedUsd,
      ceilingUsd: bundle.manifest.monthlyCostCeilingUsd,
      liveBudgetPreflight: "operator-owned",
    },
    foundation,
    runtime: runtime ?? {
      deferredUntilFoundation: true,
      reason:
        "The runtime references the private registry created by foundation Bicep.",
    },
  };
}

export async function azurePlan(
  configPath: string,
  runner: CommandRunner = azRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  const config = await readAzureConfig(configPath);
  return planConfig(configPath, config, runner, artifactVerifier);
}

function outputValue(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined;
  const outputs =
    isRecord(value.properties) && isRecord(value.properties.outputs)
      ? value.properties.outputs
      : isRecord(value.outputs)
        ? value.outputs
        : undefined;
  const output = outputs?.[name];
  return isRecord(output) && "value" in output ? output.value : undefined;
}

async function listResourceIds(config: AzureConfig, runner: CommandRunner) {
  const resources = await runner([
    "resource",
    "list",
    "--subscription",
    config.target.subscriptionId,
    "--resource-group",
    config.target.resourceGroupName,
    "--output",
    "json",
  ]);
  if (
    !Array.isArray(resources) ||
    !resources.every((item) => isRecord(item) && typeof item.id === "string")
  )
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure resource inventory is invalid",
      4,
    );
  return resources
    .map((item) => String(item.id))
    .sort((left, right) => left.localeCompare(right));
}

async function writeLock(path: string, lock: AzureLock) {
  const stat = await lstat(path).catch(() => undefined);
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new CliError("LOCK_UNSAFE", "Azure lock is not a regular file", 5);
  await writeFile(
    path,
    stringify(lock, { aliasDuplicateObjects: false, lineWidth: 0 }),
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    },
  );
}

async function readLock(configPath: string): Promise<AzureLock> {
  const path = lockPathFor(configPath);
  const value = await readYaml(path);
  if (
    !isRecord(value) ||
    value.apiVersion !== "ingestron.azure-lock/v1" ||
    !Array.isArray(value.ownedResources) ||
    !Array.isArray(value.directoryObjects) ||
    !Array.isArray(value.history)
  )
    throw new CliError(
      "LOCK_INVALID",
      "A valid Azure ownership lock is required",
      5,
    );
  const lock = value as unknown as AzureLock;
  onlyKeys(value, [
    "apiVersion",
    "installation",
    "state",
    "target",
    "profile",
    "configDigest",
    "bundle",
    "integration",
    "ownedResourceGroupId",
    "ownedResources",
    "directoryObjects",
    "history",
  ]);
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(lock.installation) ||
    !["installing", "installed", "removed"].includes(lock.state) ||
    !digestPattern.test(lock.configDigest) ||
    !isRecord(lock.target) ||
    !isRecord(lock.profile) ||
    !isRecord(lock.bundle) ||
    !/^\d+\.\d+\.\d+$/.test(lock.bundle.version) ||
    !digestPattern.test(lock.bundle.digest) ||
    !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+$/i.test(
      lock.ownedResourceGroupId,
    ) ||
    !lock.ownedResources.every(
      (id) =>
        typeof id === "string" &&
        id
          .toLowerCase()
          .startsWith(`${lock.ownedResourceGroupId.toLowerCase()}/providers/`),
    ) ||
    lock.directoryObjects.length !== 0 ||
    lock.history.length > 2
  )
    throw new CliError(
      "LOCK_INVALID",
      "Azure ownership lock fields are invalid",
      5,
    );
  return lock;
}

async function applyConfig(
  configPath: string,
  config: AzureConfig,
  runner: CommandRunner,
  localRunner: LocalRunner,
  previous?: AzureLock,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  const plan = await planConfig(configPath, config, runner, artifactVerifier);
  const bundle = await loadBundle(config.bundle.version, config.bundle.digest);
  const packagePath = await artifactVerifier(
    configPath,
    config,
    bundle.manifest,
  );
  const lockPath = lockPathFor(configPath);
  const pending: AzureLock = {
    apiVersion: "ingestron.azure-lock/v1",
    installation: config.metadata.name,
    state: "installing",
    target: config.target,
    profile: config.profile,
    configDigest: configDigest(config),
    bundle: config.bundle,
    ownedResourceGroupId: resourceGroupId(config),
    ownedResources: previous?.ownedResources ?? [],
    directoryObjects: previous?.directoryObjects ?? [],
    history: previous?.history ?? [],
  };
  await writeLock(lockPath, pending);
  const foundation = await runner(
    foundationArgs("create", config, bundle.foundation),
  );
  await assertGroupOwnership(config, runner);
  const registryName = String(
    outputValue(foundation, "registryName") ??
      `ingjcr${config.profile.resourceSuffix}`,
  );
  await runner([
    "acr",
    "import",
    "--subscription",
    config.target.subscriptionId,
    "--name",
    registryName,
    "--source",
    config.artifacts.workerImageSource.replace(/^https:\/\//, ""),
    "--image",
    `${bundle.manifest.applicationArtifacts.workerImage.repository}:${bundle.manifest.bundleVersion}`,
    "--force",
    "--output",
    "json",
  ]);
  const imported = await runner([
    "acr",
    "manifest",
    "show-metadata",
    "--registry",
    registryName,
    "--name",
    `${bundle.manifest.applicationArtifacts.workerImage.repository}:${bundle.manifest.bundleVersion}`,
    "--output",
    "json",
  ]);
  if (
    !isRecord(imported) ||
    String(imported.digest).replace(/^sha256:/, "") !==
      bundle.manifest.applicationArtifacts.workerImage.sha256
  )
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Imported worker image digest does not match the Azure bundle",
      5,
    );
  const runtimeWhatIf = await runner(
    runtimeArgs("what-if", config, bundle.manifest, bundle.runtime),
  );
  inspectWhatIf(
    runtimeWhatIf,
    config,
    bundle.manifest.changePolicy.runtimeAllowed,
    "runtime",
  );
  const runtime = await runner(
    runtimeArgs("create", config, bundle.manifest, bundle.runtime),
  );
  const resources = outputValue(runtime, "resources");
  const integration = outputValue(runtime, "integration");
  if (!isRecord(resources) || !isRecord(integration))
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Runtime deployment returned no verified integration outputs",
      4,
    );
  const callerClientId = config.identity.allowedClientApplicationIds[0]!;
  const deployResult = await localRunner(bundle.helper, [
    "--resource-group",
    config.target.resourceGroupName,
    "--function-app",
    String(resources.functionApp),
    "--storage-account",
    String(resources.storageAccount),
    "--container",
    "function-package",
    "--package",
    packagePath,
    "--sha256",
    bundle.manifest.applicationArtifacts.jobsFunctions.sha256,
    "--expected-function",
    expectedFunction,
    "--subscription-name",
    config.target.subscriptionName,
    "--profile",
    "profile-j",
    "--lifecycle",
    config.profile.deploymentMode,
    "--ingress-mode",
    config.profile.apiIngressMode,
    "--expected-api-client-id",
    config.identity.entraApplicationClientId,
    "--expected-caller-client-id",
    callerClientId,
    "--execute",
    "azure-one-deploy",
  ]);
  if (!deployResult.startsWith("Azure One Deploy completed;"))
    throw new CliError(
      "APPLICATION_DEPLOY_FAILED",
      "Azure-owned application helper returned an unexpected result",
      4,
    );
  const ownedResources = await listResourceIds(config, runner);
  const history =
    previous && previous.state === "installed"
      ? [
          { bundle: previous.bundle, integration: previous.integration },
          ...previous.history,
        ].slice(0, 2)
      : (previous?.history ?? []);
  const installed: AzureLock = {
    ...pending,
    state: "installed",
    integration: Object.fromEntries(
      Object.entries(integration).map(([key, value]) => [key, String(value)]),
    ),
    ownedResources,
    history,
  };
  await writeLock(lockPath, installed);
  return {
    action: "install",
    verified: true,
    plan,
    lockPath,
    integration: installed.integration,
    ownedResources,
  };
}

export async function azureInstall(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
  localRunner: LocalRunner = defaultLocalRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Azure install requires --yes after reviewing the exact plan",
      3,
    );
  const config = await readAzureConfig(configPath);
  const existingLock = await lstat(lockPathFor(configPath)).catch(
    () => undefined,
  );
  const previous = existingLock ? await readLock(configPath) : undefined;
  const exists = await groupExists(config, runner);
  if (exists && (!previous || previous.state === "removed"))
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Refusing to adopt an existing Azure resource group without an active exact lock",
      5,
    );
  if (
    previous &&
    previous.ownedResourceGroupId.toLowerCase() !==
      resourceGroupId(config).toLowerCase()
  )
    throw new CliError("OWNERSHIP_COLLISION", "Azure lock target changed", 5);
  return applyConfig(
    configPath,
    config,
    runner,
    localRunner,
    previous,
    artifactVerifier,
  );
}

export async function azureStatus(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAzureConfig(configPath);
  await assertIdentity(config, runner);
  const lock = await readLock(configPath);
  if (
    lock.ownedResourceGroupId.toLowerCase() !==
      resourceGroupId(config).toLowerCase() ||
    lock.installation !== config.metadata.name
  )
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Azure lock does not match config",
      5,
    );
  if (
    lock.state === "installed" &&
    (lock.bundle.version !== config.bundle.version ||
      lock.bundle.digest !== config.bundle.digest ||
      lock.configDigest !== configDigest(config))
  )
    throw new CliError(
      "CONFIG_DRIFT",
      "Azure config no longer matches the verified installation lock",
      5,
    );
  const exists = await groupExists(config, runner);
  if (!exists)
    return {
      action: "status",
      installed: false,
      state: lock.state,
      resources: [],
      missingResources: lock.ownedResources,
    };
  await assertGroupOwnership(config, runner);
  const actual = await listResourceIds(config, runner);
  const expected = [...lock.ownedResources].sort((left, right) =>
    left.localeCompare(right),
  );
  const missingResources = expected.filter((id) => !actual.includes(id));
  const unexpectedResources = actual.filter((id) => !expected.includes(id));
  return {
    action: "status",
    installed:
      lock.state === "installed" &&
      missingResources.length === 0 &&
      unexpectedResources.length === 0,
    state: lock.state,
    resources: actual,
    missingResources,
    unexpectedResources,
    integration: lock.integration,
    bundle: lock.bundle,
  };
}

export async function azureVerify(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const config = await readAzureConfig(configPath);
  const lock = await readLock(configPath);
  const bundle = await loadBundle(config.bundle.version, config.bundle.digest);
  const status = await azureStatus(configPath, runner);
  if (!status.installed)
    throw new CliError(
      "RESOURCE_DRIFT",
      "Azure installation inventory drifted",
      5,
    );
  const deployment = await runner([
    "deployment",
    "group",
    "show",
    "--subscription",
    config.target.subscriptionId,
    "--resource-group",
    config.target.resourceGroupName,
    "--name",
    `ingestron-${config.metadata.name}-runtime`,
    "--output",
    "json",
  ]);
  const integration = outputValue(deployment, "integration");
  const jobsPackage = outputValue(deployment, "jobsPackage");
  if (
    !isRecord(integration) ||
    !lock.integration ||
    !Object.entries(lock.integration).every(
      ([key, value]) => String(integration[key]) === value,
    )
  )
    throw new CliError("OUTPUT_DRIFT", "Azure integration outputs drifted", 5);
  if (
    !isRecord(jobsPackage) ||
    jobsPackage.version !==
      bundle.manifest.applicationArtifacts.jobsFunctions.version ||
    jobsPackage.sha256 !==
      bundle.manifest.applicationArtifacts.jobsFunctions.sha256
  )
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Deployed Jobs Function package metadata drifted",
      5,
    );
  const auth = await runner([
    "resource",
    "show",
    "--subscription",
    config.target.subscriptionId,
    "--ids",
    `${resourceGroupId(config)}/providers/Microsoft.Web/sites/func-ing-j-${config.profile.resourceSuffix}/config/authsettingsV2`,
    "--api-version",
    "2024-04-01",
    "--output",
    "json",
  ]);
  const authProperties =
    isRecord(auth) && isRecord(auth.properties) ? auth.properties : undefined;
  const providers =
    authProperties && isRecord(authProperties.identityProviders)
      ? authProperties.identityProviders
      : undefined;
  const aad =
    providers && isRecord(providers.azureActiveDirectory)
      ? providers.azureActiveDirectory
      : undefined;
  const registration =
    aad && isRecord(aad.registration) ? aad.registration : undefined;
  const validation =
    aad && isRecord(aad.validation) ? aad.validation : undefined;
  const policy =
    validation && isRecord(validation.defaultAuthorizationPolicy)
      ? validation.defaultAuthorizationPolicy
      : undefined;
  if (
    registration?.clientId !== config.identity.entraApplicationClientId ||
    !Array.isArray(validation?.allowedAudiences) ||
    validation.allowedAudiences.length !== 1 ||
    validation.allowedAudiences[0] !==
      `api://${config.identity.entraApplicationClientId}` ||
    !Array.isArray(policy?.allowedApplications) ||
    JSON.stringify(policy.allowedApplications) !==
      JSON.stringify(config.identity.allowedClientApplicationIds)
  )
    throw new CliError(
      "IDENTITY_DRIFT",
      "Deployed Entra audience or caller allow-list drifted",
      5,
    );
  const job = await runner([
    "containerapp",
    "job",
    "show",
    "--subscription",
    config.target.subscriptionId,
    "--resource-group",
    config.target.resourceGroupName,
    "--name",
    `job-ing-j-${config.profile.resourceSuffix}`,
    "--output",
    "json",
  ]);
  const jobProperties =
    isRecord(job) && isRecord(job.properties) ? job.properties : undefined;
  const jobTemplate =
    jobProperties && isRecord(jobProperties.template)
      ? jobProperties.template
      : undefined;
  const containers = jobTemplate?.containers;
  if (
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    !isRecord(containers[0]) ||
    containers[0].image !== targetWorkerImage(config, bundle.manifest)
  )
    throw new CliError(
      "ARTIFACT_TAMPERED",
      "Deployed worker image digest drifted",
      5,
    );
  const functions = await runner([
    "functionapp",
    "function",
    "list",
    "--subscription",
    config.target.subscriptionId,
    "--resource-group",
    config.target.resourceGroupName,
    "--name",
    `func-ing-j-${config.profile.resourceSuffix}`,
    "--output",
    "json",
  ]);
  if (
    !Array.isArray(functions) ||
    !functions.some(
      (entry) =>
        isRecord(entry) &&
        String(entry.name).split("/").at(-1) === expectedFunction,
    )
  )
    throw new CliError(
      "RUNTIME_UNHEALTHY",
      "Expected Jobs Function is absent",
      5,
    );
  return {
    action: "verify",
    valid: true,
    inventory: status.resources.length,
    integration: lock.integration,
    bundle: lock.bundle,
    applicationFunction: expectedFunction,
  };
}

async function writeConfig(path: string, config: AzureConfig) {
  await writeFile(resolve(path), stringify(config, { lineWidth: 0 }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
}

export async function azureUpgrade(
  configPath: string,
  toVersion: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
  localRunner: LocalRunner = defaultLocalRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Azure upgrade requires --yes",
      3,
    );
  const config = await readAzureConfig(configPath);
  const previous = await readLock(configPath);
  if (previous.state !== "installed")
    throw new CliError(
      "LOCK_INVALID",
      "Only an installed release can upgrade",
      5,
    );
  if (previous.bundle.version === toVersion)
    throw new CliError(
      "UPGRADE_UNNECESSARY",
      "Target bundle is already installed",
      2,
    );
  const bundle = await loadBundle(toVersion);
  const desired = {
    ...config,
    bundle: { version: toVersion, digest: bundle.manifestDigest },
  };
  const result = await applyConfig(
    configPath,
    desired,
    runner,
    localRunner,
    previous,
    artifactVerifier,
  );
  await writeConfig(configPath, desired);
  return {
    ...result,
    action: "upgrade",
    from: previous.bundle.version,
    to: toVersion,
  };
}

export async function azureRollback(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
  localRunner: LocalRunner = defaultLocalRunner,
  artifactVerifier: ArtifactVerifier = verifyArtifacts,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Azure rollback requires --yes",
      3,
    );
  const config = await readAzureConfig(configPath);
  const current = await readLock(configPath);
  const previous = current.history[0];
  if (!previous)
    throw new CliError(
      "ROLLBACK_UNAVAILABLE",
      "No verified Azure release is retained",
      5,
    );
  const desired = { ...config, bundle: previous.bundle };
  const result = await applyConfig(
    configPath,
    desired,
    runner,
    localRunner,
    current,
    artifactVerifier,
  );
  await writeConfig(configPath, desired);
  return {
    ...result,
    action: "rollback",
    from: current.bundle.version,
    to: previous.bundle.version,
  };
}

export async function azureAdfConfig(
  configPath: string,
  adfConfigPath: string,
  factoryResourceId: string,
  name?: string,
  recipePath?: string,
  runner: CommandRunner = azRunner,
) {
  const verified = await azureVerify(configPath, runner);
  const integration = verified.integration;
  if (!integration?.endpoint || !integration.audience)
    throw new CliError(
      "OUTPUT_DRIFT",
      "Verified Azure endpoint/audience are absent",
      5,
    );
  let portableRecipePath = recipePath;
  if (recipePath && isAbsolute(recipePath)) {
    portableRecipePath = relative(
      dirname(resolve(adfConfigPath)),
      resolve(recipePath),
    ).replaceAll("\\", "/");
    if (
      !portableRecipePath ||
      portableRecipePath === ".." ||
      portableRecipePath.startsWith("../")
    )
      throw new CliError(
        "CONFIG_INVALID",
        "An absolute recipe must be inside the ADF config directory",
        2,
      );
  }
  const result = await adfInit(adfConfigPath, factoryResourceId, name, {
    profile: "customer-managed",
    endpoint: integration.endpoint,
    audience: integration.audience,
    recipePath: portableRecipePath,
  });
  return { action: "adf-config", azureBundle: verified.bundle, adf: result };
}

export async function azurePlanUninstall(
  configPath: string,
  runner: CommandRunner = azRunner,
) {
  const lock = await readLock(configPath);
  const status = await azureStatus(configPath, runner);
  if (
    lock.state !== "installed" ||
    !status.installed ||
    status.missingResources.length ||
    status.unexpectedResources?.length
  )
    throw new CliError(
      "OWNERSHIP_COLLISION",
      "Exact Azure inventory is required before uninstall",
      5,
    );
  if (lock.directoryObjects.length)
    throw new CliError(
      "DIRECTORY_OWNERSHIP_UNSUPPORTED",
      "This CLI candidate does not delete adopted Entra objects",
      5,
    );
  return {
    action: "plan-uninstall",
    resourceGroup: lock.ownedResourceGroupId,
    resources: lock.ownedResources,
    directoryObjects: [],
  };
}

export async function azureUninstall(
  configPath: string,
  yes: boolean,
  runner: CommandRunner = azRunner,
) {
  if (!yes)
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Azure uninstall requires --yes",
      3,
    );
  const plan = await azurePlanUninstall(configPath, runner);
  const config = await readAzureConfig(configPath);
  const lock = await readLock(configPath);
  await runner([
    "group",
    "delete",
    "--subscription",
    config.target.subscriptionId,
    "--name",
    config.target.resourceGroupName,
    "--yes",
    "--output",
    "json",
  ]);
  if (await groupExists(config, runner))
    throw new CliError(
      "TEARDOWN_INCOMPLETE",
      "Azure resource group still exists",
      5,
    );
  await writeLock(lockPathFor(configPath), { ...lock, state: "removed" });
  return {
    action: "uninstall",
    deletedResourceGroup: plan.resourceGroup,
    deletedResources: plan.resources,
    deletedDirectoryObjects: [],
    orphanAudit: { resourceGroupExists: false, passed: true },
  };
}
