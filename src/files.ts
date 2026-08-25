import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { CliError } from "./errors.js";

export const MAX_CONFIG_BYTES = 256 * 1024;

export async function readSafeFile(
  path: string,
  max = MAX_CONFIG_BYTES,
): Promise<Buffer> {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.isSymbolicLink())
    throw new CliError(
      "FILE_UNSAFE",
      `Expected a regular, non-symbolic file: ${absolute}`,
    );
  if (stat.size > max)
    throw new CliError(
      "FILE_TOO_LARGE",
      `File exceeds ${max} bytes: ${absolute}`,
    );
  return readFile(absolute);
}

export async function readYaml(path: string): Promise<unknown> {
  const text = (await readSafeFile(path)).toString("utf8");
  try {
    return parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new CliError(
      "YAML_INVALID",
      `Invalid or unsafe YAML: ${resolve(path)}`,
    );
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
