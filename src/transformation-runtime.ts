import type { TransformationPlan } from "./transformations.js";

/** Original finite Spark implementation. No eval/exec/SQL expressions from evidence. */
export const transformationRuntime = String.raw`import json
from functools import reduce
from pyspark.sql import functions as F, Window

def run_transformations(spec, sources):
    frames = {}
    for node in spec["nodes"]:
        op, key = node["op"], node["id"]
        if op == "source":
            frame = sources[node["contract"]]
            expected = list(spec["schemas"][key])
            if set(expected) - set(frame.columns):
                raise ValueError("Source is missing contracted columns: " + key)
            aliases = {"int": "long", "bigint": "long", "smallint": "long", "tinyint": "long", "float": "double"}
            actual_types = {field.name: aliases.get(field.dataType.simpleString(), field.dataType.simpleString()) for field in frame.schema}
            if any(actual_types[column] != spec["schemas"][key][column] for column in expected):
                raise ValueError("Source types differ from the reviewed contract: " + key)
            frame = frame.select(*expected)
            required = spec["required"].get(key, [])
            if required and frame.filter(reduce(lambda a, b: a | b, [F.col(column).isNull() for column in required])).limit(1).count():
                raise ValueError("Required source values are null: " + key)
        elif op == "cast":
            frame = frames[node["input"]]
            frame = frame.select(*[F.col(column).cast(spec["schemas"][key][column]).alias(column) if column in node["columns"] else F.col(column) for column in frame.columns])
        elif op == "filter":
            frame = frames[node["input"]]
            predicate = node["where"]
            column = F.col(predicate["column"])
            operator = predicate["operator"]
            value = F.lit(predicate["value"]).cast(spec["schemas"][node["input"]][predicate["column"]])
            conditions = {"eq": lambda: column == value, "ne": lambda: column != value, "gt": lambda: column > value, "gte": lambda: column >= value, "lt": lambda: column < value, "lte": lambda: column <= value, "is_null": column.isNull, "is_not_null": column.isNotNull}
            frame = frame.filter(conditions[operator]())
        elif op == "deduplicate":
            frame = frames[node["input"]].dropDuplicates()
            if frame.filter(reduce(lambda a, b: a | b, [F.col(column).isNull() for column in node["keys"]])).limit(1).count():
                raise ValueError("Deduplication keys contain nulls: " + key)
            tie_columns = list(dict.fromkeys(node["keys"] + [entry["column"] for entry in node["orderBy"]]))
            if frame.groupBy(*tie_columns).agg(F.count(F.lit(1)).alias("__ingestron_count")).filter(F.col("__ingestron_count") > 1).limit(1).count():
                raise ValueError("Ambiguous deduplication tie; add a stable ordering column: " + key)
            order = [F.col(entry["column"]).asc_nulls_last() if entry["direction"] == "asc" else F.col(entry["column"]).desc_nulls_last() for entry in node["orderBy"]]
            frame = frame.withColumn("__ingestron_rank", F.row_number().over(Window.partitionBy(*node["keys"]).orderBy(*order))).filter(F.col("__ingestron_rank") == 1).drop("__ingestron_rank")
        elif op == "join":
            left, right = frames[node["left"]], frames[node["right"]]
            right_keys = list(dict.fromkeys(pair["right"] for pair in node["on"]))
            if right.groupBy(*right_keys).agg(F.count(F.lit(1)).alias("__ingestron_count")).filter(F.col("__ingestron_count") > 1).limit(1).count():
                raise ValueError("Join requires unique right-side keys; fan-out rejected: " + key)
            left, right = left.alias("l"), right.alias("r")
            condition = reduce(lambda a, b: a & b, [F.col("l." + pair["left"]) == F.col("r." + pair["right"]) for pair in node["on"]])
            frame = left.join(right, condition, node["how"]).select(*[F.col(("l." if item["side"] == "left" else "r.") + item["column"]).alias(item["as"]) for item in node["select"]])
        elif op == "aggregate":
            frame = frames[node["input"]]
            functions = {"sum": F.sum, "min": F.min, "max": F.max, "count": F.count}
            frame = frame.groupBy(*node["groupBy"]).agg(*[functions[item["function"]](F.col(item["column"])).alias(item["as"]) for item in node["metrics"]])
        else:
            raise ValueError("Unsupported operation")
        frames[key] = frame
    return frames

def assert_equivalent(expected, actual, label):
    if set(actual.columns) != set(expected.columns):
        raise ValueError("Reconciliation schema mismatch: " + label)
    actual = actual.select(*expected.columns)
    if expected.schema.simpleString() != actual.schema.simpleString():
        raise ValueError("Reconciliation type mismatch: " + label)
    if expected.exceptAll(actual).limit(1).count() or actual.exceptAll(expected).limit(1).count():
        raise ValueError("Reconciliation value/multiplicity mismatch: " + label)
`;

export function transformationNotebook(
  plan: TransformationPlan,
  sources: Record<string, string>,
  format: string,
  projectId: string,
  contractId: string,
  nativeEvidence = false,
) {
  const literal = (value: unknown) =>
    `json.loads(${JSON.stringify(JSON.stringify(value))})`;
  return `${transformationRuntime}
import re
from datetime import datetime, timezone

spec = ${literal(plan)}
source_paths = ${literal(sources)}
project_id = ${literal(projectId)}
contract_id = ${literal(contractId)}
for key in ("stage", "silver_table", "gold_table", "plan_digest", "snapshot_id"${nativeEvidence ? ', "owner_digest", "reservation_digest", "storage_binding_digest", "source_digest"' : ""}):
    dbutils.widgets.text(key, "")
stage = dbutils.widgets.get("stage")
silver_table = dbutils.widgets.get("silver_table")
gold_table = dbutils.widgets.get("gold_table")
if not dbutils.widgets.get("snapshot_id") or not dbutils.widgets.get("plan_digest"):
    raise ValueError("Snapshot and generation plan identifiers are required")
${
  nativeEvidence
    ? `for key in ("owner_digest", "reservation_digest", "storage_binding_digest", "source_digest"):
    if not dbutils.widgets.get(key):
        raise ValueError("Native evidence identifiers are required")
`
    : ""
}for table in (silver_table, gold_table):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*", table):
        raise ValueError("Explicit catalog.schema.table targets are required")
spark.conf.set("spark.sql.ansi.enabled", "true")
spark.conf.set("spark.sql.session.timeZone", "UTC")
sources = {key: spark.read.format(${literal(format)}).load(path) for key, path in source_paths.items()}
frames = run_transformations(spec, sources)
silver, gold = frames[spec["outputs"]["silver"]], frames[spec["outputs"]["gold"]]

def publish(frame, table):
    exists = spark.catalog.tableExists(table)
    if exists:
        properties = {row[0]: row[1] for row in spark.sql("SHOW TBLPROPERTIES " + table).collect()}
        if properties.get("ingestron.project") != project_id or properties.get("ingestron.contract") != contract_id:
            raise ValueError("Refusing to overwrite an unowned table")
    frame.write.format("delta").mode("overwrite" if exists else "errorifexists").option("overwriteSchema", "false").saveAsTable(table)
    def quote(value):
        return "'" + value.replace("'", "''") + "'"
    spark.sql("ALTER TABLE " + table + " SET TBLPROPERTIES ('ingestron.project'=" + quote(project_id) + ", 'ingestron.contract'=" + quote(contract_id) + ")")

if stage == "validate_bronze":
    counts = {key: frame.count() for key, frame in sources.items()}
elif stage == "build_silver":
    publish(silver, silver_table)
    counts = {"silver": spark.table(silver_table).count()}
elif stage == "publish_gold":
    assert_equivalent(silver, spark.table(silver_table), "silver before gold")
    publish(gold, gold_table)
    counts = {"gold": spark.table(gold_table).count()}
elif stage == "reconcile":
    assert_equivalent(silver, spark.table(silver_table), "silver")
    assert_equivalent(gold, spark.table(gold_table), "gold")
    counts = {"silver": silver.count(), "gold": gold.count()}
else:
    raise ValueError("Unsupported stage")
${
  nativeEvidence
    ? `if stage == "reconcile":
    history = spark.sql("DESCRIBE HISTORY " + gold_table + " LIMIT 1").collect()
    if len(history) != 1 or history[0]["version"] is None:
        raise ValueError("Delta publication version is unavailable")
    result = {"contract": "ingestron.databricks-publication-result/v1", "planDigest": dbutils.widgets.get("plan_digest"), "ownerDigest": dbutils.widgets.get("owner_digest"), "reservationDigest": dbutils.widgets.get("reservation_digest"), "storageBindingDigest": dbutils.widgets.get("storage_binding_digest"), "sourceDigest": dbutils.widgets.get("source_digest"), "table": gold_table, "deltaVersion": str(history[0]["version"]), "checks": [{"id": "silver-gold-row-count", "expected": counts["silver"], "actual": counts["gold"]}]}
    dbutils.notebook.exit(json.dumps(result, separators=(",", ":")))
else:
    print(json.dumps({"event": "ingestron.transformation.completed", "stage": stage, "contractId": contract_id, "transformationDigest": spec["digest"], "planDigest": dbutils.widgets.get("plan_digest"), "snapshotId": dbutils.widgets.get("snapshot_id"), "counts": counts, "at": datetime.now(timezone.utc).isoformat()}))
`
    : `print(json.dumps({"event": "ingestron.transformation.completed", "stage": stage, "contractId": contract_id, "transformationDigest": spec["digest"], "planDigest": dbutils.widgets.get("plan_digest"), "snapshotId": dbutils.widgets.get("snapshot_id"), "counts": counts, "at": datetime.now(timezone.utc).isoformat()}))
`
}`;
}
