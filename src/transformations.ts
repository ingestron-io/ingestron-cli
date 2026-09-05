import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import { isRecord } from "./files.js";

type Fields = Record<string, string>;
type Node = Record<string, unknown> & { id: string; op: string };
export type TransformationPlan = {
  contract: "ingestron.transformation-plan/v1";
  nodes: Node[];
  outputs: { silver: string; gold: string };
  schemas: Record<string, Fields>;
  required: Record<string, string[]>;
  sources: string[];
  requirements: string[];
  digest: string;
};
const fail = (message: string): never => {
  throw new CliError("TRANSFORMATION_INVALID", message);
};
function record(
  value: unknown,
  keys: string[],
  path: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail(`${path}: expected exactly ${keys.join(", ")}`);
  return value;
}
function name(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ||
    value.startsWith("__ingestron")
  )
    return fail(`${path}: expected a safe column/node identifier`);
  return value;
}
function type(value: unknown): string {
  if (typeof value !== "string")
    return fail("A supported explicit type is required");
  const aliases: Record<string, string> = {
    boolean: "boolean",
    bool: "boolean",
    integer: "long",
    int: "long",
    bigint: "long",
    long: "long",
    number: "double",
    double: "double",
    string: "string",
    date: "date",
    timestamp: "timestamp",
  };
  if (aliases[value]) return aliases[value]!;
  const decimal = /^decimal\(([1-9]\d?),([0-9]+)\)$/.exec(value);
  if (
    decimal &&
    Number(decimal[1]) <= 38 &&
    Number(decimal[2]) <= Number(decimal[1])
  )
    return `decimal(${Number(decimal[1])},${Number(decimal[2])})`;
  return fail(`Unsupported transformation type: ${value}`);
}
function list(value: unknown, path: string, empty = false): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    (!empty && value.length === 0)
  )
    return fail(`${path}: expected ${empty ? "0" : "1"}–128 entries`);
  return value;
}
function columns(
  value: unknown,
  fields: Fields,
  path: string,
  empty = false,
): string[] {
  const result = list(value, path, empty).map((entry) => name(entry, path));
  if (
    new Set(result).size !== result.length ||
    result.some((column) => !Object.hasOwn(fields, column))
  )
    return fail(`${path}: unknown or duplicate columns`);
  return result;
}
function numeric(value: string): boolean {
  return value === "long" || value === "double" || value.startsWith("decimal(");
}

/** Deliberately finite dataflow: no raw SQL, Python, calls, scripts or expression evaluation. */
export function compileTransformation(
  value: unknown,
  contracts: Record<string, Record<string, unknown>>,
  owner: string,
): TransformationPlan | undefined {
  if (value === undefined) return undefined;
  const graph = record(
    value,
    ["contract", "review", "nodes", "outputs"],
    "transformation",
  );
  if (graph.contract !== "ingestron.transformation/v1")
    fail("Unsupported transformation contract");
  const review = record(graph.review, ["status", "requirements"], "review");
  if (review.status !== "approved")
    fail(
      "Transformation requires explicit approved review before planning generation",
    );
  const requirements = list(review.requirements, "review.requirements");
  if (
    requirements.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 256,
    )
  )
    fail("Review must reference requirement/evidence identifiers");
  const schemas: Record<string, Fields> = Object.create(null);
  const dependencies: Record<string, string[]> = Object.create(null);
  const nodes: Node[] = [];
  const required: Record<string, string[]> = Object.create(null);
  const sources = new Set<string>();
  const input = (id: unknown): { id: string; fields: Fields } => {
    const key = name(id, "input");
    if (!Object.hasOwn(schemas, key))
      return fail(
        `Input ${key} must refer to an earlier node; cycles/forward references are not supported`,
      );
    return { id: key, fields: schemas[key]! };
  };
  for (const raw of list(graph.nodes, "nodes")) {
    if (!isRecord(raw)) fail("Node must be a mapping");
    const node = raw as Record<string, unknown>;
    const id = name(node.id, "node.id");
    if (Object.hasOwn(schemas, id)) fail(`Duplicate node ${id}`);
    let fields: Fields;
    let deps: string[] = [];
    switch (node.op) {
      case "source": {
        record(node, ["id", "op", "contract"], id);
        if (
          typeof node.contract !== "string" ||
          !Object.hasOwn(contracts, node.contract)
        )
          fail(`${id}: unknown source contract`);
        const contractId = node.contract as string;
        const schema = contracts[contractId]!.schema;
        if (!isRecord(schema)) fail(`${id}: source schema is required`);
        fields = Object.create(null);
        required[id] = [];
        for (const rawField of list(
          (schema as Record<string, unknown>).fields,
          `${id}.schema.fields`,
        )) {
          if (!isRecord(rawField)) fail(`${id}: invalid field`);
          const field = rawField as Record<string, unknown>;
          const key = name(field.name, "field.name");
          if (Object.hasOwn(fields, key)) fail(`${id}: duplicate source field`);
          fields[key] = type(field.type);
          if (typeof field.required !== "boolean")
            fail(`${id}: source nullability must be explicitly reviewed`);
          if (field.required) required[id]!.push(key);
        }
        sources.add(contractId);
        break;
      }
      case "cast": {
        record(node, ["id", "op", "input", "columns"], id);
        const previous = input(node.input);
        deps = [previous.id];
        fields = { ...previous.fields };
        if (
          !isRecord(node.columns) ||
          !Object.keys(node.columns).length ||
          Object.keys(node.columns).length > 128
        )
          fail(`${id}: columns must map existing names to supported types`);
        for (const [column, value] of Object.entries(node.columns as Fields)) {
          if (!Object.hasOwn(fields, column))
            fail(`${id}: unknown cast column ${column}`);
          fields[column] = type(value);
        }
        break;
      }
      case "filter": {
        record(node, ["id", "op", "input", "where"], id);
        const previous = input(node.input);
        deps = [previous.id];
        fields = { ...previous.fields };
        const where = record(
          node.where,
          ["column", "operator", "value"],
          `${id}.where`,
        );
        const column = columns([where.column], fields, "filter column")[0]!;
        if (
          ![
            "eq",
            "ne",
            "gt",
            "gte",
            "lt",
            "lte",
            "is_null",
            "is_not_null",
          ].includes(String(where.operator))
        )
          fail(`${id}: unsupported predicate`);
        if (where.operator === "is_null" || where.operator === "is_not_null") {
          if (where.value !== null)
            fail(`${id}: null predicates require value: null`);
        } else if (
          where.value === null ||
          !["string", "number", "boolean"].includes(typeof where.value) ||
          (typeof where.value === "string" && where.value.length > 1024) ||
          (typeof where.value === "number" && !Number.isFinite(where.value))
        )
          fail(`${id}: predicate value must be a finite scalar`);
        else if (
          (fields[column] === "boolean" && typeof where.value !== "boolean") ||
          (fields[column] === "string" && typeof where.value !== "string") ||
          (numeric(fields[column]!) &&
            !(
              typeof where.value === "number" ||
              (typeof where.value === "string" &&
                /^-?\d+(\.\d+)?$/.test(where.value))
            ))
        )
          fail(`${id}: predicate value does not match column type`);
        break;
      }
      case "deduplicate": {
        record(node, ["id", "op", "input", "keys", "orderBy"], id);
        const previous = input(node.input);
        deps = [previous.id];
        fields = { ...previous.fields };
        columns(node.keys, fields, "deduplication keys");
        const ordered = list(node.orderBy, "orderBy").map((item) => {
          const order = record(item, ["column", "direction"], "order");
          columns([order.column], fields, "order column");
          if (!["asc", "desc"].includes(String(order.direction)))
            fail(`${id}: unsupported ordering`);
          return order.column;
        });
        if (new Set(ordered).size !== ordered.length)
          fail(`${id}: duplicate ordering columns`);
        break;
      }
      case "join": {
        record(node, ["id", "op", "left", "right", "how", "on", "select"], id);
        const left = input(node.left),
          right = input(node.right);
        deps = [left.id, right.id];
        if (!["inner", "left"].includes(String(node.how)))
          fail(`${id}: only inner/left joins are supported`);
        for (const rawPair of list(node.on, "join keys")) {
          const pair = record(rawPair, ["left", "right"], "join key");
          const l = columns([pair.left], left.fields, "left key")[0]!,
            r = columns([pair.right], right.fields, "right key")[0]!;
          if (left.fields[l] !== right.fields[r])
            fail(`${id}: join keys require matching types; cast explicitly`);
        }
        fields = Object.create(null);
        for (const rawSelection of list(node.select, "join select")) {
          const selection = record(
            rawSelection,
            ["side", "column", "as"],
            "join selection",
          );
          if (selection.side !== "left" && selection.side !== "right")
            fail(`${id}: invalid join side`);
          const schema = selection.side === "left" ? left.fields : right.fields;
          const column = columns([selection.column], schema, "join column")[0]!;
          const alias = name(selection.as, "join alias");
          if (Object.hasOwn(fields, alias))
            fail(`${id}: duplicate join output`);
          fields[alias] = schema[column]!;
        }
        break;
      }
      case "aggregate": {
        record(node, ["id", "op", "input", "groupBy", "metrics"], id);
        const previous = input(node.input);
        deps = [previous.id];
        fields = Object.fromEntries(
          columns(node.groupBy, previous.fields, "groupBy", true).map((key) => [
            key,
            previous.fields[key]!,
          ]),
        );
        for (const rawMetric of list(node.metrics, "metrics")) {
          const metric = record(
            rawMetric,
            ["function", "column", "as"],
            "metric",
          );
          if (!["sum", "min", "max", "count"].includes(String(metric.function)))
            fail(`${id}: unsupported aggregate`);
          const column = columns(
            [metric.column],
            previous.fields,
            "metric column",
          )[0]!;
          if (metric.function === "sum" && !numeric(previous.fields[column]!))
            fail(`${id}: sum requires a numeric column`);
          const alias = name(metric.as, "metric alias");
          if (Object.hasOwn(fields, alias))
            fail(`${id}: duplicate aggregate output`);
          const columnType = previous.fields[column]!;
          const decimal = /^decimal\((\d+),(\d+)\)$/.exec(columnType);
          fields[alias] =
            metric.function === "count"
              ? "long"
              : metric.function === "sum" && decimal
                ? `decimal(${Math.min(38, Number(decimal[1]) + 10)},${decimal[2]})`
                : columnType;
        }
        break;
      }
      default:
        return fail(`Unsupported transformation operation ${String(node.op)}`);
    }
    schemas[id] = fields!;
    dependencies[id] = deps;
    nodes.push({ ...node, id, op: String(node.op) });
  }
  const outputs = record(graph.outputs, ["silver", "gold"], "outputs");
  const silver = input(outputs.silver).id,
    gold = input(outputs.gold).id;
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of dependencies[id]!) visit(dep);
  }
  visit(gold);
  if (!visited.has(silver))
    fail("Gold must depend on the selected silver output");
  if (visited.size !== nodes.length)
    fail("All nodes must contribute to the selected outputs");
  if (!sources.has(owner))
    fail("Transformation must include its owning source contract");
  const body = {
    contract: "ingestron.transformation-plan/v1" as const,
    nodes,
    outputs: { silver, gold },
    schemas,
    required,
    sources: [...sources].sort(),
    requirements: requirements as string[],
  };
  return {
    ...body,
    digest: `sha256:${createHash("sha256")
      .update(JSON.stringify({ ...body, review }))
      .digest("hex")}`,
  };
}
