import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertIdentity,
  azRunner,
  readAdfConfig,
  type CommandRunner,
} from "./adf.js";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";

type SafeDataset = {
  name: string;
  domain: string;
  linkedService?: string;
  type: string;
  schemaName?: string;
  table?: string;
  path?: string;
  columns: Array<{
    name: string;
    logicalType: string;
    nullable: boolean;
  }>;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function locationPath(
  typeProperties: Record<string, unknown>,
): string | undefined {
  const location = isRecord(typeProperties.location)
    ? typeProperties.location
    : {};
  const parts = [
    stringValue(location.container),
    stringValue(location.fileSystem),
    stringValue(location.folderPath),
    stringValue(location.fileName),
  ].filter((part, index, values): part is string =>
    Boolean(part && values.indexOf(part) === index),
  );
  return parts.length > 0
    ? parts.join("/").replaceAll(/\/{2,}/g, "/")
    : undefined;
}

function columns(properties: Record<string, unknown>): SafeDataset["columns"] {
  const schema = Array.isArray(properties.schema) ? properties.schema : [];
  if (schema.length > 10_000)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "ADF dataset schema exceeds the 10,000-column discovery limit",
      4,
    );
  return schema.map((column, index) => {
    if (!isRecord(column) || typeof column.name !== "string")
      throw new CliError(
        "AZ_OUTPUT_INVALID",
        `ADF returned a malformed column at index ${index}`,
        4,
      );
    return {
      name: column.name,
      logicalType: stringValue(column.type) ?? "unknown",
      nullable: column.nullable !== false,
    };
  });
}

function safeDatasets(value: unknown, domain: string): SafeDataset[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.value)
      ? value.value
      : undefined;
  if (!entries)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Azure returned no dataset list",
      4,
    );
  if (entries.length === 0)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "The ADF factory has no datasets",
      4,
    );
  if (entries.length > 5_000)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "ADF dataset inventory exceeds the 5,000-dataset discovery limit",
      4,
    );
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== "string")
      throw new CliError(
        "AZ_OUTPUT_INVALID",
        `ADF returned a malformed dataset at index ${index}`,
        4,
      );
    const properties = isRecord(entry.properties) ? entry.properties : {};
    const linkedService = isRecord(properties.linkedServiceName)
      ? stringValue(properties.linkedServiceName.referenceName)
      : undefined;
    const typeProperties = isRecord(properties.typeProperties)
      ? properties.typeProperties
      : {};
    const schemaName = stringValue(typeProperties.schema);
    const table = stringValue(typeProperties.table);
    const path = locationPath(typeProperties);
    return {
      name: entry.name,
      domain,
      ...(linkedService ? { linkedService } : {}),
      type: stringValue(properties.type) ?? "unknown",
      ...(schemaName ? { schemaName } : {}),
      ...(table ? { table } : {}),
      ...(path ? { path } : {}),
      columns: columns(properties),
    };
  });
}

export async function adfInventoryExport(
  configPath: string,
  product: string,
  domain: string,
  outPath: string,
  runner: CommandRunner = azRunner,
) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(product))
    throw new CliError(
      "USAGE",
      "--product must be a lower-case product identifier",
    );
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(domain))
    throw new CliError(
      "USAGE",
      "--domain must be a lower-case domain identifier",
    );
  const config = await readAdfConfig(configPath);
  const target = await assertIdentity(config, runner);
  const raw = await runner([
    "datafactory",
    "dataset",
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
  const inventory = {
    contract: "ingestron.discovery.adf/v1",
    product,
    factory: target.factoryName,
    datasets: safeDatasets(raw, domain),
  };
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  if (bytes.length > 20 * 1024 * 1024)
    throw new CliError(
      "AZ_OUTPUT_INVALID",
      "Sanitised ADF inventory exceeds the 20 MiB output limit",
      4,
    );
  const absolute = resolve(outPath);
  if (await lstat(absolute).catch(() => undefined))
    throw new CliError("FILE_EXISTS", `Refusing to overwrite: ${absolute}`);
  try {
    await writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST")
      throw new CliError("FILE_EXISTS", `Refusing to overwrite: ${absolute}`);
    throw error;
  }
  return {
    action: "inventory-export",
    contract: inventory.contract,
    factory: target.factoryName,
    product,
    datasets: inventory.datasets.length,
    output: absolute,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sourceRowsReturned: false,
    securePropertiesReturned: false,
  };
}
