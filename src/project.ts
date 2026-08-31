import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
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
  contract: "ingestron.contract-base-resolution/v1";
  basePath: string;
  project: { id: string; name: string };
  environment: string;
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
  contract: "ingestron.generation-plan/v1";
  resolutionDigest: string;
  environment: string;
  generator: {
    id: string;
    implementation: string;
    version: string;
    digest: string;
  };
  products: string[];
  contracts: string[];
  assets: Array<{
    assetId: string;
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
  const root = await realpath(resolve(path));
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CliError(
      "PROJECT_PATH",
      "Contract base must be a regular directory",
    );
  return root;
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

export async function resolveProject(
  basePath: string,
  environmentId: string,
  suppliedInputs: Record<string, string> = {},
): Promise<ProjectResolution> {
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
  const findings: ProjectResolution["findings"] = [];
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
    contract: "ingestron.contract-base-resolution/v1",
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
  const value = target.name ?? contract.name ?? id.replaceAll(".", "_");
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value))
    throw new CliError(
      "GENERATOR_INVALID",
      `Unsafe target name for contract ${id}`,
    );
  return value;
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
  const implementation = config.implementation;
  if (
    typeof implementation !== "string" ||
    !["fabric", "adf", "databricks"].includes(implementation)
  )
    throw new CliError(
      "GENERATOR_UNSUPPORTED",
      `Unsupported built-in generator ${String(implementation)}`,
    );
  const version = typeof config.version === "string" ? config.version : "1.0.0";
  const products = stringArray(config.products, Object.keys(project.products));
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
  const assets = contracts.map((id) => {
    const contract = project.contracts[id]!;
    const targetConfiguration = isRecord(contract.target)
      ? contract.target
      : {};
    return {
      assetId: id,
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
    contract: "ingestron.generation-plan/v1" as const,
    resolutionDigest: project.digest,
    environment,
    generator,
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
  startTime?: string;
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
  if (
    startTime !== undefined &&
    (typeof startTime !== "string" || !Number.isFinite(Date.parse(startTime)))
  )
    throw new CliError(
      "GENERATOR_INVALID",
      "ADF schedule.startTime must be an ISO timestamp",
    );
  return {
    frequency: frequency as AdfSchedule["frequency"],
    interval: Number(interval),
    ...(typeof timeZone === "string" ? { timeZone } : {}),
    ...(typeof startTime === "string" ? { startTime } : {}),
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
  const plan = await planGeneration(
    basePath,
    environment,
    generatorId,
    suppliedInputs,
  );
  const root = resolve(outputPath);
  if (root === resolve(basePath) || inside(resolve(basePath), root))
    throw new CliError(
      "OUTPUT_PATH",
      "Generated output must be outside the contract base",
    );
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "items"), { recursive: true });
  await mkdir(join(root, "definitions"), { recursive: true });
  await mkdir(join(root, "contracts"), { recursive: true });
  const project = await resolveProject(basePath, environment, suppliedInputs);
  const generatorConfig = project.generators[plan.generator.id]!;
  const schedule =
    plan.generator.implementation === "adf"
      ? adfSchedule(generatorConfig)
      : undefined;
  const files: string[] = [];
  for (const id of plan.contracts) {
    const asset = plan.assets.find((item) => item.assetId === id)!;
    const name = `pl_${asset.target.name}`;
    if (plan.generator.implementation === "adf") {
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
            plan_digest: { type: "String", defaultValue: plan.planDigest },
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
                source: isRecord(sourceAdf.source)
                  ? sourceAdf.source
                  : { type: "__BIND_SOURCE_TYPE__" },
                sink: isRecord(targetAdf.sink)
                  ? targetAdf.sink
                  : { type: "__BIND_SINK_TYPE__" },
              },
              validateDataConsistency: true,
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
                  ...(targetParameters ? { parameters: targetParameters } : {}),
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
          annotations: ["generated-by-ingestron", `plan:${plan.planDigest}`],
        },
      };
      const dataset = {
        name: datasetName,
        properties: {
          linkedServiceName: {
            referenceName: "__BIND_SOURCE_LINKED_SERVICE__",
            type: "LinkedServiceReference",
          },
          annotations: ["generated-by-ingestron"],
          type: "__BIND_DATASET_TYPE__",
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
          annotations: ["generated-by-ingestron"],
          type: "__BIND_TARGET_DATASET_TYPE__",
          typeProperties: {
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
              `plan:${plan.planDigest}`,
              "activation:manual",
            ],
            type: "ScheduleTrigger",
            typeProperties: {
              recurrence: {
                frequency: schedule.frequency,
                interval: schedule.interval,
                ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
                ...(schedule.startTime
                  ? { startTime: schedule.startTime }
                  : {}),
              },
            },
            pipelines: [
              {
                pipelineReference: {
                  referenceName: name,
                  type: "PipelineReference",
                },
                parameters: { plan_digest: plan.planDigest },
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
      const resource = {
        resources: {
          jobs: {
            [name]: {
              name,
              tags: {
                generated_by: "ingestron",
                plan_digest: plan.planDigest,
              },
              tasks: [
                {
                  task_key: "land_bronze",
                  notebook_task: {
                    notebook_path: `../src/${id}.py`,
                    base_parameters: {
                      asset_id: id,
                      plan_digest: plan.planDigest,
                      source_table: String(asset.source.dataset ?? id),
                      target_table: String(asset.target.name),
                    },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                  max_retries: 2,
                  min_retry_interval_millis: 60_000,
                },
                {
                  task_key: "reconcile",
                  depends_on: [{ task_key: "land_bronze" }],
                  notebook_task: {
                    notebook_path: "../src/reconcile.py",
                    base_parameters: { asset_id: id },
                  },
                  job_cluster_key: "__BIND_JOB_CLUSTER__",
                },
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
        `# Generated by Ingestron. Review through the generated plan before deployment.\nimport json\nfrom datetime import datetime, timezone\n\nfor name in ("asset_id", "plan_digest", "source_table", "target_table"):\n    dbutils.widgets.text(name, "")\n\nasset_id = dbutils.widgets.get("asset_id")\nplan_digest = dbutils.widgets.get("plan_digest")\nsource_table = dbutils.widgets.get("source_table")\ntarget_table = dbutils.widgets.get("target_table")\nif not all((asset_id, plan_digest, source_table, target_table)):\n    raise ValueError("asset_id, plan_digest, source_table and target_table are required")\n\nsource = spark.table(source_table)\nsource_count = source.count()\n(source.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(target_table))\ntarget_count = spark.table(target_table).count()\nif source_count != target_count:\n    raise RuntimeError(f"Reconciliation failed: source={source_count}, target={target_count}")\nprint(json.dumps({"event": "ingestron.asset.completed", "assetId": asset_id, "planDigest": plan_digest, "sourceCount": source_count, "targetCount": target_count, "at": datetime.now(timezone.utc).isoformat()}))\n`,
      );
      files.push(`resources/${id}.job.yml`, `src/${id}.py`);
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
      planDigest: plan.planDigest,
    });
    files.push("factory/factory-parameters.json");
  }
  if (plan.generator.implementation === "databricks") {
    await writeFile(
      join(root, "src", "reconcile.py"),
      `# Generated by Ingestron. The landing task performs the authoritative count check.\nimport json\nfrom datetime import datetime, timezone\n\ndbutils.widgets.text("asset_id", "")\nasset_id = dbutils.widgets.get("asset_id")\nif not asset_id:\n    raise ValueError("asset_id is required")\nprint(json.dumps({"event": "ingestron.asset.reconciled", "assetId": asset_id, "at": datetime.now(timezone.utc).isoformat()}))\n`,
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
    contract: "ingestron.generated-project/v1",
    target: plan.generator.implementation,
    environment,
    project: project.project,
    resolutionDigest: project.digest,
    planDigest: plan.planDigest,
    generator: plan.generator,
    files: sortedFiles,
    fileDigests,
    deployed: false,
  };
  await writeFile(join(root, "ingestron.lock.yaml"), YAML.stringify(manifest));
  await writeJson(join(root, "generation-plan.json"), plan);
  await writeFile(
    join(root, "README.md"),
    `# ${project.project.name} — generated ${plan.generator.implementation} source\n\nGenerated deterministically by Ingestron CLI. This source has not been deployed or validated against a customer target.\n\n- Environment: ${environment}\n- Plan: ${plan.planDigest}\n- Contracts: ${plan.contracts.length}\n\nUse \`ingestron deploy plan\` to create the customer-side deployment handoff.\n`,
  );
  return { ...manifest, outputPath: root };
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
    contract: "ingestron.generated-project-verification/v1",
    valid: true,
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
    contract: "ingestron.deployment-handoff/v1",
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
