import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import YAML from "yaml";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";
import { resolveStandardsRelease } from "./standards-release.js";

const MANIFEST = "standards-package.yaml";
const MAX_FILE = 1_048_576;
const MAX_TOTAL = 32 * MAX_FILE;
const ID = /^[a-z][a-z0-9._-]{0,127}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
const hash = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (message: string): never => {
  throw new CliError("STANDARDS_PACKAGE_INVALID", message);
};

function mapping(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return fail(`${label}: expected exactly ${keys.join(", ")}`);
  return value;
}
function literal(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]|\{\{|\{%/.test(value)
  )
    return fail(`${label}: expected bounded literal text`);
  return value;
}
function filePath(value: unknown): string {
  const path = literal(value, "file path");
  const parts = path.split("/");
  if (
    parts.length > 16 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) ||
        part.endsWith(".") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    return fail(`Unsafe package path: ${path}`);
  return path;
}
function exactVersion(value: unknown): string {
  const version = literal(value, "version");
  if (
    !VERSION.test(version) ||
    version
      .split("-")
      .slice(1)
      .join("-")
      .split(".")
      .some((part) => /^0\d+$/.test(part))
  )
    return fail(
      "An exact semantic version is required (build metadata is not supported)",
    );
  return version;
}
async function directory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    return fail("Expected a non-symbolic directory");
  return realpath(path);
}
async function boundedRead(path: string): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE)
      return fail("Package file must be regular and at most 1 MiB");
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE) return fail("Package file exceeds 1 MiB");
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}
function parse(bytes: Buffer, label: string): unknown {
  try {
    return YAML.parse(bytes.toString("utf8"), {
      uniqueKeys: true,
      maxAliasCount: 0,
    });
  } catch {
    return fail(`${label}: invalid YAML or aliases`);
  }
}

async function inspectPackage(path: string) {
  const root = await directory(resolve(path));
  const contents = new Map<string, Buffer>();
  const folded = new Set<string>();
  let total = 0;
  let nodes = 0;
  async function walk(prefix = "") {
    for (const entry of await readdir(join(root, prefix), {
      withFileTypes: true,
    })) {
      if (++nodes > 2048) fail("Package exceeds 2048 filesystem entries");
      const name = filePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) fail(`Symbolic package entry: ${name}`);
      if (folded.has(name.toLowerCase()))
        fail(`Case-insensitive path collision: ${name}`);
      folded.add(name.toLowerCase());
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        if (contents.size >= 513)
          fail("Package exceeds 512 payload files plus manifest");
        const bytes = await boundedRead(join(root, name));
        total += bytes.length;
        if (total > MAX_TOTAL) fail("Package exceeds 32 MiB");
        contents.set(name, bytes);
      } else fail(`Unsupported package entry: ${name}`);
    }
  }
  await walk();
  const manifestBytes = contents.get(MANIFEST);
  if (!manifestBytes) fail(`Missing ${MANIFEST}`);
  const raw = mapping(
    parse(manifestBytes!, MANIFEST),
    [
      "contract",
      "id",
      "version",
      "layer",
      "publisher",
      "licence",
      "outputLicence",
      "standard",
      "files",
    ],
    MANIFEST,
  );
  if (raw.contract !== "ingestron.standards-package/v1")
    fail("Unsupported standards package contract");
  const id = literal(raw.id, "id");
  if (
    !ID.test(id) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) ||
    id.endsWith(".")
  )
    fail("Invalid package id");
  const version = exactVersion(raw.version);
  const layer = literal(raw.layer, "layer");
  if (!["organisation", "infrastructure", "elt"].includes(layer))
    fail("Invalid package layer");
  const publisher = literal(raw.publisher, "publisher");
  const licence = literal(raw.licence, "licence");
  const outputLicence = literal(raw.outputLicence, "outputLicence");
  const standard = filePath(raw.standard);
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 512)
    fail("Declare 1–512 package files");
  const declared = new Set<string>();
  const files = (raw.files as unknown[])
    .map((value) => {
      const row = mapping(
        value,
        ["path", "role", "digest", "licence", "outputLicence"],
        "file",
      );
      const name = filePath(row.path);
      if (name === MANIFEST || declared.has(name))
        fail(`Duplicate or reserved file: ${name}`);
      declared.add(name);
      const role = literal(row.role, "file.role");
      if (
        ![
          "standard",
          "template",
          "schema",
          "documentation",
          "licence",
        ].includes(role)
      )
        fail(`Unsupported role: ${role}`);
      if (
        typeof row.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(row.digest)
      )
        fail(`Invalid digest: ${name}`);
      const bytes = contents.get(name);
      if (!bytes || hash(bytes) !== row.digest)
        fail(`Missing file or digest mismatch: ${name}`);
      return {
        path: name,
        role,
        digest: row.digest as string,
        licence: literal(row.licence, "file.licence"),
        outputLicence: literal(row.outputLicence, "file.outputLicence"),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (contents.size !== files.length + 1)
    fail("Package contains unrecorded files");
  if (!files.some((file) => file.path === standard && file.role === "standard"))
    fail("Standard entry must identify a recorded standard file");
  const pack = parse(contents.get(standard)!, standard);
  if (
    !isRecord(pack) ||
    pack.apiVersion !== "ingestron.io/v1alpha1" ||
    pack.kind !== "StandardsPack" ||
    pack.layer !== layer ||
    !isRecord(pack.metadata) ||
    pack.metadata.id !== id ||
    pack.metadata.version !== version
  )
    fail("Standard identity/version/layer does not match the package");
  if (isRecord(pack))
    resolveStandardsRelease(pack.release, `${standard}.release`);
  const manifestDigest = hash(manifestBytes!);
  const digest = hash(
    JSON.stringify({
      manifestDigest,
      files: files.map(({ path, digest }) => ({ path, digest })),
    }),
  );
  return {
    contents,
    result: {
      contract: "ingestron.standards-package-verification/v1",
      valid: true,
      id,
      version,
      layer,
      publisher,
      licence,
      outputLicence,
      standard,
      manifestDigest,
      digest,
      files,
      bytes: total,
      executable: false,
      warnings: [
        licence,
        outputLicence,
        ...files.flatMap((file) => [file.licence, file.outputLicence]),
      ].includes("NOASSERTION")
        ? [
            "Licence/output terms include NOASSERTION; no distribution approval is established",
          ]
        : [],
    },
  };
}

export async function verifyStandardsPackage(
  path: string,
  expectedDigest?: string,
) {
  const { result } = await inspectPackage(path);
  if (expectedDigest !== undefined && result.digest !== expectedDigest)
    throw new CliError(
      "STANDARDS_PACKAGE_DIGEST",
      "Package differs from the reviewed digest",
    );
  return result;
}

export async function importStandardsPackage(
  path: string,
  registryPath: string,
  expectedDigest: string,
) {
  const { result, contents } = await inspectPackage(path);
  if (result.digest !== expectedDigest)
    throw new CliError(
      "STANDARDS_PACKAGE_DIGEST",
      "Package differs from the reviewed digest",
    );
  const source = await directory(resolve(path));
  let ancestor = resolve(registryPath);
  const missing: string[] = [];
  while (
    !(await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }))
  ) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const prospective = join(await realpath(ancestor), ...missing);
  const overlap = relative(source, prospective);
  if (
    !overlap ||
    (overlap !== ".." &&
      !overlap.startsWith(`..${sep}`) &&
      !isAbsolute(overlap))
  )
    throw new CliError(
      "STANDARDS_REGISTRY_PATH",
      "Registry must not be inside the source package",
    );
  await mkdir(resolve(registryPath), { recursive: true });
  const registry = await directory(resolve(registryPath));
  const guard = join(registry, ".ingestron-registry.lock");
  await mkdir(guard).catch(() => {
    throw new CliError(
      "STANDARDS_REGISTRY_LOCKED",
      "Registry is locked; inspect the writer before recovery",
    );
  });
  const staged = join(guard, "staged");
  try {
    const family = join(registry, result.id);
    await mkdir(family, { recursive: true });
    await directory(family);
    const target = join(family, result.version);
    const existing = await lstat(target).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing) {
      const prior = await verifyStandardsPackage(target);
      if (prior.digest !== result.digest)
        throw new CliError(
          "STANDARDS_RELEASE_CONFLICT",
          "This id/version already contains different bytes; publish a new version",
        );
      return {
        contract: "ingestron.standards-package-import/v1",
        imported: false,
        id: result.id,
        version: result.version,
        digest: result.digest,
        path: target,
      };
    }
    for (const [name, bytes] of contents) {
      await mkdir(dirname(join(staged, name)), { recursive: true });
      await writeFile(join(staged, name), bytes, { flag: "wx", mode: 0o600 });
    }
    await verifyStandardsPackage(staged, expectedDigest);
    await rename(staged, target);
    return {
      contract: "ingestron.standards-package-import/v1",
      imported: true,
      id: result.id,
      version: result.version,
      digest: result.digest,
      path: target,
    };
  } finally {
    await rm(staged, { recursive: true, force: true });
    await rmdir(guard);
  }
}

export async function catalogueStandardsPackages(registryPath: string) {
  const root = await directory(resolve(registryPath));
  const packages = [];
  for (const family of (await readdir(root)).sort()) {
    if (family === ".ingestron-registry.lock")
      throw new CliError(
        "STANDARDS_REGISTRY_LOCKED",
        "Registry import is active or requires recovery",
      );
    if (!ID.test(family)) fail("Unexpected entry in standards registry");
    const familyPath = await directory(join(root, family));
    for (const version of (await readdir(familyPath)).sort()) {
      exactVersion(version);
      if (packages.length >= 1024)
        fail("Registry catalogue exceeds 1024 packages");
      const entry = await verifyStandardsPackage(join(familyPath, version));
      if (entry.id !== family || entry.version !== version)
        fail("Registry folder does not match package identity");
      const { files, ...summary } = entry;
      packages.push({
        ...summary,
        fileCount: files.length,
        templateCount: files.filter((file) => file.role === "template").length,
      });
    }
  }
  return {
    contract: "ingestron.standards-package-catalogue/v1",
    packages,
    selection: "exact-version-and-digest",
    automaticUpgrade: false,
  };
}
