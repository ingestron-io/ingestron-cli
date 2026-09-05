import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

if (!process.argv[2])
  throw new Error(
    "Usage: node examples/create-transformation-proposal.mjs <new-json-file>",
  );
const bytes = await readFile(
  new URL("./phase-one-transformation.json", import.meta.url),
);
const graph = JSON.parse(bytes);
const candidate = {
  contract: "ingestron.transformation-proposal/v1",
  contractId: "orders",
  evidence: [
    {
      id: "synthetic:country-revenue-design",
      sourceDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      location: "phase-one-transformation.json · nodes and outputs",
      statement:
        "Synthetic design fixture: cast amount and revision time, select latest orders before filtering completed status, join customer country and aggregate revenue and order count.",
    },
  ],
  transformation: { nodes: graph.nodes, outputs: graph.outputs },
};
await writeFile(process.argv[2], JSON.stringify(candidate, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Created a synthetic candidate; no contract was changed or approved.",
);
