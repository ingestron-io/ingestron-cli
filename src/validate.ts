import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { CliError } from "./errors.js";
import { isRecord, readSafeFile, readYaml } from "./files.js";
import { parseRecipe } from "./recipe.js";

export async function validateRecipe(
  path: string,
): Promise<Record<string, unknown>> {
  const value = parseRecipe(await readYaml(path));
  return {
    valid: true,
    outcome: value.outcome,
    authorFields: [
      "outcome",
      "source.connection",
      "source.path",
      "destination.connection",
      "destination.path",
    ],
    defaultsResolvedBy: "execution-boundary",
  };
}

export async function checkContract(
  path: string,
): Promise<Record<string, unknown>> {
  const value = await readYaml(path);
  if (!isRecord(value) || value.contract !== "ingestron.job/v1")
    throw new CliError(
      "CONTRACT_UNSUPPORTED",
      "Expected contract ingestron.job/v1",
    );
  if (
    value.outcome === undefined ||
    value.source === undefined ||
    value.destination === undefined
  )
    throw new CliError(
      "CONTRACT_INVALID",
      "outcome, source and destination are required",
    );
  return { valid: true, contract: value.contract };
}

export async function verifyPackage(
  directory: string,
): Promise<Record<string, unknown>> {
  const root = resolve(directory);
  const manifest = JSON.parse(
    (await readSafeFile(resolve(root, "manifest.json"), 1024 * 1024)).toString(
      "utf8",
    ),
  ) as unknown;
  if (
    !isRecord(manifest) ||
    !["ingestron.dataset-package/v1", "ingestron.package/v1"].includes(
      String(manifest.contract),
    ) ||
    !Array.isArray(manifest.files)
  )
    throw new CliError("PACKAGE_INVALID", "Unsupported package manifest");
  let verified = 0;
  for (const entry of manifest.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(entry.digest))
    )
      throw new CliError(
        "PACKAGE_INVALID",
        "Each manifest file needs a safe path and sha256 digest",
      );
    const candidate = resolve(root, entry.path);
    if (!candidate.startsWith(`${root}${sep}`))
      throw new CliError(
        "PACKAGE_PATH_UNSAFE",
        `Manifest path escapes package: ${entry.path}`,
      );
    const stat = await lstat(candidate).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new CliError(
        "PACKAGE_PATH_UNSAFE",
        `Unsafe package file: ${entry.path}`,
      );
    const bytes = await readFile(candidate);
    if (bytes.length > 64 * 1024 * 1024)
      throw new CliError(
        "PACKAGE_FILE_TOO_LARGE",
        `Package file is too large: ${entry.path}`,
      );
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== entry.digest)
      throw new CliError("DIGEST_MISMATCH", `Digest mismatch: ${entry.path}`);
    if (
      entry.bytes !== undefined &&
      (!Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes.length)
    )
      throw new CliError("SIZE_MISMATCH", `Size mismatch: ${entry.path}`);
    verified++;
  }
  return { valid: true, contract: manifest.contract, filesVerified: verified };
}
