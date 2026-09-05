import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";

export type StandardsRelease = {
  contract: "ingestron.standards-release/v1";
  publisher: string;
  support: "experimental" | "maintained" | "deprecated";
  licence: string;
  outputLicence: string;
  compilerProtocol: "ingestron.compiler-protocol/v1";
  templates: Array<{
    id: string;
    version: string;
    engine: "ingestron-builtin";
    generator: string;
    generatorVersion: string;
    licence: string;
    outputLicence: string;
  }>;
  dependencies: Array<{
    name: string;
    version: string;
    kind: "runtime" | "library";
    licence: string;
    integrity: string;
  }>;
};
export type StandardsReleaseLock = StandardsRelease & {
  declarationDigest: string;
};

function invalid(path: string, reason: string): never {
  throw new CliError("STANDARDS_RELEASE_INVALID", `${path}: ${reason}`);
}
function mapping(
  value: unknown,
  keys: string[],
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) return invalid(path, "expected a mapping");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length)
    return invalid(path, `unknown fields: ${unknown.join(", ")}`);
  for (const key of keys)
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "required");
  return value;
}
function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\x00-\x1f]|\{\{|\{%/.test(value)
  )
    return invalid(path, "expected bounded literal text");
  return value;
}
function version(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/.test(
      result,
    )
  )
    return invalid(path, "expected an exact semantic version, not a range");
  return result;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 256)
    return invalid(path, "expected at most 256 entries");
  return value;
}

/** Validate declarations, not licence entitlement, package contents or security status. */
export function resolveStandardsRelease(
  value: unknown,
  path: string,
): StandardsReleaseLock | undefined {
  if (value === undefined) return undefined;
  const raw = mapping(
    value,
    [
      "contract",
      "publisher",
      "support",
      "licence",
      "outputLicence",
      "compilerProtocol",
      "templates",
      "dependencies",
    ],
    path,
  );
  if (raw.contract !== "ingestron.standards-release/v1")
    return invalid(path, "unsupported release contract");
  if (raw.compilerProtocol !== "ingestron.compiler-protocol/v1")
    return invalid(path, "unsupported compiler protocol");
  if (
    !["experimental", "maintained", "deprecated"].includes(String(raw.support))
  )
    return invalid(path, "unsupported support status");
  const templates: StandardsRelease["templates"] = array(
    raw.templates,
    `${path}.templates`,
  ).map((item, index) => {
    const p = `${path}.templates[${index}]`;
    const row = mapping(
      item,
      [
        "id",
        "version",
        "engine",
        "generator",
        "generatorVersion",
        "licence",
        "outputLicence",
      ],
      p,
    );
    if (row.engine !== "ingestron-builtin")
      return invalid(
        p,
        "only built-in template inventory is implemented; external execution is not supported",
      );
    if (!["adf", "databricks", "fabric"].includes(String(row.generator)))
      return invalid(p, "unknown generator implementation");
    return {
      id: text(row.id, `${p}.id`),
      version: version(row.version, `${p}.version`),
      engine: "ingestron-builtin",
      generator: String(row.generator),
      generatorVersion: version(row.generatorVersion, `${p}.generatorVersion`),
      licence: text(row.licence, `${p}.licence`),
      outputLicence: text(row.outputLicence, `${p}.outputLicence`),
    };
  });
  const dependencies: StandardsRelease["dependencies"] = array(
    raw.dependencies,
    `${path}.dependencies`,
  ).map((item, index) => {
    const p = `${path}.dependencies[${index}]`;
    const row = mapping(
      item,
      ["name", "version", "kind", "licence", "integrity"],
      p,
    );
    if (row.kind !== "runtime" && row.kind !== "library")
      return invalid(p, "kind must be runtime or library");
    const integrity = text(row.integrity, `${p}.integrity`);
    if (integrity !== "NOASSERTION" && !/^sha256:[a-f0-9]{64}$/.test(integrity))
      return invalid(p, "integrity must be sha256 or explicit NOASSERTION");
    return {
      name: text(row.name, `${p}.name`),
      version: version(row.version, `${p}.version`),
      kind: row.kind,
      licence: text(row.licence, `${p}.licence`),
      integrity,
    };
  });
  for (const [label, ids] of [
    ["templates", templates.map((item) => item.id)],
    ["dependencies", dependencies.map((item) => `${item.kind}:${item.name}`)],
  ] as const) {
    if (new Set(ids).size !== ids.length)
      invalid(`${path}.${label}`, "duplicate identities");
  }
  const release: StandardsRelease = {
    contract: "ingestron.standards-release/v1",
    publisher: text(raw.publisher, `${path}.publisher`),
    support: raw.support as StandardsRelease["support"],
    licence: text(raw.licence, `${path}.licence`),
    outputLicence: text(raw.outputLicence, `${path}.outputLicence`),
    compilerProtocol: "ingestron.compiler-protocol/v1",
    templates,
    dependencies,
  };
  return {
    ...release,
    declarationDigest: `sha256:${createHash("sha256").update(JSON.stringify(release)).digest("hex")}`,
  };
}

export function assertReleaseGenerator(
  release: StandardsReleaseLock | undefined,
  implementation: string,
  version: string,
): void {
  if (!release) return;
  if (
    !release.templates.some(
      (item) =>
        item.generator === implementation && item.generatorVersion === version,
    )
  )
    invalid(
      "release.templates",
      `no declared built-in template for ${implementation}@${version}`,
    );
}
