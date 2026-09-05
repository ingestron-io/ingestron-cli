import { CliError } from "./errors.js";

/** Implemented compatibility profiles, not independently downloaded packages. */
const builtins = [
  {
    implementation: "adf",
    versions: ["1.0.0", "1.1.0", "1.2.0", "1.2.1"],
    targets: ["adf", "synapse"],
  },
  {
    implementation: "databricks",
    versions: ["1.0.0", "1.1.0"],
    targets: ["databricks"],
  },
  { implementation: "fabric", versions: ["1.0.0"], targets: ["fabric"] },
] as const;

export function generatorCatalogue() {
  return {
    contract: "ingestron.generator-catalogue/v1",
    execution: "cli-builtin",
    externalPackagesSupported: false,
    generators: builtins.map((entry) => ({
      implementation: entry.implementation,
      versions: [...entry.versions],
      targets: [...entry.targets],
    })),
  };
}

export function requireBuiltinGenerator(
  implementation: unknown,
  version: unknown,
) {
  const entry = builtins.find((item) => item.implementation === implementation);
  if (!entry)
    throw new CliError(
      "GENERATOR_UNSUPPORTED",
      `Unsupported built-in generator ${String(implementation)}`,
    );
  // Omission preserves the original 1.0.0 default; malformed explicit values do not.
  const selected = version === undefined ? "1.0.0" : version;
  if (
    typeof selected !== "string" ||
    !(entry.versions as readonly string[]).includes(selected)
  )
    throw new CliError(
      "GENERATOR_VERSION_UNSUPPORTED",
      `Unsupported ${entry.implementation} version ${String(selected)}; installed versions: ${entry.versions.join(", ")}`,
    );
  return { implementation: entry.implementation, version: selected };
}
