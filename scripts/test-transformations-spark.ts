import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { compileTransformation } from "../src/transformations.js";
import {
  transformationRuntime,
  transformationNotebook,
} from "../src/transformation-runtime.js";

const graph = JSON.parse(
  await readFile("examples/phase-one-transformation.json", "utf8"),
);
const contracts = Object.fromEntries(
  Object.entries({
    orders: ["order_id", "customer_id", "amount", "status", "updated_at"],
    customers: ["customer_id", "country_code"],
  }).map(([id, names]) => [
    id,
    {
      schema: {
        fields: names.map((name) => ({ name, type: "string", required: true })),
      },
    },
  ]),
);
const plan = compileTransformation(graph, contracts, "orders")!;
const root = await mkdtemp(join(tmpdir(), "ingestron-spark-conformance-"));
try {
  await writeFile(join(root, "runtime.py"), transformationRuntime);
  await writeFile(join(root, "plan.json"), JSON.stringify(plan));
  await writeFile(
    join(root, "notebook.py"),
    transformationNotebook(
      plan,
      { orders: "/synthetic/orders", customers: "/synthetic/customers" },
      "parquet",
      "synthetic",
      "orders",
    ),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.env.INGESTRON_SPARK_PYTHON ?? "python3",
    [resolve("test/fixtures/transformations-spark.py"), root],
    {
      env: { ...process.env, SPARK_LOCAL_IP: "127.0.0.1" },
      timeout: 240_000,
      maxBuffer: 4 * 1_048_576,
    },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(root, { recursive: true, force: true });
}
