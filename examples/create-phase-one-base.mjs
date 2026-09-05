// Synthetic full-snapshot profile. Does not deploy, ingest, approve real evidence or contact Azure.
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { createLayeredBase } from "./create-layered-base.mjs";

export async function createPhaseOneBase(
  destination,
  { ownerAware = false, nativeEvidence = false } = {},
) {
  const root = await createLayeredBase(destination);
  const read = async (path) =>
    YAML.parse(await readFile(resolve(root, path), "utf8"));
  const write = async (path, value) =>
    writeFile(resolve(root, path), YAML.stringify(value));
  const order = await read("contracts/orders.yaml");
  order.schema.fields = [
    "order_id",
    "customer_id",
    "amount",
    "status",
    "updated_at",
  ].map((name) => ({ name, type: "string", required: true }));
  order.transformation = JSON.parse(
    await readFile(
      new URL("./phase-one-transformation.json", import.meta.url),
      "utf8",
    ),
  );
  await write("contracts/orders.yaml", order);
  const generator = await read("generators/databricks.yaml");
  generator.version = nativeEvidence ? "1.2.0" : "1.1.0";
  generator.contracts = ["orders"];
  Object.assign(generator.target, {
    catalog: "synthetic",
    schema: "customer360",
  });
  Object.assign(generator.handoff, {
    immutable: true,
    snapshotId: "snapshot_001",
    bronzeRootPath: "abfss://bronze@syntheticstore.dfs.core.windows.net",
  });
  await write("generators/databricks.yaml", generator);
  const adf = await read("generators/adf.yaml");
  if (ownerAware) adf.version = "1.2.1";
  adf.handoff = { snapshotId: "snapshot_001" };
  await write("generators/adf.yaml", adf);
  // Only these newly created fixture files are removed; existing destinations are rejected above.
  await rm(resolve(root, "generators/fabric.yaml"));
  await rm(resolve(root, "generators/synapse.yaml"));
  const standard = await read("standards/platform.yaml");
  if (ownerAware)
    standard.compatibility.generators.adf.versions = [
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.2.1",
    ];
  standard.compatibility.generators.databricks.versions = [
    "1.0.0",
    "1.1.0",
    ...(nativeEvidence ? ["1.2.0"] : []),
  ];
  await write("standards/platform.yaml", standard);
  const product = await read("products/customer-orders.yaml");
  product.delivery.elt.digest = `sha256:${createHash("sha256")
    .update(await readFile(resolve(root, "standards/platform.yaml")))
    .digest("hex")}`;
  await write("products/customer-orders.yaml", product);
  return root;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node examples/create-phase-one-base.mjs <new-directory> [--owner-aware] [--native-evidence]",
    );
  console.log(
    await createPhaseOneBase(process.argv[2], {
      ownerAware: process.argv.includes("--owner-aware"),
      nativeEvidence: process.argv.includes("--native-evidence"),
    }),
  );
}
