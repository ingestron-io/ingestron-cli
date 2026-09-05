"""Real local Spark conformance, not a Databricks/Delta deployment claim."""
import ast
import importlib.util
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

os.environ["PYSPARK_PYTHON"] = sys.executable
os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable

if not os.environ.get("JAVA_HOME"):
    import jdk4py
    os.environ["JAVA_HOME"] = str(jdk4py.JAVA_HOME)

from pyspark.sql import SparkSession

root = Path(sys.argv[1])
ast.parse((root / "notebook.py").read_text())
module = importlib.util.spec_from_file_location("generated_runtime", root / "runtime.py")
runtime = importlib.util.module_from_spec(module)
module.loader.exec_module(runtime)
plan = json.loads((root / "plan.json").read_text())
spark = SparkSession.builder.master("local[2]").appName("ingestron-synthetic-conformance").config("spark.ui.enabled", "false").config("spark.sql.shuffle.partitions", "2").config("spark.sql.ansi.enabled", "true").config("spark.sql.warehouse.dir", str(root / "warehouse")).getOrCreate()
spark.sparkContext.setLogLevel("ERROR")
try:
    rows = [
        ("o1", "c1", "19.95", "complete", "2026-01-01"),
        ("o1", "c1", "25.50", "complete", "2026-01-02"),
        ("o2", "c1", "10.00", "complete", "2026-01-01"),
        ("o3", "c2", "7.00", "complete", "2026-01-01"),
        ("o4", "c1", "1000.00", "cancelled", "2026-01-01"),
        ("o5", "c1", "500.00", "complete", "2026-01-01"),
        ("o5", "c1", "500.00", "cancelled", "2026-01-02"),
    ]
    order_schema = "order_id string, customer_id string, amount string, status string, updated_at string"
    sources = {"orders": spark.createDataFrame(rows, order_schema), "customers": spark.createDataFrame([("c1", "NZ"), ("c2", "AU")], "customer_id string, country_code string")}
    frames = runtime.run_transformations(plan, sources)
    gold = frames["gold"].cache()
    actual = {row.country_code: (str(row.revenue), row.orders) for row in gold.collect()}
    assert actual == {"NZ": ("35.50", 2), "AU": ("7.00", 1)}, actual
    runtime.assert_equivalent(gold, runtime.run_transformations(plan, sources)["gold"], "replay")
    altered = spark.createDataFrame([("NZ", Decimal("35.51"), 2), ("AU", Decimal("7.00"), 1)], gold.schema)
    try:
        runtime.assert_equivalent(gold, altered, "same count wrong value")
        raise AssertionError("Value mismatch was not detected")
    except ValueError as error:
        assert "value/multiplicity" in str(error)
    for label, overrides, expected in [
        ("ambiguous tie", {"orders": spark.createDataFrame(rows + [("o1", "c1", "99.00", "complete", "2026-01-02")], order_schema)}, "Ambiguous"),
        ("join fanout", {"customers": sources["customers"].union(sources["customers"])}, "fan-out"),
        ("required null", {"orders": spark.createDataFrame(rows + [(None, "c1", "99.00", "complete", "2026-01-02")], order_schema)}, "Required"),
    ]:
        try:
            runtime.run_transformations(plan, {**sources, **overrides})["gold"].collect()
            raise AssertionError(label + " was not rejected")
        except ValueError as error:
            assert expected in str(error)
    duplicate_rows = spark.createDataFrame(rows + [rows[1]], order_schema)
    runtime.assert_equivalent(gold, runtime.run_transformations(plan, {**sources, "orders": duplicate_rows})["gold"], "identical duplicate")
    print(json.dumps({"passed": True, "spark": spark.version, "checks": ["decimal totals", "filter", "latest revision", "cancelled latest revision excluded", "join", "aggregate", "replay", "same-count wrong-value rejection", "ambiguous tie rejection", "fan-out rejection", "required null rejection", "identical duplicate", "generated notebook syntax"]}))
finally:
    spark.stop()
