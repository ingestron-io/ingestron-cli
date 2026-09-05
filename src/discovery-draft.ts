import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { CliError } from "./errors.js";
import { isRecord, readSafeFile } from "./files.js";
import { loadContractBase } from "./project.js";
import { compilerProtocol } from "./compiler-protocol.js";

const MAX_BYTES = 20 * 1_048_576;
const ID = /^[a-z][a-z0-9._-]{0,127}$/;
const hash = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (message: string): never => {
  throw new CliError("DISCOVERY_INVALID", message);
};

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    /\{\{|\}\}|\{%|\x00/.test(value)
  )
    return fail(
      `${label} must be bounded literal metadata, not a template expression`,
    );
  return value;
}

function slug(value: unknown, label: string): string {
  const result = text(value, label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!ID.test(result))
    return fail(`${label} cannot form a stable ID; provide a valid name`);
  return result;
}

/** Preserve technical types; never invent decimal precision or coerce unknowns to strings. */
function fieldType(value: unknown): string {
  if (value === undefined) return "unknown";
  const type = text(value, "column.logicalType")
    .toLowerCase()
    .replace(/\s/g, "");
  const decimal = /^decimal\((\d+),(\d+)\)$/.exec(type);
  if (decimal) {
    const precision = Number(decimal[1]),
      scale = Number(decimal[2]);
    if (precision < 1 || precision > 38 || scale > precision)
      return fail(
        "Decimal requires 1 <= precision <= 38 and 0 <= scale <= precision",
      );
    return `decimal(${precision},${scale})`;
  }
  return [
    "string",
    "integer",
    "number",
    "boolean",
    "date",
    "timestamp",
    "binary",
    "unknown",
  ].includes(type)
    ? type
    : "unknown";
}

async function directory(
  root: string,
  path: string,
  create = false,
): Promise<string> {
  const absolute = resolve(root, path),
    rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new CliError(
      "DISCOVERY_PATH",
      "Draft directories must be below the contract base",
    );
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (create)
      await mkdir(current).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new CliError(
        "DISCOVERY_PATH",
        "Draft directories cannot contain symbolic links or files",
      );
  }
  return absolute;
}

export type DiscoveryDraftOptions = {
  sourceName?: string;
  sourceDigest?: string;
  productId?: string;
  apply?: boolean;
};

export async function draftDiscovery(
  basePath: string,
  inventoryPath: string,
  options: DiscoveryDraftOptions = {},
) {
  const requestedRoot = resolve(basePath);
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new CliError(
      "DISCOVERY_PATH",
      "Contract base must be a regular non-symbolic directory",
    );
  const bytes = await readSafeFile(inventoryPath, MAX_BYTES);
  const sourceDigest = hash(bytes);
  if (
    options.sourceDigest !== undefined &&
    options.sourceDigest !== sourceDigest
  )
    throw new CliError(
      "DISCOVERY_INTEGRITY",
      "Inventory bytes do not match the expected source digest",
    );
  const sourceName = text(
    options.sourceName ?? basename(inventoryPath),
    "sourceName",
  );
  if (basename(sourceName) !== sourceName || sourceName.includes("\\"))
    return fail("sourceName must be a filename");
  let inventory: unknown;
  try {
    inventory = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("Inventory must be valid JSON");
  }
  if (!isRecord(inventory)) return fail("Inventory must be a mapping");
  const formats: Record<string, { platform: string; collection: string }> = {
    "ingestron.discovery.adf/v1": { platform: "adf", collection: "datasets" },
    "ingestron.discovery.fabric/v1": {
      platform: "fabric",
      collection: "items",
    },
    "ingestron.discovery.databricks/v1": {
      platform: "databricks",
      collection: "tables",
    },
  };
  const format =
    typeof inventory.contract === "string"
      ? formats[inventory.contract]
      : undefined;
  if (!format) return fail("Unsupported discovery inventory contract");
  const records = inventory[format.collection];
  if (!Array.isArray(records) || records.length === 0 || records.length > 2_000)
    return fail("Discovery requires 1–2,000 metadata objects");
  const productName = text(
    inventory.product ??
      inventory.factory ??
      inventory.workspace ??
      "Discovered product",
    "product",
  );
  const productId = options.productId ?? slug(productName, "product");
  if (!ID.test(productId))
    return fail("productId must be a stable lowercase ID");
  const base = await loadContractBase(basePath);
  const contractsDirectory = await directory(
    base.root,
    base.directories.contract,
  );
  const productsDirectory = await directory(
    base.root,
    base.directories.product,
  );
  if (
    contractsDirectory === productsDirectory ||
    contractsDirectory.startsWith(`${productsDirectory}${sep}`) ||
    productsDirectory.startsWith(`${contractsDirectory}${sep}`)
  )
    return fail("Products and contracts need separate directories");
  if (base.byCategory.get("product")?.has(productId))
    throw new CliError(
      "DISCOVERY_CONFLICT",
      `Product ${productId} already exists; review changes explicitly or choose --product-id. Existing products are never replaced by discovery.`,
    );
  const files: Array<{ path: string; content: string }> = [];
  const conflicts: string[] = [];
  const importedIds: string[] = [];
  const seen = new Set<string>();
  let columns = 0;
  let unresolvedFields = 0;
  const evidence = {
    source: sourceName,
    digest: sourceDigest,
    status: "discovered",
    completeness: "unknown",
  };
  for (const [index, record] of records.entries()) {
    if (!isRecord(record)) return fail(`Object ${index} must be a mapping`);
    const id = slug(record.name, `Object ${index} name`);
    if (seen.has(id))
      return fail(
        `Duplicate normalised dataset ID ${id}; qualify names by schema`,
      );
    seen.add(id);
    if (!Array.isArray(record.columns) || record.columns.length > 2_000)
      return fail(
        `${id} columns must be an array of at most 2,000 metadata fields`,
      );
    columns += record.columns.length;
    if (columns > 100_000) return fail("Discovery exceeds 100,000 fields");
    const fieldNames = new Set<string>();
    const fields = record.columns.map((column: unknown) => {
      if (!isRecord(column)) return fail(`${id} column must be a mapping`);
      const name = text(column.name, `${id} column name`);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || fieldNames.has(name))
        return fail(`${id} has an invalid or duplicate column name`);
      fieldNames.add(name);
      if (column.nullable !== undefined && typeof column.nullable !== "boolean")
        return fail(`${id}.${name} nullable must be boolean when known`);
      const type = fieldType(column.logicalType);
      if (type === "unknown" || column.nullable === undefined)
        unresolvedFields += 1;
      const technical: Record<string, unknown> = {
        nullability:
          column.nullable === undefined
            ? "unknown"
            : column.nullable
              ? "nullable"
              : "not-null",
      };
      for (const key of ["logicalType", "nativeType"])
        if (column[key] !== undefined)
          technical[key] = text(column[key], `${id}.${name}.${key}`);
      for (const key of ["precision", "scale", "maximumLength"])
        if (column[key] !== undefined) {
          if (!Number.isInteger(column[key]) || Number(column[key]) < 0)
            return fail(`${id}.${name}.${key} must be a non-negative integer`);
          technical[key] = column[key];
        }
      for (const key of ["identity", "computed"])
        if (column[key] !== undefined) {
          if (typeof column[key] !== "boolean")
            return fail(`${id}.${name}.${key} must be boolean`);
          technical[key] = column[key];
        }
      return {
        name,
        type,
        ...(typeof column.nullable === "boolean"
          ? { required: !column.nullable }
          : {}),
        "x-discovery": technical,
      };
    });
    const source: Record<string, unknown> = { platform: format.platform };
    for (const key of ["factory", "workspace"])
      if (inventory[key] !== undefined) source[key] = text(inventory[key], key);
    for (const key of ["linkedService", "catalog"])
      if (record[key] !== undefined) source[key] = text(record[key], key);
    if (record.type !== undefined)
      source.datasetType = text(record.type, "dataset type");
    const location: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      table:
        record.table ??
        (format.platform === "databricks" ? record.name : undefined),
      schema: record.schemaName ?? record.schema,
      path: record.path,
    }))
      if (value !== undefined) location[key] = text(value, key);
    source.location = location;
    if (record.primaryKey !== undefined) {
      if (
        !Array.isArray(record.primaryKey) ||
        !record.primaryKey.length ||
        record.primaryKey.some(
          (key) => typeof key !== "string" || !fieldNames.has(key),
        ) ||
        new Set(record.primaryKey).size !== record.primaryKey.length
      )
        return fail(
          `${id} primaryKey must identify distinct discovered columns`,
        );
      source.declaredPrimaryKey = record.primaryKey;
    }
    // Validate all metadata, including conflicts, before creating any file.
    if (base.byCategory.get("contract")?.has(id)) {
      conflicts.push(id);
      continue;
    }
    importedIds.push(id);
    const document = {
      apiVersion: "datacontract.com/v1",
      kind: "DataContract",
      metadata: {
        id,
        name: text(record.name, "dataset name"),
        version: "0.1.0",
        status: "draft",
      },
      description:
        "Technical metadata draft. Ownership, business meaning and delivery policy require review.",
      source,
      schema: { fields },
      evidence: { ...evidence, pointer: `/${format.collection}/${index}` },
      review: {
        status: "required",
        questions: [
          "Confirm source metadata completeness, keys and types",
          "Set product ownership and business meaning",
          "Select target, ingestion semantics and compatible delivery standards",
        ],
      },
    };
    files.push({
      path: resolve(contractsDirectory, `${id}.yaml`),
      content: YAML.stringify(document),
    });
  }
  if (!importedIds.length)
    throw new CliError(
      "DISCOVERY_CONFLICT",
      "Every discovered dataset conflicts with an existing contract; no files changed",
    );
  files.push({
    path: resolve(productsDirectory, `${productId}.yaml`),
    content: YAML.stringify({
      schema: "https://opendataproducts.org/v4.1/schema/odps.yaml",
      version: "4.1",
      product: {
        details: {
          en: {
            name: productName,
            productID: productId,
            visibility: "organisation",
            status: "draft",
            type: "dataset",
            description:
              "Data product proposed from technical metadata; business ownership is unassigned.",
            productVersion: "0.1.0",
            governanceProfile: "structured",
          },
        },
        "x-ingestron": {
          contracts: importedIds.map((id) => `contract://${id}`),
          evidence,
          review: { status: "required" },
        },
      },
    }),
  });
  for (const file of files) {
    if (Buffer.byteLength(file.content) > 1_048_576)
      return fail("A generated draft exceeds the 1 MiB YAML limit");
    if (
      await lstat(file.path).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    )
      throw new CliError(
        "DISCOVERY_CONFLICT",
        `Draft destination already exists: ${relative(base.root, file.path)}`,
      );
  }
  if (
    base.sourceFiles.length + files.length > 10_000 ||
    base.totalBytes +
      files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) >
      128 * 1_048_576
  )
    return fail("Drafts would exceed the contract-base file or byte limit");
  const summary = {
    contract:
      compilerProtocol.commandResults[
        options.apply ? "project import-discovery" : "project draft-discovery"
      ],
    applied: options.apply === true,
    productId,
    imported: importedIds.length,
    conflicts,
    source: sourceName,
    sourceDigest,
    reviewRequired: true,
    unresolvedFields,
    completeness: "unknown",
    generatorsChanged: false,
    files: files.map((file) => ({
      path: relative(base.root, file.path).split(sep).join("/"),
      digest: hash(file.content),
    })),
  };
  if (!options.apply) return summary;
  const lock = resolve(base.root, ".ingestron-discovery.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(
        "DISCOVERY_BUSY",
        "Another discovery import or interrupted import holds the lock; inspect before retrying",
      );
    throw error;
  }
  const written: typeof files = [];
  const journal = resolve(lock, "transaction.json");
  let releaseLock = true;
  try {
    await writeFile(
      journal,
      JSON.stringify(
        {
          contract: "ingestron.discovery-transaction/v1",
          sourceDigest,
          productId,
          files: summary.files,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    // Fence changes since planning; external editors still must not race an import.
    const current = await loadContractBase(base.root);
    if (
      JSON.stringify(current.sourceFiles) !== JSON.stringify(base.sourceFiles)
    )
      throw new CliError(
        "DISCOVERY_STALE",
        "Contract base changed while discovery was being prepared; retry",
      );
    await directory(base.root, base.directories.contract, true);
    await directory(base.root, base.directories.product, true);
    for (const file of files) {
      const handle = await open(file.path, "wx", 0o600);
      written.push(file);
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
    }
    return summary;
  } catch (error) {
    for (const file of written.reverse()) {
      // Do not erase a concurrent editor's replacement while rolling back.
      try {
        const info = await lstat(file.path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info) continue;
        if (
          info.isFile() &&
          !info.isSymbolicLink() &&
          (await readFile(file.path, "utf8")) === file.content
        )
          await unlink(file.path);
        else releaseLock = false;
      } catch {
        releaseLock = false;
      }
    }
    if (!releaseLock)
      throw new CliError(
        "DISCOVERY_RECOVERY_REQUIRED",
        "Import could not be safely rolled back; inspect .ingestron-discovery.lock/transaction.json and preserve edited or partial files before retrying",
      );
    throw error;
  } finally {
    if (releaseLock) {
      await unlink(journal).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rmdir(lock);
    }
  }
}
