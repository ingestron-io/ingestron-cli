import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import YAML from "yaml";
import { CliError } from "./errors.js";
import { renderTemplateValue } from "./template.js";
import { compilerProtocol } from "./compiler-protocol.js";
import { assertReleaseGenerator } from "./standards-release.js";
import { requireBuiltinGenerator } from "./generator-catalogue.js";
import {
  compileTransformation,
  type TransformationPlan,
} from "./transformations.js";
import { transformationNotebook } from "./transformation-runtime.js";
import {
  assertDeliverySelection,
  resolveDeliveryStandards,
  type DeliveryStandards,
} from "./layered-standards.js";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 128 * 1_048_576;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const ID = /^[a-z][a-z0-9._-]{0,127}$/;

type Category =
  "product" | "contract" | "standard" | "generator" | "environment";

type Document = {
  category: Category;
  id: string;
  path: string;
  value: Record<string, unknown>;
};

type ProjectManifest = Record<string, unknown> & {
  apiVersion?: string;
  kind?: string;
  metadata?: { id?: string; name?: string };
  paths?: Partial<Record<`${Category}s`, string>>;
  inputs?: Record<
    string,
    { type?: string; default?: unknown; required?: boolean }
  >;
};

export type ProjectResolution = {
  contract: (typeof compilerProtocol.commandResults)["project resolve"];
  basePath: string;
  project: { id: string; name: string };
  environment: string;
  deliveryStandards?: DeliveryStandards;
  digest: string;
  inputs: Record<string, unknown>;
  products: Record<string, Record<string, unknown>>;
  contracts: Record<string, Record<string, unknown>>;
  standards: Record<string, Record<string, unknown>>;
  generators: Record<string, Record<string, unknown>>;
  sourceFiles: Array<{
    path: string;
    digest: string;
    category?: Category;
    id?: string;
  }>;
  findings: Array<{
    severity: "warning" | "error";
    code: string;
    message: string;
    path?: string;
  }>;
};

export type GenerationPlan = {
  contract: (typeof compilerProtocol.commandResults)["gen plan"];
  resolutionDigest: string;
  environment: string;
  deliveryStandards?: DeliveryStandards;
  generator: {
    id: string;
    implementation: string;
    version: string;
    digest: string;
  };
  standards: Array<{
    id: string;
    version: string;
    digest: string;
  }>;
  products: string[];
  contracts: string[];
  assets: Array<{
    assetId: string;
    transformation?: TransformationPlan;
    source: Record<string, unknown>;
    target: {
      name: string;
      type: string;
      configuration: Record<string, unknown>;
    };
    controls: Record<string, unknown>;
  }>;
  planDigest: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value))
    throw new CliError(
      "PROJECT_INVALID",
      `${label} must be a stable lowercase ID`,
    );
  return value;
}

async function safeRoot(path: string): Promise<string> {
  const stat = await lstat(resolve(path));
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CliError(
      "PROJECT_PATH",
      "Contract base must be a regular directory",
    );
  return realpath(resolve(path));
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value === "" ||
    (!isAbsolute(value) && !value.startsWith(`..${sep}`) && value !== "..")
  );
}

async function readSafeYaml(
  root: string,
  path: string,
): Promise<{ value: unknown; bytes: Buffer; relativePath: string }> {
  const absolute = resolve(root, path);
  if (!inside(root, absolute))
    throw new CliError("PROJECT_PATH", `Path escapes contract base: ${path}`);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new CliError("PROJECT_PATH", `Expected a regular file: ${path}`);
  if (stat.size > MAX_FILE_BYTES)
    throw new CliError("PROJECT_LIMIT", `YAML file exceeds 1 MiB: ${path}`);
  const bytes = await readFile(absolute);
  let value: unknown;
  try {
    value = YAML.parse(bytes.toString("utf8"), { maxAliasCount: 0 });
  } catch (error) {
    throw new CliError(
      "PROJECT_YAML",
      `Invalid YAML in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    value,
    bytes,
    relativePath: relative(root, absolute).split(sep).join("/"),
  };
}

async function yamlFiles(root: string, directory: string): Promise<string[]> {
  const start = resolve(root, directory);
  if (!inside(root, start))
    throw new CliError(
      "PROJECT_PATH",
      `Directory escapes contract base: ${directory}`,
    );
  let current = root;
  for (const part of relative(root, start).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return [];
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CliError(
        "PROJECT_PATH",
        `Expected a non-symbolic directory: ${directory}`,
      );
  }
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink())
        throw new CliError(
          "PROJECT_PATH",
          `Symbolic links are forbidden: ${entry.name}`,
        );
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        output.push(relative(root, child).split(sep).join("/"));
        if (output.length > MAX_FILES)
          throw new CliError(
            "PROJECT_LIMIT",
            `Contract base exceeds ${MAX_FILES} YAML files`,
          );
      }
    }
  }
  try {
    await visit(start);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return output;
}

function pointer(value: unknown, fragment: string, reference: string): unknown {
  if (fragment === "" || fragment === "/") return value;
  if (!fragment.startsWith("/"))
    throw new CliError(
      "REFERENCE_INVALID",
      `Invalid JSON pointer in ${reference}`,
    );
  let current = value;
  for (const segment of fragment
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current) && /^\d+$/.test(segment))
      current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment))
      current = current[segment];
    else
      throw new CliError(
        "REFERENCE_MISSING",
        `Missing reference target ${reference}`,
      );
  }
  return structuredClone(current);
}

function documentId(value: Record<string, unknown>, path: string): string {
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  return safeId(
    metadata.id ?? value.id ?? basename(path).replace(/\.ya?ml$/i, ""),
    path,
  );
}

function resolveInputs(
  manifest: ProjectManifest,
  supplied: Record<string, string>,
): Record<string, unknown> {
  const definitions = isRecord(manifest.inputs) ? manifest.inputs : {};
  const unknown = Object.keys(supplied).filter(
    (key) => !Object.hasOwn(definitions, key),
  );
  if (unknown.length > 0)
    throw new CliError(
      "INPUT_UNKNOWN",
      `Undeclared inputs: ${unknown.join(", ")}`,
    );
  const output: Record<string, unknown> = {};
  for (const [name, rawDefinition] of Object.entries(definitions)) {
    const definition = isRecord(rawDefinition) ? rawDefinition : {};
    const raw = supplied[name];
    if (raw === undefined) {
      if (Object.hasOwn(definition, "default"))
        output[name] = definition.default;
      else if (definition.required === true)
        throw new CliError(
          "INPUT_REQUIRED",
          `Declared input ${name} is required`,
        );
      continue;
    }
    switch (definition.type) {
      case "number": {
        const value = Number(raw);
        if (!Number.isFinite(value))
          throw new CliError("INPUT_TYPE", `Input ${name} must be a number`);
        output[name] = value;
        break;
      }
      case "boolean":
        if (!/^(true|false)$/.test(raw))
          throw new CliError(
            "INPUT_TYPE",
            `Input ${name} must be true or false`,
          );
        output[name] = raw === "true";
        break;
      case "string":
      case undefined:
        output[name] = raw;
        break;
      default:
        throw new CliError("INPUT_TYPE", `Unsupported input type for ${name}`);
    }
  }
  return output;
}

function renderTree(
  value: unknown,
  context: Record<string, unknown>,
  state = { nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH)
    throw new CliError(
      "PROJECT_LIMIT",
      "Resolved project exceeds node/depth limits",
    );
  if (typeof value === "string") return renderTemplateValue(value, context);
  if (Array.isArray(value))
    return value.map((item) => renderTree(item, context, state, depth + 1));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderTree(item, context, state, depth + 1),
      ]),
    );
  return value;
}

function containsTemplate(value: unknown): boolean {
  if (typeof value === "string")
    return value.includes("{{") || value.includes("}}");
  if (Array.isArray(value)) return value.some(containsTemplate);
  return isRecord(value) && Object.values(value).some(containsTemplate);
}

/** Shared, unresolved source inventory for compilation and draft authoring. */
export async function loadContractBase(basePath: string) {
  const root = await safeRoot(basePath);
  const manifestFile = await readSafeYaml(root, "ingestron.yaml");
  if (!isRecord(manifestFile.value))
    throw new CliError("PROJECT_INVALID", "ingestron.yaml must be a mapping");
  const manifest = manifestFile.value as ProjectManifest;
  if (manifest.kind !== "ContractBase")
    throw new CliError(
      "PROJECT_INVALID",
      "ingestron.yaml kind must be ContractBase",
    );
  const projectId = safeId(manifest.metadata?.id, "metadata.id");
  const projectName =
    typeof manifest.metadata?.name === "string"
      ? manifest.metadata.name
      : projectId;
  const pathConfig = isRecord(manifest.paths) ? manifest.paths : {};
  const directories: Record<Category, string> = {
    product:
      typeof pathConfig.products === "string"
        ? pathConfig.products
        : "products",
    contract:
      typeof pathConfig.contracts === "string"
        ? pathConfig.contracts
        : "contracts",
    standard:
      typeof pathConfig.standards === "string"
        ? pathConfig.standards
        : "standards",
    generator:
      typeof pathConfig.generators === "string"
        ? pathConfig.generators
        : "generators",
    environment:
      typeof pathConfig.environments === "string"
        ? pathConfig.environments
        : "environments",
  };
  const sourceFiles: ProjectResolution["sourceFiles"] = [
    { path: manifestFile.relativePath, digest: digest(manifestFile.bytes) },
  ];
  let totalBytes = manifestFile.bytes.length;
  const documents: Document[] = [];
  const byPath = new Map<string, Document>();
  const byCategory = new Map<Category, Map<string, Document>>();
  for (const category of Object.keys(directories) as Category[]) {
    const registry = new Map<string, Document>();
    byCategory.set(category, registry);
    for (const path of await yamlFiles(root, directories[category])) {
      const file = await readSafeYaml(root, path);
      totalBytes += file.bytes.length;
      if (sourceFiles.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES)
        throw new CliError(
          "PROJECT_LIMIT",
          `Contract base exceeds ${MAX_FILES} YAML files or 128 MiB`,
        );
      if (!isRecord(file.value))
        throw new CliError("PROJECT_INVALID", `${path} must contain a mapping`);
      const id = documentId(file.value, path);
      if (registry.has(id))
        throw new CliError(
          "PROJECT_DUPLICATE",
          `Duplicate ${category} ID ${id}`,
        );
      const document = { category, id, path, value: file.value };
      registry.set(id, document);
      byPath.set(path, document);
      documents.push(document);
      sourceFiles.push({ path, digest: digest(file.bytes), category, id });
    }
  }
  return {
    root,
    manifest,
    projectId,
    projectName,
    directories,
    totalBytes,
    sourceFiles,
    documents,
    byPath,
    byCategory,
  };
}

export async function resolveProject(
  basePath: string,
  environmentId: string,
  suppliedInputs: Record<string, string> = {},
): Promise<ProjectResolution> {
  const {
    root,
    manifest,
    projectId,
    projectName,
    sourceFiles,
    documents,
    byPath,
    byCategory,
  } = await loadContractBase(basePath);
  const environment = byCategory.get("environment")?.get(environmentId);
  if (!environment)
    throw new CliError(
      "ENVIRONMENT_MISSING",
      `Unknown environment ${environmentId}`,
    );
  const inputs = resolveInputs(manifest, suppliedInputs);

  function resolveReference(reference: string, stack: string[]): unknown {
    const hashIndex = reference.indexOf("#");
    const target = hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
    const fragment = hashIndex >= 0 ? reference.slice(hashIndex + 1) : "";
    let document: Document | undefined;
    if (target.startsWith("file://")) document = byPath.get(target.slice(7));
    else if (target === "env://current") document = environment;
    else {
      const match = target.match(
        /^(product|contract|standard|generator):\/\/(.+)$/,
      );
      if (match)
        document = byCategory.get(match[1] as Category)?.get(match[2]!);
    }
    if (!document)
      throw new CliError("REFERENCE_MISSING", `Unknown reference ${reference}`);
    const key = `${document.path}#${fragment}`;
    if (stack.includes(key))
      throw new CliError(
        "REFERENCE_CYCLE",
        `Reference cycle: ${[...stack, key].join(" -> ")}`,
      );
    return resolveReferences(
      pointer(document.value, fragment, reference),
      document,
      [...stack, key],
    );
  }

  function resolveReferences(
    value: unknown,
    owner: Document,
    stack: string[],
  ): unknown {
    if (Array.isArray(value))
      return value.map((item) => resolveReferences(item, owner, stack));
    if (!isRecord(value)) return value;
    if (Object.hasOwn(value, "$ref")) {
      if (Object.keys(value).length !== 1 || typeof value.$ref !== "string")
        throw new CliError(
          "REFERENCE_INVALID",
          `$ref must be the only key in ${owner.path}`,
        );
      return resolveReference(value.$ref, stack);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, owner, stack),
      ]),
    );
  }

  let resolved = new Map<Document, Record<string, unknown>>(
    documents.map((document) => [
      document,
      resolveReferences(document.value, document, [document.path]) as Record<
        string,
        unknown
      >,
    ]),
  );

  for (let pass = 0; pass < 8; pass += 1) {
    const maps = Object.fromEntries(
      (["product", "contract", "standard", "generator"] as Category[]).map(
        (category) => [
          `${category}s`,
          Object.fromEntries(
            [...(byCategory.get(category)?.values() ?? [])].map((document) => [
              document.id,
              resolved.get(document),
            ]),
          ),
        ],
      ),
    ) as Record<string, Record<string, unknown>>;
    const next = new Map<Document, Record<string, unknown>>();
    for (const document of documents) {
      const context: Record<string, unknown> = {
        base: manifest,
        env: resolved.get(environment),
        inputs,
        ...maps,
        product:
          document.category === "product" ? resolved.get(document) : undefined,
        contract:
          document.category === "contract" ? resolved.get(document) : undefined,
        generator:
          document.category === "generator"
            ? resolved.get(document)
            : undefined,
      };
      next.set(
        document,
        renderTree(resolved.get(document), context) as Record<string, unknown>,
      );
    }
    if (canonical([...next.values()]) === canonical([...resolved.values()])) {
      resolved = next;
      break;
    }
    resolved = next;
  }
  for (const [document, value] of resolved)
    if (containsTemplate(value))
      throw new CliError(
        "EXPRESSION_UNRESOLVED",
        `Unresolved or cyclic template expression in ${document.path}`,
      );

  const mapFor = (category: Category) =>
    Object.fromEntries(
      [...(byCategory.get(category)?.values() ?? [])].map((document) => [
        document.id,
        resolved.get(document)!,
      ]),
    );
  const products = mapFor("product");
  const contracts = mapFor("contract");
  const standards = mapFor("standard");
  const generators = mapFor("generator");
  const deliveryStandards = resolveDeliveryStandards({
    manifest,
    environment: resolved.get(environment)!,
    products,
    sources: documents
      .filter((document) => document.category === "standard")
      .map((document) => ({
        id: document.id,
        value: document.value,
        digest: sourceFiles.find((file) => file.path === document.path)!.digest,
      })),
  });
  const findings: ProjectResolution["findings"] = [];
  if (deliveryStandards) {
    const pins = [
      deliveryStandards.organisation,
      deliveryStandards.infrastructure,
      ...Object.values(deliveryStandards.products).map(
        (product) => product.elt,
      ),
    ];
    for (const pin of new Map(pins.map((pin) => [pin.id, pin])).values()) {
      const release = pin.release;
      if (!release) continue;
      if (
        release.licence === "NOASSERTION" ||
        release.outputLicence === "NOASSERTION" ||
        release.templates.some(
          (item) =>
            item.licence === "NOASSERTION" ||
            item.outputLicence === "NOASSERTION",
        ) ||
        release.dependencies.some(
          (item) =>
            item.licence === "NOASSERTION" || item.integrity === "NOASSERTION",
        )
      ) {
        findings.push({
          severity: "warning",
          code: "STANDARDS_RELEASE_UNVERIFIED",
          path: pin.id,
          message: `Standard ${pin.id} contains unknown licence or integrity declarations; source generation is not distribution clearance`,
        });
      }
      if (release.support === "deprecated")
        findings.push({
          severity: "warning",
          code: "STANDARDS_RELEASE_DEPRECATED",
          path: pin.id,
          message: `Standard ${pin.id} is declared deprecated; review migration before use`,
        });
    }
  }
  for (const [id, contract] of Object.entries(contracts)) {
    if (contract.transformation !== undefined) {
      try {
        compileTransformation(contract.transformation, contracts, id);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        findings.push({
          severity: "error",
          code: error.code,
          message: error.message,
          path: id,
        });
      }
    }
    if (isRecord(contract.review) && contract.review.status === "required")
      findings.push({
        severity: "warning",
        code: "DISCOVERY_REVIEW_REQUIRED",
        message: `Contract ${id} is a discovery draft; review source facts and set delivery policy before generation`,
        path: id,
      });
  }
  if (Object.keys(products).length === 0)
    findings.push({
      severity: "warning",
      code: "NO_PRODUCTS",
      message: "No data products found",
    });
  if (Object.keys(contracts).length === 0)
    findings.push({
      severity: "warning",
      code: "NO_CONTRACTS",
      message: "No data contracts found",
    });
  if (Object.keys(generators).length === 0)
    findings.push({
      severity: "warning",
      code: "NO_GENERATORS",
      message: "No generators configured",
    });

  const body = {
    manifest,
    environment: resolved.get(environment),
    inputs,
    products,
    contracts,
    standards,
    generators,
    sourceFiles,
  };
  return {
    contract: compilerProtocol.commandResults["project resolve"],
    ...(deliveryStandards ? { deliveryStandards } : {}),
    basePath: root,
    project: { id: projectId, name: projectName },
    environment: environmentId,
    digest: digest(canonical(body)),
    inputs,
    products,
    contracts,
    standards,
    generators,
    sourceFiles,
    findings,
  };
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new CliError(
      "GENERATOR_INVALID",
      "Generator selections must be string arrays",
    );
  return value as string[];
}

function assetName(contract: Record<string, unknown>, id: string): string {
  const target = isRecord(contract.target) ? contract.target : {};
  const value = target.name ?? contract.name ?? id.replaceAll(/[.-]/g, "_");
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value))
    throw new CliError(
      "GENERATOR_INVALID",
      `Unsafe target name for contract ${id}`,
    );
  return value;
}

function generationStandards(
  config: Record<string, unknown>,
  project: ProjectResolution,
  generatorId: string,
  implementation: string,
  version: string,
): GenerationPlan["standards"] {
  const ids = stringArray(config.standards, Object.keys(project.standards));
  return ids.map((id) => {
    const standard = project.standards[id];
    if (!standard)
      throw new CliError(
        "GENERATOR_STANDARD",
        `Generator ${generatorId} selects unknown standards pack ${id}`,
      );
    const metadata = isRecord(standard.metadata) ? standard.metadata : {};
    const standardVersion =
      typeof metadata.version === "string" ? metadata.version : "1.0.0";
    const compatibility = isRecord(standard.compatibility)
      ? standard.compatibility
      : {};
    const generators = isRecord(compatibility.generators)
      ? compatibility.generators
      : {};
    const compatibilityEntry = isRecord(generators[generatorId])
      ? generators[generatorId]
      : isRecord(generators[implementation])
        ? generators[implementation]
        : undefined;
    if (compatibilityEntry) {
      const versions = stringArray(compatibilityEntry.versions, []);
      if (versions.length > 0 && !versions.includes(version))
        throw new CliError(
          "GENERATOR_STANDARD",
          `Standards pack ${id} ${standardVersion} does not support ${generatorId} ${version}`,
        );
    }
    return {
      id,
      version: standardVersion,
      digest: digest(canonical(standard)),
    };
  });
}

export async function planGeneration(
  basePath: string,
  environment: string,
  generatorId: string,
  suppliedInputs: Record<string, string> = {},
): Promise<GenerationPlan> {
  const project = await resolveProject(basePath, environment, suppliedInputs);
  const config = project.generators[generatorId];
  if (!config)
    throw new CliError("GENERATOR_MISSING", `Unknown generator ${generatorId}`);
  const { implementation, version } = requireBuiltinGenerator(
    config.implementation,
    config.version,
  );
  const standards = generationStandards(
    config,
    project,
    generatorId,
    implementation,
    version,
  );
  const products = stringArray(config.products, Object.keys(project.products));
  if (
    isRecord(config.handoff) &&
    config.handoff.snapshotId !== undefined &&
    (typeof config.handoff.snapshotId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(config.handoff.snapshotId))
  )
    throw new CliError(
      "GENERATOR_INVALID",
      "handoff.snapshotId must be a safe explicit snapshot identifier",
    );
  const contracts = stringArray(
    config.contracts,
    Object.keys(project.contracts),
  );
  for (const id of products)
    if (!project.products[id])
      throw new CliError("GENERATOR_SELECTION", `Unknown product ${id}`);
  for (const id of contracts)
    if (!project.contracts[id])
      throw new CliError("GENERATOR_SELECTION", `Unknown contract ${id}`);
  const eltId = assertDeliverySelection(
    project.deliveryStandards,
    products,
    standards.map((standard) => standard.id),
  );
  if (eltId) {
    for (const id of products)
      assertReleaseGenerator(
        project.deliveryStandards?.products[id]?.elt.release,
        implementation,
        version,
      );
    if (
      standards.some(
        (standard) =>
          project.standards[standard.id]?.layer === "elt" &&
          standard.id !== eltId,
      )
    )
      throw new CliError(
        "STANDARDS_INCOMPATIBLE",
        "Generator selects an ELT pack outside its products' pinned release",
      );
    const ownedContracts = new Set(
      products.flatMap((id) => productContractIds(project.products[id]!)),
    );
    for (const id of contracts)
      if (!ownedContracts.has(id))
        throw new CliError(
          "STANDARDS_INCOMPATIBLE",
          `Contract ${id} is not owned or referenced by the selected products`,
        );
  }
  const assets = contracts.map((id) => {
    const contract = project.contracts[id]!;
    const transformation =
      implementation === "databricks"
        ? compileTransformation(contract.transformation, project.contracts, id)
        : undefined;
    if (contract.transformation !== undefined && implementation === "fabric")
      throw new CliError(
        "TRANSFORMATION_UNSUPPORTED",
        "Typed transformations are implemented for Databricks only; ADF is the landing bridge",
      );
    if (transformation && !["1.1.0", "1.2.0", "1.3.0"].includes(version))
      throw new CliError(
        "TRANSFORMATION_UNSUPPORTED",
        "Typed transformations require Databricks generator 1.1.0, 1.2.0 or 1.3.0",
      );
    if (
      implementation === "databricks" &&
      ["1.1.0", "1.2.0", "1.3.0"].includes(version) &&
      !transformation
    )
      throw new CliError(
        "TRANSFORMATION_INVALID",
        `Databricks ${version} requires an explicit reviewed transformation for ${id}`,
      );
    if (transformation) {
      const handoff = isRecord(config.handoff) ? config.handoff : {};
      const target = isRecord(config.target) ? config.target : {};
      if (
        handoff.immutable !== true ||
        typeof handoff.snapshotId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(handoff.snapshotId) ||
        typeof handoff.bronzeRootPath !== "string" ||
        !handoff.bronzeRootPath ||
        handoff.bronzeRootPath.includes("__BIND")
      )
        throw new CliError(
          "TRANSFORMATION_INVALID",
          "Typed generation requires an explicitly immutable snapshotId and bronzeRootPath handoff",
        );
      for (const key of ["catalog", "schema"])
        if (
          typeof target[key] !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(String(target[key]))
        )
          throw new CliError(
            "TRANSFORMATION_INVALID",
            `Typed generation requires an explicit target.${key}`,
          );
    }
    if (implementation === "adf" && version === "1.3.0") {
      const source = isRecord(contract.source) ? contract.source : {};
      const incremental = isRecord(source.incremental)
        ? source.incremental
        : undefined;
      const sourceAdf = isRecord(source.adf) ? source.adf : {};
      const target = isRecord(contract.target) ? contract.target : {};
      const targetAdf = isRecord(target.adf) ? target.adf : {};
      const schema = isRecord(contract.schema) ? contract.schema : {};
      const fields = Array.isArray(schema.fields) ? schema.fields : [];
      const watermark = fields.find(
        (field) =>
          isRecord(field) && incremental && field.name === incremental.column,
      );
      if (
        !incremental ||
        Object.keys(incremental).some(
          (key) => !["column", "type", "connector"].includes(key),
        ) ||
        incremental.type !== "int64" ||
        incremental.connector !== "azure-sql" ||
        typeof incremental.column !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(incremental.column) ||
        !watermark ||
        !isRecord(watermark) ||
        !["long", "int64"].includes(String(watermark.type)) ||
        typeof source.schema !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(source.schema) ||
        typeof source.dataset !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(source.dataset) ||
        sourceAdf.source !== undefined ||
        targetAdf.datasetReference !== undefined
      )
        throw new CliError(
          "INCREMENTAL_SOURCE_INVALID",
          "ADF 1.3.0 requires one generated Azure SQL source with an explicit schema/table and declared int64 watermark field",
        );
      const schedule = isRecord(config.schedule) ? config.schedule : undefined;
      if (schedule?.enabled !== false)
        throw new CliError(
          "INCREMENTAL_SCHEDULE_UNSAFE",
          "ADF 1.3.0 requires schedule.enabled: false; a checkpoint-aware Runner must supply the reserved interval",
        );
    }
    const targetConfiguration = isRecord(contract.target)
      ? contract.target
      : {};
    return {
      assetId: id,
      ...(transformation ? { transformation } : {}),
      source: isRecord(contract.source) ? contract.source : {},
      target: {
        name: assetName(contract, id),
        type:
          implementation === "fabric"
            ? "fabric-data-pipeline"
            : implementation === "adf"
              ? "adf-pipeline"
              : "databricks-bundle-resource",
        configuration: targetConfiguration,
      },
      controls: isRecord(contract.controls) ? contract.controls : {},
    };
  });
  const generator = {
    id: generatorId,
    implementation,
    version,
    digest: digest(canonical(config)),
  };
  const body = {
    contract: compilerProtocol.commandResults["gen plan"],
    ...(project.deliveryStandards
      ? { deliveryStandards: project.deliveryStandards }
      : {}),
    resolutionDigest: project.digest,
    environment,
    generator,
    standards,
    products,
    contracts,
    assets,
  };
  return { ...body, planDigest: digest(canonical(body)) };
}

function stableUuid(value: string): string {
  const hex = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

type AdfSchedule = {
  frequency: "Minute" | "Hour" | "Day" | "Week" | "Month";
  interval: number;
  timeZone?: string;
  startTime: string;
};

function adfSchedule(config: Record<string, unknown>): AdfSchedule | undefined {
  const schedule = isRecord(config.schedule) ? config.schedule : undefined;
  if (!schedule || schedule.enabled === false) return undefined;
  if (schedule.enabled !== true)
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.enabled must be declared as true or false",
    );
  if (schedule.activation !== "manual")
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.activation must be manual; generated triggers deploy stopped",
    );
  const frequency = schedule.frequency;
  if (
    typeof frequency !== "string" ||
    !(["Minute", "Hour", "Day", "Week", "Month"] as const).includes(
      frequency as AdfSchedule["frequency"],
    )
  )
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.frequency must be Minute, Hour, Day, Week or Month",
    );
  const interval = schedule.interval;
  if (
    !Number.isSafeInteger(interval) ||
    Number(interval) < 1 ||
    Number(interval) > 1000
  )
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.interval must be an integer between 1 and 1000",
    );
  const timeZone = schedule.timeZone;
  if (
    timeZone !== undefined &&
    (typeof timeZone !== "string" ||
      !/^[A-Za-z0-9_+./ -]{1,100}$/.test(timeZone))
  )
    throw new CliError("GENERATOR_INVALID", "ADF schedule.timeZone is invalid");
  const startTime = schedule.startTime;
  if (typeof startTime !== "string" || !Number.isFinite(Date.parse(startTime)))
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.startTime is required and must be an ISO timestamp",
    );
  return {
    frequency: frequency as AdfSchedule["frequency"],
    interval: Number(interval),
    ...(typeof timeZone === "string" ? { timeZone } : {}),
    startTime,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function buildGeneration(
  basePath: string,
  environment: string,
  generatorId: string,
  outputPath: string,
  suppliedInputs: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const base = await safeRoot(basePath);
  const requested = resolve(outputPath);
  if (inside(base, requested) || inside(requested, base))
    throw new CliError(
      "OUTPUT_PATH",
      "Generated output must be outside the contract base",
    );
  await mkdir(dirname(requested), { recursive: true });
  const root = join(await realpath(dirname(requested)), basename(requested));
  if (inside(base, root) || inside(root, base))
    throw new CliError(
      "OUTPUT_PATH",
      "Generated output must be outside the contract base",
    );
  const guard = join(dirname(root), `.${basename(root)}.ingestron-build.lock`);
  await mkdir(guard).catch(() => {
    throw new CliError(
      "GENERATION_LOCKED",
      "Output is locked; inspect the generation lock before recovery",
    );
  });
  const stage = join(guard, "staged");
  const previous = join(guard, "previous");
  let backedUp = false;
  let preserveBackup = false;
  async function snapshot(): Promise<string | undefined> {
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new CliError(
        "OUTPUT_PATH",
        "Output must be a regular directory, not a link or file",
      );
    const entries = await readdir(root);
    if (entries.length) {
      const marker = await readSafeYaml(root, "ingestron.lock.yaml").catch(
        () => {
          throw new CliError(
            "OUTPUT_OWNERSHIP",
            "Non-empty output is not an Ingestron generated directory; choose a new directory",
          );
        },
      );
      if (
        !isRecord(marker.value) ||
        marker.value.contract !== "ingestron.generated-project/v1"
      )
        throw new CliError(
          "OUTPUT_OWNERSHIP",
          "Output has no recognised Ingestron generation lock",
        );
    }
    return canonical(await collectFiles(root));
  }
  try {
    const before = await snapshot();
    const result = await renderGeneration(
      base,
      environment,
      generatorId,
      stage,
      suppliedInputs,
    );
    await verifyGeneration(stage);
    if (before !== (await snapshot()))
      throw new CliError(
        "OUTPUT_CHANGED",
        "Output changed during generation; previous files were preserved",
      );
    if (before !== undefined) {
      await rename(root, previous);
      backedUp = true;
    }
    try {
      await rename(stage, root);
    } catch (error) {
      if (backedUp) {
        preserveBackup = true;
        await rename(previous, root);
        preserveBackup = false;
        backedUp = false;
      }
      throw error;
    }
    if (backedUp) {
      preserveBackup = true;
      await rm(previous, { recursive: true });
      preserveBackup = false;
    }
    return { ...result, outputPath: root };
  } finally {
    await rm(stage, { recursive: true, force: true });
    // Never delete a backup when rollback or cleanup failed. Operator recovery
    // must inspect it; the retained guard prevents another writer proceeding.
    if (!preserveBackup) await rmdir(guard);
  }
}

async function renderGeneration(
  basePath: string,
  environment: string,
  generatorId: string,
  outputPath: string,
  suppliedInputs: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const plan = await planGeneration(
    basePath,
    environment,
    generatorId,
    suppliedInputs,
  );
  const project = await resolveProject(basePath, environment, suppliedInputs);
  if (project.digest !== plan.resolutionDigest)
    throw new CliError(
      "PROJECT_CHANGED",
      "Contract base changed while preparing generation; retry from the new revision",
    );
  for (const id of plan.contracts) {
    const contract = project.contracts[id]!;
    if (isRecord(contract.review)) {
      const schema = isRecord(contract.schema) ? contract.schema : {};
      const fields = Array.isArray(schema.fields) ? schema.fields : [];
      if (
        contract.review.status !== "approved" ||
        !isRecord(contract.target) ||
        !contract.target.name ||
        fields.length === 0 ||
        fields.some(
          (field) =>
            !isRecord(field) ||
            field.type === "unknown" ||
            typeof field.required !== "boolean",
        )
      )
        throw new CliError(
          "DISCOVERY_REVIEW_REQUIRED",
          `Contract ${id} needs approved review, an explicit target and resolved field types/nullability before generation`,
        );
    }
  }
  const root = resolve(outputPath);
  if (inside(resolve(basePath), root) || inside(root, resolve(basePath)))
    throw new CliError(
      "OUTPUT_PATH",
      "Generated output must be outside the contract base",
    );
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "items"), { recursive: true });
  await mkdir(join(root, "definitions"), { recursive: true });
  await mkdir(join(root, "contracts"), { recursive: true });
  const generatorConfig = project.generators[plan.generator.id]!;
  const selectedStandards = plan.standards.map(
    (item) => project.standards[item.id]!,
  );
  const eltId = assertDeliverySelection(
    project.deliveryStandards,
    plan.products,
    plan.standards.map((standard) => standard.id),
  );
  const primaryStandard = eltId
    ? project.standards[eltId]!
    : (selectedStandards[0] ?? {});
  const architecture = isRecord(primaryStandard.architecture)
    ? primaryStandard.architecture
    : {};
  const handoff = isRecord(architecture.handoff) ? architecture.handoff : {};
  const handoffContract =
    typeof handoff.contract === "string"
      ? handoff.contract
      : "ingestron.medallion-handoff/v1";
  const handoffFormat =
    typeof handoff.format === "string" ? handoff.format : "parquet";
  const standardAnnotations = plan.standards.map(
    (item) => `standard:${item.id}@${item.version}`,
  );
  const schedule =
    plan.generator.implementation === "adf"
      ? adfSchedule(generatorConfig)
      : undefined;
  const files: string[] = [];
  for (const id of plan.contracts) {
    const asset = plan.assets.find((item) => item.assetId === id)!;
    const name = `pl_${asset.target.name}`;
    const ownershipAnnotations =
      plan.generator.implementation === "adf" &&
      ["1.2.0", "1.2.1", "1.3.0"].includes(plan.generator.version)
        ? [
            `ingestron-owner:${digest(JSON.stringify([project.project.id, plan.environment, id])).slice(7)}`,
          ]
        : [];
    if (plan.generator.implementation === "adf") {
      const nativeIncremental = plan.generator.version === "1.3.0";
      const pipelineDirectory = join(root, "factory", "pipelines");
      const datasetDirectory = join(root, "factory", "datasets");
      await mkdir(pipelineDirectory, { recursive: true });
      const sourceAdf = isRecord(asset.source.adf) ? asset.source.adf : {};
      const targetAdf = isRecord(asset.target.configuration.adf)
        ? asset.target.configuration.adf
        : {};
      const existingSource = typeof sourceAdf.datasetReference === "string";
      const existingTarget = typeof targetAdf.datasetReference === "string";
      if (!existingSource || !existingTarget)
        await mkdir(datasetDirectory, { recursive: true });
      const datasetName = `ds_${asset.target.name}`;
      const bronzeDatasetName = `${datasetName}_bronze`;
      const sourceReference = existingSource
        ? sourceAdf.datasetReference
        : datasetName;
      const targetReference = existingTarget
        ? targetAdf.datasetReference
        : bronzeDatasetName;
      const sourceParameters = isRecord(sourceAdf.parameters)
        ? sourceAdf.parameters
        : undefined;
      const targetParameters = isRecord(targetAdf.parameters)
        ? targetAdf.parameters
        : undefined;
      const incremental = isRecord(asset.source.incremental)
        ? asset.source.incremental
        : undefined;
      const reconciliationMetric =
        asset.controls.reconciliation === "file-count" ? "files" : "rows";
      const readMetric =
        reconciliationMetric === "files" ? "filesRead" : "rowsRead";
      const writtenMetric =
        reconciliationMetric === "files" ? "filesWritten" : "rowsCopied";
      const pipeline = {
        name,
        properties: {
          description: `Generated orchestration for ${id}`,
          parameters: {
            watermark_from: { type: "String" },
            watermark_to: { type: "String" },
            ...(nativeIncremental
              ? {
                  reservation_digest: { type: "String" },
                  storage_binding_digest: { type: "String" },
                }
              : {}),
            plan_digest: { type: "String", defaultValue: plan.planDigest },
            handoff_contract: {
              type: "String",
              defaultValue: handoffContract,
            },
          },
          activities: [
            {
              name: "copy_to_bronze",
              type: "Copy",
              dependsOn: [],
              policy: {
                timeout: "0.12:00:00",
                retry: 2,
                retryIntervalInSeconds: 60,
                secureOutput: true,
                secureInput: true,
              },
              typeProperties: {
                ...(["1.2.1", "1.3.0"].includes(plan.generator.version)
                  ? { validateDataConsistency: true }
                  : {}),
                source: nativeIncremental
                  ? {
                      type: "AzureSqlSource",
                      sqlReaderQuery: {
                        type: "Expression",
                        value: `@concat('SELECT * FROM [${String(asset.source.schema)}].[${String(asset.source.dataset)}] WHERE [${String(incremental!.column)}] > ', pipeline().parameters.watermark_from, ' AND [${String(incremental!.column)}] <= ', pipeline().parameters.watermark_to)`,
                      },
                    }
                  : isRecord(sourceAdf.source)
                    ? sourceAdf.source
                    : { type: "__BIND_SOURCE_TYPE__" },
                sink: isRecord(targetAdf.sink)
                  ? targetAdf.sink
                  : handoffFormat === "parquet"
                    ? { type: "ParquetSink" }
                    : { type: "__BIND_SINK_TYPE__" },
              },
              ...(["1.2.1", "1.3.0"].includes(plan.generator.version)
                ? {}
                : { validateDataConsistency: true }),
              inputs: [
                {
                  referenceName: sourceReference,
                  type: "DatasetReference",
                  ...(sourceParameters ? { parameters: sourceParameters } : {}),
                },
              ],
              outputs: [
                {
                  referenceName: targetReference,
                  type: "DatasetReference",
                  ...(nativeIncremental
                    ? {
                        parameters: {
                          batch_path: {
                            type: "Expression",
                            value:
                              "@concat('batches/', replace(pipeline().parameters.reservation_digest, 'sha256:', ''), '/data')",
                          },
                        },
                      }
                    : targetParameters
                      ? { parameters: targetParameters }
                      : {}),
                },
              ],
            },
            {
              name: `reconcile_${reconciliationMetric}_counts`,
              type: "IfCondition",
              dependsOn: [
                {
                  activity: "copy_to_bronze",
                  dependencyConditions: ["Succeeded"],
                },
              ],
              typeProperties: {
                expression: {
                  type: "Expression",
                  value: `@equals(activity('copy_to_bronze').output.${readMetric}, activity('copy_to_bronze').output.${writtenMetric})`,
                },
                ifTrueActivities: [],
                ifFalseActivities: [
                  {
                    name: "fail_reconciliation",
                    type: "Fail",
                    typeProperties: {
                      errorCode: "INGESTRON_RECONCILIATION_FAILED",
                      message: `Copy ${readMetric} and ${writtenMetric} differ; do not promote this release.`,
                    },
                  },
                ],
              },
            },
          ],
          annotations: [
            "generated-by-ingestron",
            ...ownershipAnnotations,
            `plan:${plan.planDigest}`,
            `handoff:${handoffContract}`,
            ...standardAnnotations,
          ],
        },
      };
      const dataset = {
        name: datasetName,
        properties: {
          linkedServiceName: {
            referenceName: "__BIND_SOURCE_LINKED_SERVICE__",
            type: "LinkedServiceReference",
          },
          annotations: [
            "generated-by-ingestron",
            ...ownershipAnnotations,
            ...standardAnnotations,
          ],
          type: nativeIncremental ? "AzureSqlTable" : "__BIND_DATASET_TYPE__",
          typeProperties: {
            schema: String(asset.source.schema ?? "dbo"),
            table: String(asset.source.dataset ?? id),
          },
        },
      };
      const bronzeDataset = {
        name: bronzeDatasetName,
        properties: {
          linkedServiceName: {
            referenceName: "__BIND_TARGET_LINKED_SERVICE__",
            type: "LinkedServiceReference",
          },
          annotations: [
            "generated-by-ingestron",
            ...ownershipAnnotations,
            `handoff:${handoffContract}`,
            ...standardAnnotations,
          ],
          type:
            handoffFormat === "parquet"
              ? "Parquet"
              : "__BIND_TARGET_DATASET_TYPE__",
          ...(nativeIncremental
            ? { parameters: { batch_path: { type: "String" } } }
            : {}),
          typeProperties:
            handoffFormat === "parquet"
              ? {
                  location: {
                    type: "AzureBlobFSLocation",
                    fileSystem: "bronze",
                    folderPath: nativeIncremental
                      ? {
                          type: "Expression",
                          value: "@dataset().batch_path",
                        }
                      : isRecord(generatorConfig.handoff) &&
                          typeof generatorConfig.handoff.snapshotId === "string"
                        ? `${generatorConfig.handoff.snapshotId}/${asset.target.name}`
                        : String(asset.target.name),
                  },
                  compressionCodec: "snappy",
                }
              : {
                  schema: String(asset.target.name).includes(".")
                    ? String(asset.target.name).split(".")[0]
                    : "dbo",
                  table: String(asset.target.name).split(".").at(-1),
                },
        },
      };
      await writeJson(join(pipelineDirectory, `${name}.json`), pipeline);
      files.push(`factory/pipelines/${name}.json`);
      if (schedule) {
        const triggerDirectory = join(root, "factory", "triggers");
        const triggerName = `trg_${asset.target.name}`;
        await mkdir(triggerDirectory, { recursive: true });
        await writeJson(join(triggerDirectory, `${triggerName}.json`), {
          name: triggerName,
          properties: {
            description: `Generated schedule for ${id}; activation remains an explicit operator action.`,
            annotations: [
              "generated-by-ingestron",
              ...ownershipAnnotations,
              `plan:${plan.planDigest}`,
              "activation:manual",
              ...standardAnnotations,
            ],
            type: "ScheduleTrigger",
            typeProperties: {
              recurrence: {
                frequency: schedule.frequency,
                interval: schedule.interval,
                ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
                startTime: schedule.startTime,
              },
            },
            pipelines: [
              {
                pipelineReference: {
                  referenceName: name,
                  type: "PipelineReference",
                },
                parameters: {
                  plan_digest: plan.planDigest,
                  handoff_contract: handoffContract,
                },
              },
            ],
          },
        });
        files.push(`factory/triggers/${triggerName}.json`);
      }
      if (!existingSource) {
        await writeJson(join(datasetDirectory, `${datasetName}.json`), dataset);
        files.push(`factory/datasets/${datasetName}.json`);
      }
      if (!existingTarget) {
        await writeJson(
          join(datasetDirectory, `${bronzeDatasetName}.json`),
          bronzeDataset,
        );
        files.push(`factory/datasets/${bronzeDatasetName}.json`);
      }
      await writeFile(
        join(root, "contracts", `${id}.yaml`),
        YAML.stringify(project.contracts[id]),
      );
      files.push(`contracts/${id}.yaml`);
      continue;
    }
    if (plan.generator.implementation === "databricks") {
      const resourceDirectory = join(root, "resources");
      const sourceDirectory = join(root, "src");
      await mkdir(resourceDirectory, { recursive: true });
      await mkdir(sourceDirectory, { recursive: true });
      const generatorHandoff = isRecord(generatorConfig.handoff)
        ? generatorConfig.handoff
        : {};
      const bronzeRootPath =
        typeof generatorHandoff.bronzeRootPath === "string"
          ? generatorHandoff.bronzeRootPath.replace(/\/$/, "")
          : "__BIND_BRONZE_ROOT_PATH__";
      const snapshot = asset.transformation
        ? `/${generatorHandoff.snapshotId}`
        : "";
      const bronzePath = `${bronzeRootPath}${snapshot}/${asset.target.name}`;
      const typedTarget = isRecord(generatorConfig.target)
        ? generatorConfig.target
        : {};
      const namespace = asset.transformation
        ? `${typedTarget.catalog}.${typedTarget.schema}.`
        : "";
      const silverTable = `${namespace}${asset.target.name}_silver`;
      const goldTable = `${namespace}${asset.target.name}_gold`;
      const contractSchema = isRecord(project.contracts[id]!.schema)
        ? project.contracts[id]!.schema
        : {};
      const fields = Array.isArray(contractSchema.fields)
        ? contractSchema.fields
        : [];
      const expectedColumns = fields.flatMap((field) =>
        isRecord(field) && typeof field.name === "string" ? [field.name] : [],
      );
      const nativeEvidence = ["1.2.0", "1.3.0"].includes(
        plan.generator.version,
      );
      const pinnedConsumer = plan.generator.version === "1.3.0";
      const ownerDigest = digest(
        JSON.stringify([project.project.id, plan.environment, id]),
      );
      const governedRunParameters = nativeEvidence
        ? {
            plan_digest: "{{job.parameters.plan_digest}}",
            owner_digest: "{{job.parameters.owner_digest}}",
            reservation_digest: "{{job.parameters.reservation_digest}}",
            storage_binding_digest: "{{job.parameters.storage_binding_digest}}",
          }
        : {};
      const taskParameters = {
        asset_id: id,
        plan_digest: nativeEvidence
          ? governedRunParameters.plan_digest
          : plan.planDigest,
        ...governedRunParameters,
        handoff_contract: handoffContract,
        bronze_path: bronzePath,
        silver_table: silverTable,
        gold_table: goldTable,
        ...(asset.transformation
          ? { snapshot_id: String(generatorHandoff.snapshotId) }
          : {}),
      };
      const resource = {
        resources: {
          jobs: {
            [name]: {
              name,
              tags: {
                generated_by: "ingestron",
                plan_digest: plan.planDigest,
                standards: plan.standards
                  .map((item) => `${item.id}@${item.version}`)
                  .join(","),
                ...(nativeEvidence ? { owner_digest: ownerDigest } : {}),
              },
              ...(nativeEvidence
                ? {
                    parameters: [
                      { name: "plan_digest", default: plan.planDigest },
                      { name: "owner_digest", default: ownerDigest },
                      {
                        name: "reservation_digest",
                        default: "__BIND_RESERVATION_DIGEST__",
                      },
                      {
                        name: "storage_binding_digest",
                        default: "__BIND_STORAGE_BINDING_DIGEST__",
                      },
                    ],
                  }
                : {}),
              tasks: [
                {
                  task_key: "validate_bronze",
                  notebook_task: {
                    notebook_path: `../src/${id}.py`,
                    base_parameters: {
                      ...taskParameters,
                      stage: "validate_bronze",
                    },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                  max_retries: 2,
                  min_retry_interval_millis: 60_000,
                },
                {
                  task_key: "build_silver",
                  depends_on: [{ task_key: "validate_bronze" }],
                  notebook_task: {
                    notebook_path: `../src/${id}.py`,
                    base_parameters: {
                      ...taskParameters,
                      stage: "build_silver",
                    },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                },
                {
                  task_key: "publish_gold",
                  depends_on: [{ task_key: "build_silver" }],
                  notebook_task: {
                    notebook_path: `../src/${id}.py`,
                    base_parameters: {
                      ...taskParameters,
                      stage: "publish_gold",
                    },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                },
                {
                  task_key: "reconcile",
                  depends_on: [{ task_key: "publish_gold" }],
                  notebook_task: {
                    notebook_path: asset.transformation
                      ? `../src/${id}.py`
                      : "../src/reconcile.py",
                    base_parameters: {
                      asset_id: id,
                      bronze_path: bronzePath,
                      gold_table: goldTable,
                      ...governedRunParameters,
                      ...(asset.transformation
                        ? { ...taskParameters, stage: "reconcile" }
                        : {}),
                    },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                },
                ...(pinnedConsumer
                  ? [
                      {
                        task_key: "verify_publication",
                        depends_on: [{ task_key: "reconcile" }],
                        notebook_task: {
                          notebook_path: `../src/${id}.py`,
                          base_parameters: {
                            ...taskParameters,
                            stage: "verify_publication",
                            published_version:
                              "{{tasks.reconcile.values.delta_version}}",
                            expected_count:
                              "{{tasks.reconcile.values.gold_count}}",
                          },
                        },
                        job_cluster_key: "__BIND_JOB_CLUSTER__",
                      },
                    ]
                  : []),
              ],
              job_clusters: [
                {
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                  new_cluster: {
                    spark_version: "__BIND_SPARK_VERSION__",
                    node_type_id: "__BIND_NODE_TYPE_ID__",
                    num_workers: 1,
                  },
                },
              ],
            },
          },
        },
      };
      await writeFile(
        join(resourceDirectory, `${id}.job.yml`),
        YAML.stringify(resource),
      );
      await writeFile(
        join(sourceDirectory, `${id}.py`),
        `# Generated by Ingestron from ${plan.standards.map((item) => `${item.id}@${item.version}`).join(", ")}.\n# Review the generation plan before customer-side deployment.\nimport json\nfrom datetime import datetime, timezone\n\nfor name in ("stage", "asset_id", "plan_digest", "handoff_contract", "bronze_path", "silver_table", "gold_table"):\n    dbutils.widgets.text(name, "")\n\nstage = dbutils.widgets.get("stage")\nasset_id = dbutils.widgets.get("asset_id")\nplan_digest = dbutils.widgets.get("plan_digest")\nhandoff_contract = dbutils.widgets.get("handoff_contract")\nbronze_path = dbutils.widgets.get("bronze_path")\nsilver_table = dbutils.widgets.get("silver_table")\ngold_table = dbutils.widgets.get("gold_table")\nif not all((stage, asset_id, plan_digest, handoff_contract, bronze_path, silver_table, gold_table)):\n    raise ValueError("All governed task parameters are required")\nif handoff_contract != ${JSON.stringify(handoffContract)}:\n    raise ValueError("The ingestion handoff contract does not match the selected standards pack")\n\nexpected_columns = ${JSON.stringify(expectedColumns)}\nbronze = spark.read.format(${JSON.stringify(handoffFormat)}).load(bronze_path)\nmissing = sorted(set(expected_columns) - set(bronze.columns))\nif missing:\n    raise ValueError(f"Bronze contract validation failed; missing columns: {missing}")\n\nif stage == "validate_bronze":\n    output_count = bronze.count()\nelif stage == "build_silver":\n    silver = bronze.select(*expected_columns)\n    silver.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(silver_table)\n    output_count = spark.table(silver_table).count()\nelif stage == "publish_gold":\n    silver = spark.table(silver_table)\n    silver.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(gold_table)\n    output_count = spark.table(gold_table).count()\nelse:\n    raise ValueError(f"Unsupported governed stage: {stage}")\n\nprint(json.dumps({"event": "ingestron.asset.stage.completed", "stage": stage, "assetId": asset_id, "planDigest": plan_digest, "rowCount": output_count, "at": datetime.now(timezone.utc).isoformat()}))\n`,
      );
      files.push(`resources/${id}.job.yml`, `src/${id}.py`);
      if (asset.transformation) {
        const paths = Object.fromEntries(
          asset.transformation.sources.map((source) => [
            source,
            `${bronzeRootPath}${snapshot}/${assetName(project.contracts[source]!, source)}`,
          ]),
        );
        await writeFile(
          join(sourceDirectory, `${id}.py`),
          transformationNotebook(
            asset.transformation,
            paths,
            handoffFormat,
            project.project.id,
            id,
            nativeEvidence,
            pinnedConsumer,
          ),
        );
        await writeJson(
          join(root, "contracts", `${id}.transformation.json`),
          asset.transformation,
        );
        files.push(`contracts/${id}.transformation.json`);
      }
      if (nativeEvidence) {
        const sourceDigest = digest(
          await readFile(join(sourceDirectory, `${id}.py`), "utf8"),
        );
        const generatedJob = resource.resources.jobs[name] as {
          tags: Record<string, string>;
          parameters: Array<{ name: string; default: string }>;
          tasks: Array<{
            notebook_task: { base_parameters: Record<string, string> };
          }>;
        };
        generatedJob.tags.source_digest = sourceDigest;
        generatedJob.parameters.push({
          name: "source_digest",
          default: sourceDigest,
        });
        for (const task of generatedJob.tasks)
          task.notebook_task.base_parameters.source_digest =
            "{{job.parameters.source_digest}}";
        await writeFile(
          join(resourceDirectory, `${id}.job.yml`),
          YAML.stringify(resource),
        );
      }
      await writeFile(
        join(root, "contracts", `${id}.yaml`),
        YAML.stringify(project.contracts[id]),
      );
      files.push(`contracts/${id}.yaml`);
      continue;
    }
    const fabricActivities = [
      "begin_run_log",
      "land_bronze",
      "reconcile",
      "complete_run_log",
    ] as const;
    const notebookBindings: Record<string, string> = {};
    for (const activity of fabricActivities) {
      const notebookName = `nb_${asset.target.name}_${activity}`;
      const notebookDirectory = join(root, "items", `${notebookName}.Notebook`);
      await mkdir(notebookDirectory, { recursive: true });
      const sourceTable = String(asset.source.dataset ?? id);
      const targetTable = String(asset.target.name);
      const action =
        activity === "land_bronze"
          ? `source = spark.table(${JSON.stringify(sourceTable)})\nsource_count = source.count()\n(source.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(${JSON.stringify(targetTable)}))\n`
          : activity === "reconcile"
            ? `source_count = spark.table(${JSON.stringify(sourceTable)}).count()\ntarget_count = spark.table(${JSON.stringify(targetTable)}).count()\nif source_count != target_count:\n    raise RuntimeError(f"Reconciliation failed: source={source_count}, target={target_count}")\n`
            : `print(json.dumps({"event": ${JSON.stringify(`ingestron.${activity}`)}, "assetId": asset_id, "planDigest": plan_digest, "at": datetime.now(timezone.utc).isoformat()}))\n`;
      const notebookSource = `# Fabric notebook source generated by Ingestron.\nimport json\nfrom datetime import datetime, timezone\n\nasset_id = ${JSON.stringify(id)}\nplan_digest = ${JSON.stringify(plan.planDigest)}\n${action}`;
      const notebookPlatform = {
        version: "2.0",
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/platform/platformProperties.json",
        config: {
          logicalId: stableUuid(
            `${plan.planDigest}:${id}:${activity}:notebook`,
          ),
        },
        metadata: {
          type: "Notebook",
          displayName: notebookName,
          description: `Generated ${activity} notebook for ${id}`,
        },
      };
      await writeFile(
        join(notebookDirectory, "notebook-content.py"),
        notebookSource,
      );
      await writeJson(join(notebookDirectory, ".platform"), notebookPlatform);
      files.push(
        `items/${notebookName}.Notebook/notebook-content.py`,
        `items/${notebookName}.Notebook/.platform`,
      );
      const notebookParts = (
        [
          ["notebook-content.py", notebookSource],
          [".platform", `${JSON.stringify(notebookPlatform, null, 2)}\n`],
        ] as Array<[string, string]>
      ).map(([path, value]) => ({
        path,
        payload: Buffer.from(value).toString("base64"),
        payloadType: "InlineBase64",
      }));
      await writeJson(
        join(root, "definitions", `${notebookName}.create.json`),
        {
          displayName: notebookName,
          description: notebookPlatform.metadata.description,
          type: "Notebook",
          definition: { parts: notebookParts },
        },
      );
      files.push(`definitions/${notebookName}.create.json`);
      notebookBindings[activity] = `__BIND_ITEM_${notebookName
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")}_ID__`;
    }
    const itemDirectory = join(root, "items", `${name}.DataPipeline`);
    await mkdir(itemDirectory, { recursive: true });
    const pipeline = {
      name,
      properties: {
        description: `Generated orchestration for ${id}`,
        parameters: {
          watermark_from: { type: "string" },
          watermark_to: { type: "string" },
        },
        activities: [...fabricActivities].map(
          (activity, index, activities) => ({
            name: activity,
            type: "TridentNotebook",
            dependsOn:
              index === 0
                ? []
                : [
                    {
                      activity: activities[index - 1],
                      dependencyConditions: ["Succeeded"],
                    },
                  ],
            policy: {
              timeout: "0.12:00:00",
              retry: 2,
              retryIntervalInSeconds: 60,
            },
            typeProperties: {
              notebookId: notebookBindings[activity],
              workspaceId: "__BIND_WORKSPACE_ID__",
              parameters: {
                asset_id: { value: id, type: "String" },
                plan_digest: { value: plan.planDigest, type: "String" },
              },
            },
          }),
        ),
        annotations: ["generated-by-ingestron", `plan:${plan.planDigest}`],
      },
    };
    const platform = {
      version: "2.0",
      $schema:
        "https://developer.microsoft.com/json-schemas/fabric/platform/platformProperties.json",
      config: { logicalId: stableUuid(`${plan.planDigest}:${id}`) },
      metadata: {
        type: "DataPipeline",
        displayName: name,
        description: pipeline.properties.description,
      },
    };
    await writeJson(join(itemDirectory, "pipeline-content.json"), pipeline);
    await writeJson(join(itemDirectory, ".platform"), platform);
    files.push(
      `items/${name}.DataPipeline/pipeline-content.json`,
      `items/${name}.DataPipeline/.platform`,
    );
    const parts = [
      ["pipeline-content.json", pipeline],
      [".platform", platform],
    ].map(([path, value]) => ({
      path,
      payload: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString(
        "base64",
      ),
      payloadType: "InlineBase64",
    }));
    await writeJson(join(root, "definitions", `${name}.create.json`), {
      displayName: name,
      description: platform.metadata.description,
      type: "DataPipeline",
      definition: { parts },
    });
    files.push(`definitions/${name}.create.json`);
    await writeFile(
      join(root, "contracts", `${id}.yaml`),
      YAML.stringify(project.contracts[id]),
    );
    files.push(`contracts/${id}.yaml`);
  }
  if (plan.generator.implementation === "adf") {
    await mkdir(join(root, "factory"), { recursive: true });
    await writeJson(join(root, "factory", "factory-parameters.json"), {
      contract: "ingestron.adf-bindings/v1",
      factoryName: "__BIND_FACTORY_NAME__",
      sourceLinkedService: "__BIND_SOURCE_LINKED_SERVICE__",
      targetLinkedService: "__BIND_TARGET_LINKED_SERVICE__",
      targetDatasetType:
        handoffFormat === "parquet"
          ? "Parquet"
          : "__BIND_TARGET_DATASET_TYPE__",
      handoffContract,
      standards: plan.standards,
      planDigest: plan.planDigest,
    });
    files.push("factory/factory-parameters.json");
  }
  if (plan.generator.implementation === "databricks") {
    await writeFile(
      join(root, "src", "reconcile.py"),
      `# Generated by Ingestron. Reconciles the governed ingestion-to-product handoff.\nimport json\nfrom datetime import datetime, timezone\n\nfor name in ("asset_id", "bronze_path", "gold_table"):\n    dbutils.widgets.text(name, "")\nasset_id = dbutils.widgets.get("asset_id")\nbronze_path = dbutils.widgets.get("bronze_path")\ngold_table = dbutils.widgets.get("gold_table")\nif not all((asset_id, bronze_path, gold_table)):\n    raise ValueError("asset_id, bronze_path and gold_table are required")\nbronze_count = spark.read.format(${JSON.stringify(handoffFormat)}).load(bronze_path).count()\ngold_count = spark.table(gold_table).count()\nif bronze_count != gold_count:\n    raise RuntimeError(f"Reconciliation failed: bronze={bronze_count}, gold={gold_count}")\nprint(json.dumps({"event": "ingestron.asset.reconciled", "assetId": asset_id, "bronzeCount": bronze_count, "goldCount": gold_count, "at": datetime.now(timezone.utc).isoformat()}))\n`,
    );
    files.push("src/reconcile.py");
    await writeFile(
      join(root, "databricks.yml"),
      YAML.stringify({
        bundle: { name: project.project.id },
        include: ["resources/*.yml"],
        variables: {
          workspace_host: { description: "Customer Databricks workspace URL" },
          root_path: { description: "Customer bundle root path" },
        },
        targets: {
          [environment]: {
            mode: environment === "prod" ? "production" : "development",
            workspace: {
              host: "${var.workspace_host}",
              root_path: "${var.root_path}",
            },
          },
        },
      }),
    );
    files.push("databricks.yml");
  }
  if (
    plan.generator.implementation === "adf" &&
    ["1.2.0", "1.2.1", "1.3.0"].includes(plan.generator.version)
  ) {
    const owners = new Map(
      plan.contracts.map((contractId) => [
        `ingestron-owner:${digest(JSON.stringify([project.project.id, plan.environment, contractId])).slice(7)}`,
        {
          contractId,
          products: plan.products
            .filter((productId) =>
              productContractIds(project.products[productId]!).includes(
                contractId,
              ),
            )
            .sort(),
        },
      ]),
    );
    const resources = [];
    for (const path of files
      .filter((path) => /^factory\/(datasets|pipelines|triggers)\//.test(path))
      .sort()) {
      const definition = JSON.parse(await readFile(join(root, path), "utf8"));
      const marker = definition.properties.annotations.find((value: string) =>
        value.startsWith("ingestron-owner:"),
      );
      const owner = owners.get(marker);
      if (!owner || !owner.products.length)
        throw new CliError(
          "RESOURCE_OWNERSHIP",
          "Owner-aware generation requires each contract to be referenced by a selected product",
        );
      resources.push({ path, owner: marker, ...owner });
    }
    await writeJson(join(root, "resource-ownership.json"), {
      contract: "ingestron.resource-ownership/v1",
      projectId: project.project.id,
      environment: plan.environment,
      products: [...plan.products].sort(),
      resources,
    });
    files.push("resource-ownership.json");
  }
  await writeJson(join(root, "generation-plan.json"), plan);
  await writeFile(
    join(root, "README.md"),
    `# ${project.project.name} — generated ${plan.generator.implementation} source\n\nGenerated deterministically by Ingestron CLI. This source has not been deployed or validated against a customer target.\n\n- Environment: ${environment}\n- Plan: ${plan.planDigest}\n- Contracts: ${plan.contracts.length}\n- Standards: ${plan.standards.map((item) => `${item.id}@${item.version}`).join(", ")}\n\nUse \`ingestron deploy plan\` to create the customer-side deployment handoff.\n`,
  );
  files.push("generation-plan.json", "README.md");
  const sortedFiles = files.sort();
  const fileDigests = Object.fromEntries(
    await Promise.all(
      sortedFiles.map(async (path) => [
        path,
        digest(await readFile(join(root, path))),
      ]),
    ),
  );
  const manifest = {
    contract: compilerProtocol.commandResults["gen build"],
    ...(plan.deliveryStandards
      ? { deliveryStandards: plan.deliveryStandards }
      : {}),
    target: plan.generator.implementation,
    environment,
    project: project.project,
    resolutionDigest: project.digest,
    planDigest: plan.planDigest,
    generator: plan.generator,
    standards: plan.standards,
    fileInventory: "complete",
    files: sortedFiles,
    fileDigests,
    deployed: false,
  };
  await writeFile(join(root, "ingestron.lock.yaml"), YAML.stringify(manifest));
  return { ...manifest, outputPath: root };
}

function productContractIds(product: Record<string, unknown>): string[] {
  const extension =
    isRecord(product.product) && isRecord(product.product["x-ingestron"])
      ? product.product["x-ingestron"]
      : product;
  return stringArray(extension.contracts, []).map((reference) =>
    reference.replace(/^contract:\/\//, ""),
  );
}

async function collectFiles(
  root: string,
): Promise<Array<{ path: string; digest: string }>> {
  const files: Array<{ path: string; digest: string }> = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new CliError(
          "VERIFY_PATH",
          `Symbolic link in generated project: ${child}`,
        );
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        files.push({
          path: relative(root, child).split(sep).join("/"),
          digest: digest(await readFile(child)),
        });
      else
        throw new CliError(
          "VERIFY_PATH",
          `Unsupported file type in generated project: ${child}`,
        );
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function verifyGeneration(
  outputPath: string,
): Promise<Record<string, unknown>> {
  const root = await safeRoot(outputPath);
  const lock = await readSafeYaml(root, "ingestron.lock.yaml");
  if (
    !isRecord(lock.value) ||
    lock.value.contract !== "ingestron.generated-project/v1"
  )
    throw new CliError(
      "VERIFY_INVALID",
      "Generated project lock is missing or invalid",
    );
  const files = await collectFiles(root);
  const expected = Array.isArray(lock.value.files) ? lock.value.files : [];
  const expectedDigests = isRecord(lock.value.fileDigests)
    ? lock.value.fileDigests
    : {};
  if (
    expected.length === 0 ||
    new Set(expected).size !== expected.length ||
    expected.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.includes("\\") ||
        path.startsWith("/") ||
        path
          .split("/")
          .some((part: string) => !part || part === "." || part === "..") ||
        path === "ingestron.lock.yaml",
    ) ||
    Object.keys(expectedDigests).length !== expected.length ||
    Object.keys(expectedDigests).some((path) => !expected.includes(path)) ||
    (lock.value.fileInventory !== undefined &&
      lock.value.fileInventory !== "complete")
  )
    throw new CliError("VERIFY_INVALID", "Generated file inventory is invalid");
  const complete = lock.value.fileInventory === "complete";
  if (
    complete &&
    (!expected.includes("generation-plan.json") ||
      !expected.includes("README.md"))
  )
    throw new CliError(
      "VERIFY_INVALID",
      "Complete inventory must include the plan and README",
    );
  const permitted = new Set([
    ...expected,
    "ingestron.lock.yaml",
    ...(complete ? [] : ["generation-plan.json", "README.md"]),
  ]);
  const unexpected = files.filter((file) => !permitted.has(file.path));
  if (unexpected.length)
    throw new CliError(
      "VERIFY_UNEXPECTED",
      `Unrecorded generated files: ${unexpected.map((file) => file.path).join(", ")}`,
    );
  const missingFiles = expected.filter(
    (path) => !files.some((file) => file.path === path),
  );
  if (missingFiles.length > 0)
    throw new CliError(
      "VERIFY_MISSING",
      `Generated files missing: ${missingFiles.join(", ")}`,
    );
  for (const path of expected) {
    const actual = files.find((file) => file.path === path)?.digest;
    const expectedDigest = expectedDigests[path];
    if (
      typeof path !== "string" ||
      typeof expectedDigest !== "string" ||
      actual !== expectedDigest
    )
      throw new CliError(
        "VERIFY_DIGEST",
        `Generated file digest mismatch: ${String(path)}`,
      );
  }
  return {
    contract: compilerProtocol.commandResults["gen verify"],
    valid: true,
    verificationScope: complete
      ? "complete-file-inventory"
      : "legacy-recorded-files",
    planDigest: lock.value.planDigest,
    files,
  };
}

export async function deploymentPlan(
  basePath: string,
  environment: string,
  generatorId: string,
  suppliedInputs: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const project = await resolveProject(basePath, environment, suppliedInputs);
  const plan = await planGeneration(
    basePath,
    environment,
    generatorId,
    suppliedInputs,
  );
  const environmentDocument = project.sourceFiles.find(
    (file) => file.category === "environment" && file.id === environment,
  );
  if (!environmentDocument)
    throw new CliError(
      "ENVIRONMENT_MISSING",
      `Environment ${environment} source is missing`,
    );
  const environmentFile = await readSafeYaml(
    await safeRoot(basePath),
    environmentDocument.path,
  );
  const environmentValue = isRecord(environmentFile.value)
    ? environmentFile.value
    : {};
  const configuredTarget = isRecord(environmentValue.targets)
    ? environmentValue.targets[generatorId]
    : undefined;
  if (!isRecord(configuredTarget))
    throw new CliError(
      "TARGET_BINDING_MISSING",
      `Environment ${environment} has no ${generatorId} target binding`,
    );
  const targetBinding = { platform: generatorId, ...configuredTarget };
  return {
    contract: compilerProtocol.commandResults["deploy plan"],
    ...(plan.deliveryStandards
      ? { deliveryStandards: plan.deliveryStandards }
      : {}),
    mutatesTarget: false,
    requiredExecution: "customer-terminal-or-ci",
    project: project.project,
    environment,
    environmentSourceDigest: environmentDocument?.digest,
    resolutionDigest: project.digest,
    planDigest: plan.planDigest,
    generator: plan.generator,
    targetBinding,
    targetBindingDigest: digest(canonical(targetBinding)),
    assets: plan.assets.map((asset) => ({
      assetId: asset.assetId,
      target: asset.target,
    })),
    requiredApprovals: ["semantic", "platform"],
    nextCommand: `ingestron deploy apply --handoff <approved-handoff> --customer-context`,
    applyAvailable: false,
    reason:
      "Target mutation requires an independently authorised customer execution context",
  };
}
