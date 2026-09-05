import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

/** Synthetic inspection fixture; not a runnable or licensed delivery standard. */
export async function createStandardsPackage(destination, version = "1.0.0") {
  const files = {
    "standard.yaml": YAML.stringify({
      apiVersion: "ingestron.io/v1alpha1",
      kind: "StandardsPack",
      layer: "elt",
      metadata: {
        id: "synthetic-relational",
        name: "Synthetic relational example",
        version,
      },
    }),
    "templates/inspect.sql.jinja":
      "-- Synthetic template for inspection only. Not wired to a generator.\nSELECT {{ inputs.column_name }} FROM {{ inputs.source_table }};\n",
    "README.md":
      "# Synthetic standards package\n\nFor local package verification and version-selection tests only. No native pipeline, licence clearance or deployment is claimed.\n",
  };
  const manifest = {
    contract: "ingestron.standards-package/v1",
    id: "synthetic-relational",
    version,
    layer: "elt",
    publisher: "Synthetic fixture",
    licence: "NOASSERTION",
    outputLicence: "NOASSERTION",
    standard: "standard.yaml",
    files: Object.entries(files).map(([path, content]) => ({
      path,
      role:
        path === "standard.yaml"
          ? "standard"
          : path.startsWith("templates/")
            ? "template"
            : "documentation",
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      licence: "NOASSERTION",
      outputLicence: "NOASSERTION",
    })),
  };
  await mkdir(destination);
  for (const [path, content] of Object.entries({
    ...files,
    "standards-package.yaml": YAML.stringify(manifest),
  })) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), content, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node examples/create-standards-package.mjs <new-directory> [version]",
    );
  await createStandardsPackage(resolve(process.argv[2]), process.argv[3]);
}
