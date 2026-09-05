import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";
import { loadContractBase, resolveProject } from "./project.js";
import { compileTransformation } from "./transformations.js";

const hash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (message: string): never => {
  throw new CliError("TRANSFORMATION_PROPOSAL_INVALID", message);
};
function exact(value: unknown, keys: string[]) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail(`Expected exactly: ${keys.join(", ")}`);
  return value;
}
function bounded(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    return fail("Expected bounded, non-empty text");
  return value;
}

/** Untrusted candidates are data, never tool instructions or approvals. */
export async function previewTransformation(
  basePath: string,
  environment: string,
  candidatePath: string,
) {
  const info = await lstat(candidatePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576)
    return fail("Candidate must be a regular JSON file no larger than 1 MiB");
  const bytes = await readFile(candidatePath);
  if (bytes.length > 1_048_576) return fail("Candidate exceeds 1 MiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("Candidate is not JSON");
  }
  const candidate = exact(parsed, [
    "contract",
    "contractId",
    "evidence",
    "transformation",
  ]);
  if (candidate.contract !== "ingestron.transformation-proposal/v1")
    return fail("Unsupported transformation proposal contract");
  const contractId = bounded(candidate.contractId, 128);
  if (
    !Array.isArray(candidate.evidence) ||
    !candidate.evidence.length ||
    candidate.evidence.length > 128
  )
    return fail("Provide 1–128 evidence references");
  const evidence = candidate.evidence.map((value) => {
    const item = exact(value, ["id", "sourceDigest", "location", "statement"]);
    const id = bounded(item.id, 256);
    const sourceDigest = bounded(item.sourceDigest, 71);
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceDigest))
      return fail("Evidence requires a full SHA-256 source digest");
    return {
      id,
      sourceDigest,
      location: bounded(item.location, 512),
      statement: bounded(item.statement, 4096),
    };
  });
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length)
    return fail("Evidence IDs must be unique");
  const graph = exact(candidate.transformation, ["nodes", "outputs"]);
  const base = await loadContractBase(basePath);
  const target = base.documents.find(
    (doc) => doc.category === "contract" && doc.id === contractId,
  );
  if (!target) return fail("Select an existing contract in this base");
  const resolution = await resolveProject(basePath, environment);
  const transformation = {
    contract: "ingestron.transformation/v1",
    review: {
      status: "approved",
      requirements: evidence.map((item) => item.id),
    },
    ...graph,
  };
  // Approval is hypothetical for type checking; preview never writes source.
  const plan = compileTransformation(
    transformation,
    resolution.contracts,
    contractId,
  )!;
  const source = await readFile(join(base.root, target.path));
  const targetDigest = hash(source);
  if (
    base.sourceFiles.find((file) => file.path === target.path)?.digest !==
    targetDigest
  )
    throw new CliError(
      "TRANSFORMATION_PROPOSAL_STALE",
      "Contract changed during preview; retry",
    );
  const doc = YAML.parseDocument(source.toString("utf8"), { uniqueKeys: true });
  doc.set("transformation", transformation);
  doc.set("x-ingestron-transformation-evidence", evidence);
  const proposedYaml = doc.toString();
  const review = {
    projectId: base.projectId,
    environment,
    contractId,
    path: target.path,
    targetDigest,
    sourceFiles: resolution.sourceFiles,
    evidence,
    plan,
    proposedYaml,
  };
  return {
    contract: "ingestron.transformation-review/v1" as const,
    ...review,
    reviewDigest: hash(JSON.stringify(review)),
    reviewRequired: true,
    applied: false,
    evidenceAuthenticated: false,
  };
}

export async function applyTransformation(
  basePath: string,
  environment: string,
  candidatePath: string,
  reviewedDigest: string,
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(reviewedDigest))
    return fail("An exact reviewed digest is required");
  const base = await loadContractBase(basePath);
  const lock = join(base.root, ".ingestron-transformation.lock");
  await mkdir(lock).catch(() => {
    throw new CliError(
      "TRANSFORMATION_PROPOSAL_LOCKED",
      "Another transformation edit is active; inspect the lock before recovery",
    );
  });
  const temporary = join(lock, `${randomUUID()}.yaml`);
  try {
    const review = await previewTransformation(
      basePath,
      environment,
      candidatePath,
    );
    if (review.reviewDigest !== reviewedDigest)
      throw new CliError(
        "TRANSFORMATION_PROPOSAL_STALE",
        "Candidate or base changed; review the new proposal before applying",
      );
    await writeFile(temporary, review.proposedYaml, {
      flag: "wx",
      mode: 0o600,
    });
    const latest = await previewTransformation(
      basePath,
      environment,
      candidatePath,
    );
    if (latest.reviewDigest !== reviewedDigest)
      throw new CliError(
        "TRANSFORMATION_PROPOSAL_STALE",
        "Source changed while saving; nothing was applied",
      );
    await rename(temporary, join(base.root, review.path));
    return {
      contract: "ingestron.transformation-applied/v1",
      applied: true,
      path: review.path,
      reviewedDigest,
      digest: hash(review.proposedYaml),
      validationRequired: true,
      deploymentApproved: false,
    };
  } finally {
    await rm(temporary, { force: true });
    await rmdir(lock);
  }
}
