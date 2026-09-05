import { CliError } from "./errors.js";
import { isRecord } from "./files.js";
import {
  resolveStandardsRelease,
  type StandardsReleaseLock,
} from "./standards-release.js";

type Pack = {
  id: string;
  version: string;
  digest: string;
  release?: StandardsReleaseLock;
};
export type DeliveryStandards = {
  contract: "ingestron.delivery-standards-lock/v1";
  organisation: Pack;
  infrastructure: Pack;
  products: Record<string, { elt: Pack }>;
  capabilities: string[];
};

type StandardSource = {
  id: string;
  value: Record<string, unknown>;
  digest: string;
};
const invalid = (message: string): never => {
  throw new CliError("STANDARDS_INVALID", message);
};
const incompatible = (message: string): never => {
  throw new CliError("STANDARDS_INCOMPATIBLE", message);
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function strings(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.length) ||
    new Set(value).size !== value.length
  )
    return invalid(`${label} must be an array of distinct non-empty strings`);
  return value as string[];
}

function selfContained(value: unknown): boolean {
  if (typeof value === "string") return !/\{\{|\}\}|\{%/.test(value);
  if (Array.isArray(value)) return value.every(selfContained);
  return (
    !isRecord(value) ||
    (!Object.hasOwn(value, "$ref") && Object.values(value).every(selfContained))
  );
}

function pin(
  value: unknown,
  layer: string,
  sources: StandardSource[],
): { lock: Pack; pack: Record<string, unknown> } {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest)
  )
    return invalid(
      `${layer} requires an exact id, version and sha256 digest pin`,
    );
  const source = sources.find((item) => item.id === value.id);
  if (!source) return invalid(`Unknown ${layer} standard ${value.id}`);
  if (
    source.value.apiVersion !== "ingestron.io/v1alpha1" ||
    source.value.layer !== layer ||
    source.value.kind !== "StandardsPack" ||
    !selfContained(source.value)
  )
    return invalid(
      `${value.id} must be a self-contained ${layer} StandardsPack; configure values in bindings, not release manifests`,
    );
  const metadata = isRecord(source.value.metadata) ? source.value.metadata : {};
  if (
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
    metadata.version !== value.version ||
    source.digest !== value.digest
  )
    return incompatible(
      `${layer} standard ${value.id} changed or does not match its pinned version/digest`,
    );
  return {
    lock: {
      id: value.id,
      version: value.version,
      digest: value.digest,
      ...(source.value.release === undefined
        ? {}
        : {
            release: resolveStandardsRelease(
              source.value.release,
              `${value.id}.release`,
            ),
          }),
    },
    pack: source.value,
  };
}

function policyPaths(
  policy: unknown,
  pack: Record<string, unknown>,
  label: string,
): void {
  if (policy === undefined) return;
  if (!isRecord(policy))
    return invalid(
      `${label} invariants must be a mapping of object paths to exact values`,
    );
  for (const [path, expected] of Object.entries(policy)) {
    const parts = path.split(".");
    if (
      !parts.length ||
      parts.some(
        (part) =>
          !/^[A-Za-z][A-Za-z0-9_-]*$/.test(part) ||
          ["constructor", "prototype", "__proto__"].includes(part),
      )
    )
      return invalid(`Unsupported invariant object path ${path}`);
    let actual: unknown = pack;
    for (const part of parts)
      actual =
        isRecord(actual) && Object.hasOwn(actual, part)
          ? actual[part]
          : undefined;
    if (actual === undefined || canonical(actual) !== canonical(expected))
      return incompatible(`${label} violates organisation invariant ${path}`);
  }
}

function productDelivery(product: Record<string, unknown>): unknown {
  if (isRecord(product.product)) {
    const extension = product.product["x-ingestron"];
    return isRecord(extension) ? extension.delivery : undefined;
  }
  return product.delivery;
}

/** Validate declarations and locks; this does not attest to customer connectivity. */
export function resolveDeliveryStandards(input: {
  manifest: Record<string, unknown>;
  environment: Record<string, unknown>;
  products: Record<string, Record<string, unknown>>;
  sources: StandardSource[];
}): DeliveryStandards | undefined {
  const root = input.manifest.delivery,
    environment = input.environment.delivery;
  const hasProducts = Object.values(input.products).some(
    (product) => productDelivery(product) !== undefined,
  );
  if (root === undefined && environment === undefined && !hasProducts)
    return undefined;
  if (!isRecord(root) || !isRecord(environment))
    return invalid(
      "Layered delivery requires base organisation and environment infrastructure bindings",
    );
  const organisation = pin(root.organisation, "organisation", input.sources);
  const infrastructure = pin(
    environment.infrastructure,
    "infrastructure",
    input.sources,
  );
  const capabilities = strings(
    infrastructure.pack.capabilities,
    "Infrastructure capabilities",
  );
  const invariants = organisation.pack.invariants;
  if (!isRecord(invariants))
    return invalid("Organisation standard must declare its invariants mapping");
  if (
    Object.keys(invariants).some(
      (key) => key !== "infrastructure" && key !== "elt",
    )
  )
    return invalid(
      "Organisation invariants support only infrastructure and elt object-path mappings",
    );
  policyPaths(
    invariants.infrastructure,
    infrastructure.pack,
    infrastructure.lock.id,
  );
  const allowedInfrastructure = strings(
    organisation.pack.allowedInfrastructure,
    "Allowed infrastructure standards",
  );
  const allowedElt = strings(
    organisation.pack.allowedElt,
    "Allowed ELT standards",
  );
  if (!allowedInfrastructure.includes(infrastructure.lock.id))
    return incompatible(
      "Infrastructure standard is not allowed by organisation policy",
    );
  const products: DeliveryStandards["products"] = {};
  for (const [id, product] of Object.entries(input.products)) {
    const delivery = productDelivery(product);
    // Unbound products can be catalogued/drafted but not selected for a layered build.
    if (delivery === undefined) continue;
    if (!isRecord(delivery))
      return invalid(`Product ${id} delivery must be a mapping`);
    const elt = pin(delivery.elt, "elt", input.sources);
    if (!allowedElt.includes(elt.lock.id))
      return incompatible(
        `ELT standard ${elt.lock.id} is not allowed by organisation policy`,
      );
    policyPaths(invariants.elt, elt.pack, elt.lock.id);
    const requirements = strings(
      elt.pack.requires,
      `${elt.lock.id} required capabilities`,
    );
    const missing = requirements.filter((item) => !capabilities.includes(item));
    if (missing.length)
      return incompatible(
        `Product ${id} needs infrastructure capabilities: ${missing.join(", ")}`,
      );
    const compatibility = elt.pack.infrastructureCompatibility;
    if (
      !Array.isArray(compatibility) ||
      !compatibility.some(
        (item) =>
          isRecord(item) &&
          item.id === infrastructure.lock.id &&
          Array.isArray(item.versions) &&
          item.versions.includes(infrastructure.lock.version),
      )
    )
      return incompatible(
        `${elt.lock.id} does not support ${infrastructure.lock.id}@${infrastructure.lock.version}`,
      );
    const architecture = isRecord(elt.pack.architecture)
      ? elt.pack.architecture
      : {};
    const handoff = isRecord(architecture.handoff) ? architecture.handoff : {};
    if (
      typeof handoff.contract !== "string" ||
      !strings(
        infrastructure.pack.handoffs,
        "Infrastructure handoffs",
      ).includes(handoff.contract)
    )
      return incompatible(
        `${elt.lock.id} handoff is not provided by the infrastructure standard`,
      );
    products[id] = { elt: elt.lock };
  }
  return {
    contract: "ingestron.delivery-standards-lock/v1",
    organisation: organisation.lock,
    infrastructure: infrastructure.lock,
    products,
    capabilities,
  };
}

export function assertDeliverySelection(
  lock: DeliveryStandards | undefined,
  products: string[],
  selectedStandards: string[],
): string | undefined {
  if (!lock) return undefined;
  if (!products.length)
    return invalid(
      "Layered generation requires an explicit non-empty product selection",
    );
  const eltIds = new Set<string>();
  for (const id of products) {
    const binding = lock.products[id];
    if (!binding)
      return invalid(
        `Product ${id} needs an ELT standard binding before generation`,
      );
    eltIds.add(binding.elt.id);
    if (!selectedStandards.includes(binding.elt.id))
      return incompatible(
        `Generator must select the pinned ELT standard ${binding.elt.id} for product ${id}`,
      );
  }
  if (eltIds.size !== 1)
    return incompatible(
      "This generator run requires one ELT release; use separate generator configurations for products on different releases",
    );
  return [...eltIds][0];
}
