import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { compilerProtocol } from "./compiler-protocol.js";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";
import { loadContractBase } from "./project.js";

const hash = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function inspectStandards(basePath: string) {
  const base = await loadContractBase(basePath);
  const digest = (path: string) =>
    base.sourceFiles.find((file) => file.path === path)!.digest;
  const targets = [
    {
      id: base.projectId,
      scope: "organisation",
      path: "ingestron.yaml",
      digest: digest("ingestron.yaml"),
      pin:
        base.manifest.delivery && isRecord(base.manifest.delivery)
          ? (base.manifest.delivery.organisation ?? null)
          : null,
    },
  ];
  for (const document of base.documents) {
    if (document.category !== "environment" && document.category !== "product")
      continue;
    const canonical =
      document.category === "product" && isRecord(document.value.product);
    const container =
      canonical && isRecord(document.value.product)
        ? document.value.product["x-ingestron"]
        : document.value;
    const delivery =
      isRecord(container) && isRecord(container.delivery)
        ? container.delivery
        : {};
    const scope =
      document.category === "environment" ? "infrastructure" : "elt";
    targets.push({
      id: document.id,
      scope,
      path: document.path,
      digest: digest(document.path),
      pin: delivery[scope] ?? null,
    });
  }
  const packs = base.documents
    .filter((doc) => doc.category === "standard")
    .flatMap((doc) => {
      const metadata = isRecord(doc.value.metadata) ? doc.value.metadata : {};
      if (
        doc.value.apiVersion !== "ingestron.io/v1alpha1" ||
        doc.value.kind !== "StandardsPack" ||
        !["organisation", "infrastructure", "elt"].includes(
          String(doc.value.layer),
        ) ||
        typeof metadata.version !== "string"
      )
        return [];
      return [
        {
          id: doc.id,
          name: typeof metadata.name === "string" ? metadata.name : doc.id,
          layer: String(doc.value.layer),
          version: metadata.version,
          digest: digest(doc.path),
          path: doc.path,
        },
      ];
    });
  return {
    contract: compilerProtocol.commandResults["project inspect-standards"],
    projectId: base.projectId,
    packs,
    targets,
  };
}

export async function bindStandard(
  basePath: string,
  input: {
    scope: string;
    target: string;
    pack: string;
    expectedTargetDigest: string;
    expectedPackDigest: string;
  },
) {
  const base = await loadContractBase(basePath);
  const lock = join(base.root, ".ingestron-standards.lock");
  await mkdir(lock).catch(() => {
    throw new CliError(
      "STANDARDS_LOCKED",
      "Another binding edit is active; inspect the standards lock before recovery",
    );
  });
  const temporary = join(lock, `${randomUUID()}.yaml`);
  try {
    const catalogue = await inspectStandards(basePath);
    const target = catalogue.targets.find(
      (item) => item.scope === input.scope && item.id === input.target,
    );
    const pack = catalogue.packs.find(
      (item) => item.id === input.pack && item.layer === input.scope,
    );
    if (!target || !pack)
      throw new CliError(
        "STANDARDS_INVALID",
        "Select an existing target and a pack of the matching layer",
      );
    if (
      target.digest !== input.expectedTargetDigest ||
      pack.digest !== input.expectedPackDigest
    )
      throw new CliError(
        "STANDARDS_STALE",
        "Source changed after review; reload the catalogue before saving",
      );
    const path = join(base.root, target.path);
    const source = await readFile(path);
    if (hash(source) !== target.digest)
      throw new CliError("STANDARDS_STALE", "Target changed after review");
    const doc = YAML.parseDocument(source.toString("utf8"), {
      uniqueKeys: true,
    });
    const canonical = input.scope === "elt" && doc.has("product");
    const keys = [
      ...(canonical ? ["product", "x-ingestron"] : []),
      "delivery",
      input.scope,
    ];
    const pin = { id: pack.id, version: pack.version, digest: pack.digest };
    doc.setIn(keys, pin);
    const content = doc.toString();
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    // Re-run safe path checks immediately before publishing the single-file edit.
    const latest = await inspectStandards(basePath);
    if (
      latest.targets.find((item) => item.path === target.path)?.digest !==
        target.digest ||
      latest.packs.find((item) => item.id === pack.id)?.digest !== pack.digest
    )
      throw new CliError(
        "STANDARDS_STALE",
        "Sources changed while saving; nothing was updated",
      );
    await rename(temporary, path);
    return {
      contract: compilerProtocol.commandResults["project bind-standard"],
      applied: true,
      path: target.path,
      pin,
      digest: hash(content),
      validationRequired: true,
      generatorsChanged: false,
    };
  } finally {
    await rm(temporary, { force: true });
    await rmdir(lock);
  }
}
