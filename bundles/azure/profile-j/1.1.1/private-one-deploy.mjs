#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const blobRole = "Storage Blob Data Contributor";
const zeroUuid = "00000000-0000-0000-0000-000000000000";

export function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected a value after ${flag ?? "the final option"}.`);
    }
    options[flag.slice(2)] = value;
  }
  const required = [
    "resource-group",
    "function-app",
    "storage-account",
    "container",
    "package",
    "sha256",
    "expected-function",
    "subscription-name",
    "execute",
  ];
  for (const name of required) {
    if (!options[name]) throw new Error(`Missing --${name}.`);
  }
  if (options.execute !== "private-one-deploy") {
    throw new Error(
      "--execute must be exactly private-one-deploy after the live plan is approved.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error("--sha256 must be a lowercase SHA-256 digest.");
  }
  options.profile ??= "developer";
  options["ingress-mode"] ??= "disabled";
  options.lifecycle ??=
    options.profile === "profile-j" ? "temporary-proof" : "developer";
  if (!["developer", "profile-j"].includes(options.profile)) {
    throw new Error("--profile must be developer or profile-j.");
  }
  if (!["disabled", "entra-public"].includes(options["ingress-mode"])) {
    throw new Error("--ingress-mode must be disabled or entra-public.");
  }
  if (
    !["developer", "temporary-proof", "persistent-demo"].includes(
      options.lifecycle,
    )
  ) {
    throw new Error(
      "--lifecycle must be developer, temporary-proof or persistent-demo.",
    );
  }
  if (
    (options.profile === "developer" && options.lifecycle !== "developer") ||
    (options.profile === "profile-j" && options.lifecycle === "developer") ||
    (options.lifecycle === "persistent-demo" &&
      options["ingress-mode"] !== "entra-public")
  ) {
    throw new Error(
      "The selected profile, lifecycle and ingress mode conflict.",
    );
  }
  if (
    options.profile === "developer" &&
    options["ingress-mode"] !== "disabled"
  ) {
    throw new Error("The Developer profile permits only disabled ingress.");
  }
  if (options.profile === "profile-j") {
    for (const name of [
      "expected-api-client-id",
      "expected-caller-client-id",
    ]) {
      if (!isLiveUuid(options[name])) {
        throw new Error(`--${name} must be a non-placeholder UUID.`);
      }
    }
  }
  return options;
}

function isLiveUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) &&
    value !== zeroUuid
  );
}

export function delegationExpiry(now = new Date()) {
  return new Date(now.getTime() + 30 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export async function packageSha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function immutablePackageBlobName(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Package SHA-256 must be a lowercase digest.");
  }
  return `sha256/${sha256}.zip`;
}

export async function retryImmutableUpload({
  expectedHash,
  upload,
  readExisting,
  now = Date.now,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 5 * 60 * 1000,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      await upload();
      return "uploaded";
    } catch {
      const existing = await readExisting();
      if (existing) {
        if (existing.metadata?.ingestron_sha256 === expectedHash) {
          return "reused";
        }
        throw new Error(
          "The immutable package name already exists with conflicting metadata.",
        );
      }
      await wait(10_000);
    }
  }
  throw new Error("Blob write access did not propagate within five minutes.");
}

function az(args, output = "json") {
  try {
    return execFileSync(
      "az",
      [...args, "--only-show-errors", "--output", output],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new Error(`Azure CLI step failed: az ${args.slice(0, 3).join(" ")}.`);
  }
}

function azJson(args) {
  const value = az(args);
  return value ? JSON.parse(value) : null;
}

async function waitForBlobAccess(
  account,
  container,
  timeoutMs = 5 * 60 * 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      azJson([
        "storage",
        "container",
        "show",
        "--account-name",
        account,
        "--name",
        container,
        "--auth-mode",
        "login",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  throw new Error(
    "Temporary Blob access did not propagate within five minutes.",
  );
}

async function waitForFunction(
  resourceGroup,
  functionApp,
  expectedFunction,
  timeoutMs = 10 * 60 * 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const functions = azJson([
      "functionapp",
      "function",
      "list",
      "--resource-group",
      resourceGroup,
      "--name",
      functionApp,
    ]);
    if (
      functions.some(
        (item) => item.name?.split("/").at(-1) === expectedFunction,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(
    "One Deploy completed without discovering the expected function.",
  );
}

async function deploy(options) {
  const expectedHash = options.sha256;
  const packageBlobName = immutablePackageBlobName(expectedHash);
  if ((await packageSha256(options.package)) !== expectedHash) {
    throw new Error("The local package does not match --sha256.");
  }

  const account = azJson(["account", "show"]);
  if (account.name !== options["subscription-name"]) {
    throw new Error(
      "The active Azure subscription does not match --subscription-name.",
    );
  }

  const group = azJson(["group", "show", "--name", options["resource-group"]]);
  const expectedProfileTag =
    options.lifecycle === "persistent-demo"
      ? "profile-j-demo"
      : options.profile;
  if (
    group.tags?.["ingestron:managed-by"] !== "bicep" ||
    group.tags?.["ingestron:profile"] !== expectedProfileTag ||
    (options.profile === "profile-j" &&
      group.tags?.["ingestron:lifecycle"] !== options.lifecycle) ||
    group.tags?.["ingestron:programme"] !== "ingestron" ||
    group.tags?.["ingestron:monthly-cost-ceiling-usd"] !== "50"
  ) {
    throw new Error(
      "The resource group is missing the required Ingestron ownership tags.",
    );
  }

  const app = azJson([
    "resource",
    "show",
    "--resource-group",
    options["resource-group"],
    "--resource-type",
    "Microsoft.Web/sites",
    "--name",
    options["function-app"],
    "--api-version",
    "2024-04-01",
  ]);
  const expectedPublicNetworkAccess =
    options["ingress-mode"] === "disabled" ? "Disabled" : "Enabled";
  if (app.properties?.publicNetworkAccess !== expectedPublicNetworkAccess) {
    throw new Error(
      `Function public network access must be ${expectedPublicNetworkAccess}.`,
    );
  }

  const auth = azJson([
    "resource",
    "show",
    "--ids",
    `${app.id}/config/authsettingsV2`,
    "--api-version",
    "2024-04-01",
  ]);
  const registration =
    auth.properties?.identityProviders?.azureActiveDirectory?.registration;
  const policy =
    auth.properties?.identityProviders?.azureActiveDirectory?.validation
      ?.defaultAuthorizationPolicy;
  const allowedAudiences =
    auth.properties?.identityProviders?.azureActiveDirectory?.validation
      ?.allowedAudiences;
  const expectedApiClientId =
    options.profile === "profile-j"
      ? options["expected-api-client-id"]
      : registration?.clientId;
  const expectedAllowedApplications =
    options.profile === "profile-j"
      ? [options["expected-caller-client-id"]]
      : policy?.allowedApplications;
  if (
    auth.properties?.platform?.enabled !== true ||
    auth.properties?.globalValidation?.requireAuthentication !== true ||
    auth.properties?.globalValidation?.unauthenticatedClientAction !==
      "Return401" ||
    registration?.clientId !== expectedApiClientId ||
    expectedApiClientId === zeroUuid ||
    JSON.stringify(allowedAudiences) !==
      JSON.stringify([`api://${expectedApiClientId}`]) ||
    !policy?.allowedApplications?.length ||
    JSON.stringify(policy?.allowedApplications) !==
      JSON.stringify(expectedAllowedApplications) ||
    policy?.allowedApplications?.includes(zeroUuid)
  ) {
    throw new Error(
      "The deployed Entra authentication allow-list is not live-ready.",
    );
  }

  if (options["ingress-mode"] === "disabled") {
    const privateEndpoints = azJson([
      "network",
      "private-endpoint",
      "list",
      "--resource-group",
      options["resource-group"],
    ]);
    const privateConnection = privateEndpoints.some((endpoint) =>
      endpoint.privateLinkServiceConnections?.some(
        (connection) =>
          connection.privateLinkServiceId?.toLowerCase() ===
            app.id.toLowerCase() && connection.groupIds?.includes("sites"),
      ),
    );
    if (!privateConnection) {
      throw new Error("No approved Function private endpoint was found.");
    }
  }

  const storage = azJson([
    "storage",
    "account",
    "show",
    "--resource-group",
    options["resource-group"],
    "--name",
    options["storage-account"],
  ]);
  if (
    storage.allowSharedKeyAccess !== false ||
    storage.allowBlobPublicAccess !== false
  ) {
    throw new Error("Storage must disable shared-key and public Blob access.");
  }

  const principal = azJson(["ad", "signed-in-user", "show"]);
  const existingRoles = azJson([
    "role",
    "assignment",
    "list",
    "--assignee-object-id",
    principal.id,
    "--scope",
    storage.id,
    "--role",
    blobRole,
  ]);
  let temporaryRoleId;
  try {
    if (existingRoles.length === 0) {
      const assignment = azJson([
        "role",
        "assignment",
        "create",
        "--assignee-object-id",
        principal.id,
        "--assignee-principal-type",
        "User",
        "--role",
        blobRole,
        "--scope",
        storage.id,
      ]);
      temporaryRoleId = assignment.id;
    }

    await waitForBlobAccess(options["storage-account"], options.container);
    const readExistingPackage = async () => {
      try {
        return azJson([
          "storage",
          "blob",
          "show",
          "--account-name",
          options["storage-account"],
          "--container-name",
          options.container,
          "--name",
          packageBlobName,
          "--auth-mode",
          "login",
        ]);
      } catch {
        return undefined;
      }
    };
    const existingPackage = await readExistingPackage();
    if (existingPackage) {
      if (existingPackage.metadata?.ingestron_sha256 !== expectedHash) {
        throw new Error(
          "The immutable package name already exists with conflicting metadata.",
        );
      }
    } else {
      await retryImmutableUpload({
        expectedHash,
        readExisting: readExistingPackage,
        upload: async () =>
          azJson([
            "storage",
            "blob",
            "upload",
            "--account-name",
            options["storage-account"],
            "--container-name",
            options.container,
            "--name",
            packageBlobName,
            "--file",
            options.package,
            "--auth-mode",
            "login",
            "--overwrite",
            "false",
            "--metadata",
            `ingestron_sha256=${expectedHash}`,
          ]),
      });
    }
    const remoteHash = az(
      [
        "storage",
        "blob",
        "show",
        "--account-name",
        options["storage-account"],
        "--container-name",
        options.container,
        "--name",
        packageBlobName,
        "--auth-mode",
        "login",
        "--query",
        "metadata.ingestron_sha256",
      ],
      "tsv",
    );
    if (remoteHash !== expectedHash) {
      throw new Error("The staged package digest metadata does not match.");
    }

    const packageUri = az(
      [
        "storage",
        "blob",
        "generate-sas",
        "--account-name",
        options["storage-account"],
        "--container-name",
        options.container,
        "--name",
        packageBlobName,
        "--permissions",
        "r",
        "--expiry",
        delegationExpiry(),
        "--https-only",
        "--as-user",
        "--auth-mode",
        "login",
        "--full-uri",
      ],
      "tsv",
    );

    const token = az(
      [
        "account",
        "get-access-token",
        "--resource",
        "https://management.azure.com/",
        "--query",
        "accessToken",
      ],
      "tsv",
    );
    const response = await fetch(
      `https://management.azure.com${app.id}/extensions/onedeploy?api-version=2022-09-01`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: { packageUri, remoteBuild: false },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`ARM One Deploy returned HTTP ${response.status}.`);
    }
    await waitForFunction(
      options["resource-group"],
      options["function-app"],
      options["expected-function"],
    );
  } finally {
    if (temporaryRoleId) {
      az(["role", "assignment", "delete", "--ids", temporaryRoleId], "none");
    }
  }

  console.log(
    "Private One Deploy completed; the expected function was discovered and temporary Blob access was removed.",
  );
}

function printHelp() {
  console.log(`Usage:
  pnpm deploy:private -- \\
    --resource-group <approved-group> \\
    --function-app <app-name> \\
    --storage-account <account-name> \\
    --container <container-name> \\
    --package <released-zip> \\
    --sha256 <expected-digest> \\
    --expected-function json-to-yaml \\
    --profile developer|profile-j \\
    --lifecycle developer|temporary-proof|persistent-demo \\
    --ingress-mode disabled|entra-public \\
    --expected-api-client-id <Profile-J-Entra-application-client-id> \\
    --expected-caller-client-id <Profile-J-ADF-managed-identity-client-id> \\
    --subscription-name <approved-subscription-name> \\
    --execute private-one-deploy

The command never prints or stores the access token or short-lived SAS.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) printHelp();
    else await deploy(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
