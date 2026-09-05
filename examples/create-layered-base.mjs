// Local synthetic example; creates new files only and makes no cloud calls.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export async function createLayeredBase(destination) {
  const root = resolve(destination);
  await mkdir(root); // Existing destinations are never overwritten.
  const template = fileURLToPath(new URL("./contract-base/", import.meta.url));
  for (const name of await readdir(template)) {
    await cp(resolve(template, name), resolve(root, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const read = async (path) =>
    YAML.parse(await readFile(resolve(root, path), "utf8"));
  const write = async (path, value) =>
    writeFile(resolve(root, path), YAML.stringify(value));
  const pin = async (id) => ({
    id,
    version: "1.0.0",
    digest: `sha256:${createHash("sha256")
      .update(await readFile(resolve(root, `standards/${id}.yaml`)))
      .digest("hex")}`,
  });
  const elt = await read("standards/platform.yaml");
  Object.assign(elt, {
    layer: "elt",
    requires: ["adf.private-source", "adls.parquet", "databricks.delta"],
    infrastructureCompatibility: [{ id: "foundation", versions: ["1.0.0"] }],
  });
  await write("standards/platform.yaml", elt);
  await write("standards/foundation.yaml", {
    apiVersion: "ingestron.io/v1alpha1",
    kind: "StandardsPack",
    layer: "infrastructure",
    metadata: {
      id: "foundation",
      name: "Synthetic shared foundation",
      version: "1.0.0",
    },
    capabilities: ["adf.private-source", "adls.parquet", "databricks.delta"],
    handoffs: ["ingestron.medallion-handoff/v1"],
    network: { sourceAccess: "adf-only" },
  });
  await write("standards/organisation.yaml", {
    apiVersion: "ingestron.io/v1alpha1",
    kind: "StandardsPack",
    layer: "organisation",
    metadata: {
      id: "organisation",
      name: "Synthetic engineering rules",
      version: "1.0.0",
    },
    allowedInfrastructure: ["foundation"],
    allowedElt: ["platform"],
    invariants: {
      infrastructure: { "network.sourceAccess": "adf-only" },
      elt: {
        "logging.includePayload": false,
        "logging.correlationId": "required",
      },
    },
  });
  const manifest = await read("ingestron.yaml");
  manifest.delivery = { organisation: await pin("organisation") };
  await write("ingestron.yaml", manifest);
  for (const id of ["dev", "test", "prod"]) {
    const environment = await read(`environments/${id}.yaml`);
    environment.delivery = { infrastructure: await pin("foundation") };
    await write(`environments/${id}.yaml`, environment);
  }
  const product = await read("products/customer-orders.yaml");
  product.delivery = { elt: await pin("platform") };
  await write("products/customer-orders.yaml", product);
  return root;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node examples/create-layered-base.mjs <new-directory>",
    );
  console.log(await createLayeredBase(process.argv[2]));
}
