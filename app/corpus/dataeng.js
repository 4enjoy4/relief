/* FauxCode profile: Data engineering — lakehouse-etl */
(function () {
'use strict';
const SRC = {};

/* ---------- generated-file bases ---------- */

SRC.ORDERS_JOB = `"""DE-615: incremental load of orders into the lakehouse.

Reads new and changed rows from the OLTP replica since the last watermark,
dedupes them, conforms them to the registered schema and MERGEs the result
into the Iceberg table lakehouse.raw.orders. Runs hourly from Airflow.
"""
import argparse
import logging
import time
from datetime import datetime, timedelta, timezone

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from jobs.spark.dedupe import dedupe_latest, drop_tombstones
from jobs.spark.schema_registry import SchemaRegistry
from jobs.spark.writers.iceberg_writer import IcebergWriter, MergeSpec

log = logging.getLogger("orders_incremental")

TARGET_TABLE = "lakehouse.raw.orders"
WATERMARK_TABLE = "lakehouse.meta.watermarks"
SOURCE_TABLE = "public.orders"
# Late-arriving updates get this much grace. Anything later gets a backfill ticket.
LATE_ARRIVAL_GRACE = timedelta(hours=6)


def build_session(app_name: str) -> SparkSession:
    return (
        SparkSession.builder.appName(app_name)
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config("spark.sql.catalog.lakehouse", "org.apache.iceberg.spark.SparkCatalog")
        .config("spark.sql.catalog.lakehouse.type", "rest")
        .config("spark.sql.catalog.lakehouse.uri", "http://iceberg-rest.internal.corp:8181")
        .config("spark.sql.shuffle.partitions", "200")
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )


def read_watermark(spark: SparkSession, job_name: str) -> datetime:
    rows = (
        spark.table(WATERMARK_TABLE)
        .filter(F.col("job_name") == job_name)
        .orderBy(F.col("updated_at").desc())
        .limit(1)
        .collect()
    )
    if not rows:
        # First run ever. Everything is new. Everything is also slow.
        return datetime(2020, 1, 1, tzinfo=timezone.utc)
    return rows[0]["watermark"] - LATE_ARRIVAL_GRACE


def extract(spark: SparkSession, since: datetime, jdbc_url: str) -> DataFrame:
    predicate = "updated_at >= '" + since.isoformat() + "'"
    return (
        spark.read.format("jdbc")
        .option("url", jdbc_url)
        .option("dbtable", "(SELECT * FROM " + SOURCE_TABLE + " WHERE " + predicate + ") AS src")
        .option("fetchsize", "10000")
        .load()
    )


def transform(df: DataFrame, registry: SchemaRegistry) -> DataFrame:
    expected = registry.schema_for("orders", version="v3")
    df = registry.conform(df, expected)
    df = dedupe_latest(df, keys=["order_id"], order_by="updated_at")
    df = drop_tombstones(df)
    return (
        df.withColumn("order_date", F.to_date("created_at"))
        .withColumn("_ingested_at", F.current_timestamp())
        .withColumn("_source", F.lit(SOURCE_TABLE))
    )


def run(args: argparse.Namespace) -> None:
    started = time.monotonic()
    spark = build_session("orders_incremental")
    registry = SchemaRegistry.from_config(args.schema_dir)
    writer = IcebergWriter(spark, TARGET_TABLE)

    since = read_watermark(spark, "orders_incremental")
    log.info("extracting %s updated since %s", SOURCE_TABLE, since.isoformat())

    staged = transform(extract(spark, since, args.jdbc_url), registry)
    staged.cache()
    row_count = staged.count()
    if row_count == 0:
        log.info("nothing to load; going back to sleep")
        return
    if args.dry_run:
        log.info("dry run: would merge %d rows into %s", row_count, TARGET_TABLE)
        return

    spec = MergeSpec(keys=["order_id"], update_when="src.updated_at > tgt.updated_at")
    stats = writer.merge(staged, spec)
    new_watermark = staged.agg(F.max("updated_at")).first()[0]
    writer.advance_watermark(WATERMARK_TABLE, "orders_incremental", new_watermark)

    log.info(
        "orders_incremental done: %d rows in, %d inserted, %d updated, %.1fs",
        row_count, stats.inserted, stats.updated, time.monotonic() - started,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DE-615 incremental orders load")
    parser.add_argument("--env", default="local", choices=["local", "staging", "prod"])
    parser.add_argument("--jdbc-url", default="jdbc:postgresql://warehouse-replica:5432/analytics")
    parser.add_argument("--schema-dir", default="configs/schemas")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    run(parse_args())
`;

SRC.MARTS_DDL = `-- warehouse/ddl/0004_marts.sql
-- DE-615: marts layer for the analytics serving warehouse (Postgres).
-- dbt builds the models; this DDL exists so the serving replica has the same
-- shape before the first run, and so DBAs can read it without learning Jinja.
--
-- Apply with: make ddl   (psql -v ON_ERROR_STOP=1 -f warehouse/ddl/0004_marts.sql)

CREATE SCHEMA IF NOT EXISTS marts;

SET search_path TO marts, public;

-- fct_orders: one row per order, latest state wins. Money is in minor units
-- because floating point and finance have never been friends.
CREATE TABLE IF NOT EXISTS marts.fct_orders (
    order_key           CHAR(32) PRIMARY KEY,        -- md5 surrogate from dbt_utils
    order_id            TEXT NOT NULL,
    customer_key        CHAR(32) NOT NULL,
    product_id          TEXT,
    order_date          DATE NOT NULL,
    ordered_at          TIMESTAMPTZ NOT NULL,
    status              TEXT NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'EUR',
    gross_amount_minor  BIGINT NOT NULL,
    discount_minor      BIGINT NOT NULL DEFAULT 0,
    tax_minor           BIGINT NOT NULL DEFAULT 0,
    net_amount_minor    BIGINT GENERATED ALWAYS AS (gross_amount_minor - discount_minor + tax_minor) STORED,
    item_count          INTEGER NOT NULL DEFAULT 1,
    is_reversed         BOOLEAN NOT NULL DEFAULT false,
    source_updated_at   TIMESTAMPTZ NOT NULL,
    lakehouse_ingested_at TIMESTAMPTZ,
    dbt_loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_fct_orders_order_id UNIQUE (order_id),
    CONSTRAINT ck_fct_orders_status CHECK (status IN ('placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')),
    CONSTRAINT ck_fct_orders_gross_nonneg CHECK (gross_amount_minor >= 0)
);

CREATE INDEX IF NOT EXISTS ix_fct_orders_order_date ON marts.fct_orders (order_date);
CREATE INDEX IF NOT EXISTS ix_fct_orders_customer_key ON marts.fct_orders (customer_key);
CREATE INDEX IF NOT EXISTS ix_fct_orders_source_updated_at ON marts.fct_orders (source_updated_at);

COMMENT ON TABLE marts.fct_orders IS 'Order fact table, incremental (DE-615). Grain: one row per order_id.';
COMMENT ON COLUMN marts.fct_orders.net_amount_minor IS 'gross - discount + tax, in minor units. Do not recompute downstream.';
`;

/* ---------- Airflow DAGs ---------- */

SRC.ORDERS_DAG = `"""DE-615: orders pipeline.

OLTP replica -> Spark incremental load into Iceberg -> dbt staging + marts
-> dbt tests -> trigger the DQ DAG -> Slack. Runs hourly. The "@hourly" is
aspirational between 02:00 and 03:00, when the replica vacuums.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pendulum
from airflow import DAG
from airflow.models import Variable
from airflow.operators.bash import BashOperator
from airflow.operators.python import ShortCircuitOperator
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.providers.apache.spark.operators.spark_submit import SparkSubmitOperator
from airflow.sensors.sql import SqlSensor

from dags.utils.slack_alerts import on_failure_callback, on_sla_miss

DBT_DIR = "/opt/airflow/dbt"
SPARK_CONN = "spark_k8s_data_prod"
ENV = Variable.get("LAKEHOUSE_ENV", default_var="staging")
IMAGE = "registry.internal.corp/data/lakehouse-etl:spark-{{ var.value.LAKEHOUSE_IMAGE_TAG }}"

default_args = {
    "owner": "data-platform",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "retry_exponential_backoff": True,
    "on_failure_callback": on_failure_callback,
    "sla": timedelta(minutes=50),
}


def _replica_is_fresh(**context) -> bool:
    """Skip the run when replica lag is larger than our window.

    Loading from a replica that is forty minutes behind produces an incremental
    load of nothing, followed by a very confident Slack message about it.
    """
    from airflow.providers.postgres.hooks.postgres import PostgresHook

    hook = PostgresHook(postgres_conn_id="warehouse_replica")
    row = hook.get_first("SELECT EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())")
    lag_seconds = row[0] if row else None
    context["ti"].xcom_push(key="replica_lag_seconds", value=lag_seconds)
    return lag_seconds is None or lag_seconds < 600


with DAG(
    dag_id="orders_pipeline",
    description="Incremental orders load (DE-615)",
    start_date=pendulum.datetime(2026, 8, 1, tz="UTC"),
    schedule="@hourly",
    catchup=False,
    max_active_runs=1,
    default_args=default_args,
    sla_miss_callback=on_sla_miss,
    tags=["orders", "iceberg", "dbt", "tier-1"],
) as dag:

    wait_for_replica = SqlSensor(
        task_id="wait_for_replica",
        conn_id="warehouse_replica",
        sql="SELECT pg_is_in_recovery()",
        poke_interval=60,
        timeout=15 * 60,
        mode="reschedule",
    )

    check_replica_lag = ShortCircuitOperator(
        task_id="check_replica_lag",
        python_callable=_replica_is_fresh,
    )

    load_orders = SparkSubmitOperator(
        task_id="load_orders_incremental",
        application="/opt/airflow/jobs/spark/orders_incremental.py",
        conn_id=SPARK_CONN,
        name="orders_incremental_{{ ts_nodash }}",
        application_args=["--env", ENV, "--schema-dir", "/opt/airflow/configs/schemas"],
        packages="org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.5.2",
        conf={
            "spark.executor.memory": "6g",
            "spark.executor.instances": "8",
            "spark.kubernetes.container.image": IMAGE,
            "spark.kubernetes.namespace": "data-prod",
        },
        execution_timeout=timedelta(minutes=30),
    )

    dbt_staging = BashOperator(
        task_id="dbt_run_staging",
        bash_command="cd " + DBT_DIR + " && dbt run --select staging.stg_orders staging.stg_customers --target " + ENV,
    )

    dbt_marts = BashOperator(
        task_id="dbt_run_marts",
        bash_command="cd " + DBT_DIR + " && dbt run --select marts.dim_customers marts.fct_orders --target " + ENV,
    )

    dbt_test = BashOperator(
        task_id="dbt_test_marts",
        bash_command="cd " + DBT_DIR + " && dbt test --select marts --target " + ENV,
    )

    # DQ lives in dq_checks_dag.py so its failures page the data owner,
    # not the on-call engineer who merely moved the bytes.
    trigger_dq = TriggerDagRunOperator(
        task_id="trigger_dq_checks",
        trigger_dag_id="dq_checks",
        conf={"suite": "orders_suite", "source_run": "{{ run_id }}"},
        wait_for_completion=False,
    )

    wait_for_replica >> check_replica_lag >> load_orders >> dbt_staging >> dbt_marts >> dbt_test >> trigger_dq
`;

SRC.DQ_DAG = `"""Data-quality DAG: runs Great Expectations suites against the marts.

Triggered by orders_pipeline after dbt tests pass, and on a daily schedule
as a safety net for the days when nothing triggers it and nobody notices.
"""
from __future__ import annotations

import json
from datetime import timedelta

import pendulum
from airflow import DAG
from airflow.operators.empty import EmptyOperator
from airflow.operators.python import BranchPythonOperator, PythonOperator

from dags.utils.slack_alerts import on_failure_callback, post_dq_summary

GE_ROOT = "/opt/airflow/great_expectations"
DEFAULT_SUITE = "orders_suite"
RESULTS_TABLE = "marts.dq_results"
# One failed expectation is a warning. Three is a pattern. Five is Tuesday.
QUARANTINE_THRESHOLD = 3


def _run_suite(**context) -> dict:
    """Run one checkpoint and persist the summary to marts.dq_results."""
    import great_expectations as gx
    from airflow.providers.postgres.hooks.postgres import PostgresHook

    conf = context["dag_run"].conf or {}
    suite = conf.get("suite", DEFAULT_SUITE)

    ctx = gx.get_context(project_root_dir=GE_ROOT)
    checkpoint = ctx.get_checkpoint(suite.replace("_suite", "_checkpoint"))
    result = checkpoint.run(run_name=context["run_id"])

    stats = result.get_statistics()["validation_statistics"]
    summary = {
        "suite": suite,
        "run_id": context["run_id"],
        "source_run": conf.get("source_run"),
        "success": bool(result.success),
        "evaluated": int(stats["evaluated_expectations"]),
        "failed": int(stats["unsuccessful_expectations"]),
    }

    hook = PostgresHook(postgres_conn_id="warehouse_serving")
    hook.run(
        "INSERT INTO " + RESULTS_TABLE
        + " (suite, run_id, source_run, success, evaluated, failed, payload)"
        + " VALUES (%s, %s, %s, %s, %s, %s, %s)",
        parameters=(
            summary["suite"], summary["run_id"], summary["source_run"], summary["success"],
            summary["evaluated"], summary["failed"], json.dumps(summary),
        ),
    )
    context["ti"].xcom_push(key="dq_summary", value=summary)
    return summary


def _route(**context) -> str:
    summary = context["ti"].xcom_pull(task_ids="run_orders_suite", key="dq_summary")
    if summary["success"]:
        return "all_green"
    return "quarantine_partition" if summary["failed"] >= QUARANTINE_THRESHOLD else "warn_only"


with DAG(
    dag_id="dq_checks",
    description="Great Expectations suites for the marts layer",
    start_date=pendulum.datetime(2026, 8, 1, tz="UTC"),
    schedule="0 6 * * *",
    catchup=False,
    default_args={
        "owner": "data-quality",
        "retries": 1,
        "retry_delay": timedelta(minutes=2),
        "on_failure_callback": on_failure_callback,
    },
    tags=["dq", "great-expectations"],
) as dag:

    run_suite = PythonOperator(task_id="run_orders_suite", python_callable=_run_suite)
    route = BranchPythonOperator(task_id="route_on_result", python_callable=_route)

    all_green = EmptyOperator(task_id="all_green")
    warn_only = PythonOperator(
        task_id="warn_only",
        python_callable=post_dq_summary,
        op_kwargs={"severity": "warning"},
    )
    quarantine = PythonOperator(
        task_id="quarantine_partition",
        python_callable=post_dq_summary,
        op_kwargs={"severity": "critical"},
    )

    run_suite >> route >> [all_green, warn_only, quarantine]
`;

SRC.SLACK_ALERTS = `"""Slack callbacks for the lakehouse-etl DAGs.

Everything goes to #data-pipeline-alerts. Critical DQ failures also go to
#data-oncall, which is muted by everyone except the person on call, who
has muted it too but feels bad about it.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import requests
from airflow.models import Variable

log = logging.getLogger(__name__)

WEBHOOK_VAR = "SLACK_WEBHOOK_DATA_ALERTS"
ONCALL_WEBHOOK_VAR = "SLACK_WEBHOOK_DATA_ONCALL"
AIRFLOW_URL = "https://airflow.data.internal.corp"
TIMEOUT_SECONDS = 5


def _post(webhook_var: str, payload: dict[str, Any]) -> None:
    url = Variable.get(webhook_var, default_var=None)
    if not url:
        log.warning("slack webhook %s not configured; alert dropped: %s", webhook_var, payload.get("text"))
        return
    resp = requests.post(
        url,
        data=json.dumps(payload),
        headers={"Content-Type": "application/json"},
        timeout=TIMEOUT_SECONDS,
    )
    # Slack returns 200 with body "ok". It also returns 200 for things that are not ok.


def _grid_url(dag_id: str, run_id: str, task_id: str | None = None) -> str:
    url = AIRFLOW_URL + "/dags/" + dag_id + "/grid?dag_run_id=" + run_id
    return url + "&task_id=" + task_id if task_id else url


def on_failure_callback(context: dict[str, Any]) -> None:
    ti = context["ti"]
    text = (
        ":red_circle: *" + ti.dag_id + "." + ti.task_id + "* failed"
        + " (try " + str(ti.try_number - 1) + "/" + str(ti.max_tries + 1) + ")\\n"
        + "run: " + context["run_id"] + "\\n"
        + "<" + _grid_url(ti.dag_id, context["run_id"], ti.task_id) + "|logs>"
    )
    _post(WEBHOOK_VAR, {"text": text})


def on_sla_miss(dag, task_list, blocking_task_list, slas, blocking_tis) -> None:
    blocking = ", ".join(str(t) for t in blocking_task_list) or "nothing obvious"
    text = ":hourglass: *" + dag.dag_id + "* missed its SLA\\nblocking: " + blocking
    _post(WEBHOOK_VAR, {"text": text})


def post_dq_summary(severity: str = "warning", **context: Any) -> None:
    summary = context["ti"].xcom_pull(task_ids="run_orders_suite", key="dq_summary") or {}
    icon = ":rotating_light:" if severity == "critical" else ":warning:"
    text = (
        icon + " DQ suite *" + str(summary.get("suite")) + "*: "
        + str(summary.get("failed", "?")) + "/" + str(summary.get("evaluated", "?"))
        + " expectations failed\\n"
        + "source run: " + str(summary.get("source_run")) + "\\n"
        + "<" + _grid_url("dq_checks", context["run_id"]) + "|details>"
    )
    _post(WEBHOOK_VAR, {"text": text})
    if severity == "critical":
        _post(ONCALL_WEBHOOK_VAR, {"text": text})
`;

/* ---------- Spark jobs ---------- */

SRC.DEDUPE = `"""Deduplication helpers for incremental loads.

The OLTP replica emits every version of a row it has seen since the
watermark. We keep the latest one per key and, when two versions share a
timestamp, prefer the one that looks more finished. Ties beyond that are
broken by CDC sequence, which the connector promises is monotonic.
"""
from __future__ import annotations

from typing import Iterable, Sequence

from pyspark.sql import Column, DataFrame, Window
from pyspark.sql import functions as F

# Status rank for tie-breaking. Refunded beats cancelled beats delivered,
# because a refund implies a delivery happened and someone regretted it.
STATUS_RANK = {
    "placed": 0,
    "paid": 1,
    "shipped": 2,
    "delivered": 3,
    "cancelled": 4,
    "refunded": 5,
}


def _status_rank_column(status_col: str) -> Column:
    mapping = F.create_map(*[F.lit(item) for pair in STATUS_RANK.items() for item in pair])
    return F.coalesce(mapping[F.col(status_col)], F.lit(-1))


def dedupe_latest(
    df: DataFrame,
    keys: Sequence[str],
    order_by: str = "updated_at",
    status_col: str | None = "status",
    sequence_col: str | None = "_cdc_sequence",
) -> DataFrame:
    """Keep one row per key: newest by order_by, then by status rank, then by sequence."""
    if not keys:
        raise ValueError("dedupe_latest needs at least one key column")
    missing = [column for column in keys if column not in df.columns]
    if missing:
        raise ValueError("dedupe keys not in dataframe: " + ", ".join(missing))

    ordering = [F.col(order_by).desc_nulls_last()]
    if status_col and status_col in df.columns:
        ordering.append(_status_rank_column(status_col).desc())
    if sequence_col and sequence_col in df.columns:
        ordering.append(F.col(sequence_col).desc_nulls_last())

    window = Window.partitionBy(*[F.col(key) for key in keys]).orderBy(*ordering)
    return (
        df.withColumn("_rn", F.row_number().over(window))
        .filter(F.col("_rn") == 1)
        .drop("_rn")
    )


def count_duplicates(df: DataFrame, keys: Sequence[str]) -> int:
    """How many rows dedupe_latest would remove. Cheap-ish; still a shuffle."""
    grouped = df.groupBy(*keys).count()
    extra = grouped.filter(F.col("count") > 1).agg(F.sum(F.col("count") - 1)).first()[0]
    return int(extra or 0)


def drop_tombstones(df: DataFrame, op_col: str = "_cdc_op") -> DataFrame:
    """Remove CDC delete markers after dedupe so a resurrected row survives.

    Order matters: dedupe first, then drop tombstones. Doing it the other way
    round brings back rows the source deleted on purpose, which is how we got
    ticket DE-588 and a very long Thursday.
    """
    if op_col not in df.columns:
        return df
    return df.filter((F.col(op_col).isNull()) | (F.col(op_col) != "d"))


def assert_unique(df: DataFrame, keys: Iterable[str]) -> None:
    key_list = list(keys)
    dupes = count_duplicates(df, key_list)
    if dupes:
        raise AssertionError(str(dupes) + " duplicate rows remain for keys " + ", ".join(key_list))
`;

SRC.SCHEMA_REGISTRY = `"""Versioned schemas for landed tables.

Schemas live in configs/schemas/<table>/<version>.json as plain Spark
StructType JSON. The registry loads them, conforms incoming frames and
refuses to widen a column type silently, which is the kind of thing that
sounds pedantic until a bigint becomes a string in production.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql.types import StructField, StructType

log = logging.getLogger(__name__)

# Widenings we allow without a ticket. Everything else is a schema change.
COMPATIBLE_WIDENINGS = {
    ("integer", "long"),
    ("float", "double"),
    ("date", "timestamp"),
}


class SchemaDrift(Exception):
    """Raised when the incoming frame cannot be conformed to the registered schema."""


@dataclass
class SchemaRegistry:
    root: Path
    _cache: dict[str, StructType] = field(default_factory=dict)

    @classmethod
    def from_config(cls, schema_dir: str) -> "SchemaRegistry":
        root = Path(schema_dir)
        if not root.exists():
            raise FileNotFoundError("schema dir not found: " + str(root))
        return cls(root=root)

    def schema_for(self, table: str, version: str = "latest") -> StructType:
        if version == "latest":
            version = self._latest_version(table)
        key = table + "@" + version
        if key not in self._cache:
            path = self.root / table / (version + ".json")
            with open(path) as fh:
                self._cache[key] = StructType.fromJson(json.load(fh))
            log.debug("loaded schema %s from %s", key, path)
        return self._cache[key]

    def _latest_version(self, table: str) -> str:
        versions = sorted(p.stem for p in (self.root / table).glob("v*.json"))
        if not versions:
            raise FileNotFoundError("no schema versions registered for " + table)
        return versions[-1]

    def conform(self, df: DataFrame, expected: StructType) -> DataFrame:
        """Reorder, cast and fill columns so df matches expected exactly."""
        actual = {f.name: f for f in df.schema.fields}
        selected = []
        for want in expected.fields:
            have = actual.get(want.name)
            if have is None:
                if not want.nullable:
                    raise SchemaDrift("required column missing: " + want.name)
                selected.append(F.lit(None).cast(want.dataType).alias(want.name))
                continue
            if have.dataType != want.dataType:
                self._check_widening(have, want)
                selected.append(F.col(want.name).cast(want.dataType))
            else:
                selected.append(F.col(want.name))

        extra = sorted(set(actual) - {f.name for f in expected.fields})
        if extra:
            # Extra columns are not drift, they are ambition. Logged, then dropped.
            log.info("dropping %d unregistered columns: %s", len(extra), ", ".join(extra))
        return df.select(*selected)

    @staticmethod
    def _check_widening(have: StructField, want: StructField) -> None:
        pair = (have.dataType.typeName(), want.dataType.typeName())
        if pair not in COMPATIBLE_WIDENINGS:
            raise SchemaDrift(
                "column " + have.name + " is " + pair[0] + " in source but " + pair[1]
                + " in registry; file a schema change (see docs/runbook.md, Schema drift)"
            )
`;

SRC.ICEBERG_WRITER = `"""Iceberg MERGE INTO writer with watermark bookkeeping.

Wraps the SQL we would otherwise copy between jobs. MERGE goes through
Spark SQL rather than the DataFrame API because Iceberg's row-level
operations are SQL-first and, after enough incidents, so are we.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Sequence

from pyspark.sql import DataFrame, SparkSession

log = logging.getLogger(__name__)

STAGING_VIEW_PREFIX = "_stg_"


@dataclass(frozen=True)
class MergeSpec:
    keys: Sequence[str]
    update_when: str = "true"
    delete_when: str | None = None
    exclude_from_update: Sequence[str] = ("_ingested_at",)


@dataclass
class MergeStats:
    inserted: int = 0
    updated: int = 0
    deleted: int = 0
    duration_seconds: float = 0.0
    snapshot_id: int | None = None
    extras: dict = field(default_factory=dict)


class IcebergWriter:
    def __init__(self, spark: SparkSession, table: str):
        self.spark = spark
        self.table = table

    def merge(self, source: DataFrame, spec: MergeSpec) -> MergeStats:
        started = time.monotonic()
        view = STAGING_VIEW_PREFIX + self.table.replace(".", "_") + "_" + str(int(started * 1000))
        source.createOrReplaceTempView(view)
        try:
            self.spark.sql(self._merge_sql(view, spec, source.columns))
        finally:
            self.spark.catalog.dropTempView(view)

        stats = self._read_last_snapshot_stats()
        stats.duration_seconds = round(time.monotonic() - started, 2)
        log.info(
            "merge into %s: +%d ~%d -%d in %.1fs",
            self.table, stats.inserted, stats.updated, stats.deleted, stats.duration_seconds,
        )
        return stats

    def _merge_sql(self, view: str, spec: MergeSpec, columns: Sequence[str]) -> str:
        on = " AND ".join("tgt." + key + " = src." + key for key in spec.keys)
        updatable = [c for c in columns if c not in spec.keys and c not in spec.exclude_from_update]
        set_clause = ", ".join("tgt." + c + " = src." + c for c in updatable)
        insert_cols = ", ".join(columns)
        insert_vals = ", ".join("src." + c for c in columns)

        parts = [
            "MERGE INTO " + self.table + " AS tgt",
            "USING " + view + " AS src",
            "ON " + on,
        ]
        if spec.delete_when:
            parts.append("WHEN MATCHED AND " + spec.delete_when + " THEN DELETE")
        parts.append("WHEN MATCHED AND " + spec.update_when + " THEN UPDATE SET " + set_clause)
        parts.append("WHEN NOT MATCHED THEN INSERT (" + insert_cols + ") VALUES (" + insert_vals + ")")
        return "\\n".join(parts)

    def _read_last_snapshot_stats(self) -> MergeStats:
        row = self.spark.sql(
            "SELECT snapshot_id, summary FROM " + self.table + ".snapshots ORDER BY committed_at DESC LIMIT 1"
        ).first()
        if row is None:
            return MergeStats()
        summary = row["summary"] or {}
        # Iceberg reports counts as strings in the summary map, and an update
        # as one deleted plus one added record. We reconstruct and forgive.
        added = int(summary.get("added-records", 0))
        deleted = int(summary.get("deleted-records", 0))
        updated = min(added, deleted)
        return MergeStats(
            inserted=added - updated,
            updated=updated,
            deleted=deleted - updated,
            snapshot_id=row["snapshot_id"],
            extras={"added-files-size": summary.get("added-files-size")},
        )

    def advance_watermark(self, watermark_table: str, job_name: str, value: datetime | None) -> None:
        if value is None:
            log.warning("refusing to advance watermark for %s to NULL", job_name)
            return
        row = self.spark.createDataFrame(
            [(job_name, value, datetime.utcnow())],
            "job_name string, watermark timestamp, updated_at timestamp",
        )
        row.createOrReplaceTempView("_stg_watermark")
        self.spark.sql(
            "MERGE INTO " + watermark_table + " AS tgt USING _stg_watermark AS src"
            + " ON tgt.job_name = src.job_name"
            + " WHEN MATCHED AND src.watermark > tgt.watermark THEN UPDATE SET *"
            + " WHEN NOT MATCHED THEN INSERT *"
        )
        self.spark.catalog.dropTempView("_stg_watermark")
        log.info("watermark %s -> %s", job_name, value.isoformat())

    def expire_snapshots(self, older_than_days: int = 7, retain_last: int = 20) -> None:
        """Housekeeping. Iceberg keeps every snapshot forever unless told otherwise, like an inbox."""
        cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).isoformat()
        self.spark.sql(
            "CALL lakehouse.system.expire_snapshots(table => '" + self.table + "',"
            + " older_than => TIMESTAMP '" + cutoff + "',"
            + " retain_last => " + str(retain_last) + ")"
        )
`;

/* ---------- dbt ---------- */

SRC.STG_ORDERS = `{{
  config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    on_schema_change='append_new_columns',
    tags=['staging', 'orders']
  )
}}

-- DE-615: staging model over the Iceberg raw.orders table (exposed to the
-- serving warehouse as an external table). One row per order_id, typed,
-- renamed, nothing clever. Clever lives in marts.

with source as (

    select * from {{ source('lakehouse_raw', 'orders') }}

    {% if is_incremental() %}
    where updated_at >= {{ incremental_window('source_updated_at', hours=6) }}
    {% endif %}

),

renamed as (

    select
        cast(order_id as varchar)                          as order_id,
        cast(customer_id as varchar)                       as customer_id,
        cast(product_id as varchar)                        as product_id,
        cast(created_at as timestamp)                      as ordered_at,
        cast(updated_at as timestamp)                      as source_updated_at,
        cast(order_date as date)                           as order_date,
        lower(trim(status))                                as status,
        upper(coalesce(currency, 'EUR'))                   as currency,
        -- amounts arrive as decimal(18,2); the marts want minor units
        cast(round(gross_amount * 100) as bigint)          as gross_amount_minor,
        cast(round(coalesce(discount, 0) * 100) as bigint) as discount_minor,
        cast(round(coalesce(tax, 0) * 100) as bigint)      as tax_minor,
        coalesce(item_count, 1)                            as item_count,
        _ingested_at                                       as lakehouse_ingested_at

    from source

),

final as (

    select
        *,
        gross_amount_minor - discount_minor + tax_minor as net_amount_minor
    from renamed
    where order_id is not null
      -- test orders from the QA environment leak through the replica about once a quarter
      and customer_id not like 'qa-%'
      and {{ reprocess_from('source_updated_at') }}

)

select * from final
`;

SRC.STG_CUSTOMERS = `{{ config(materialized='view', tags=['staging', 'customers']) }}

-- Customer staging. The source has a "country" column that is sometimes a
-- country, sometimes a city, and once was the string "yes". We use
-- country_code instead and pretend the other column does not exist.

with source as (

    select * from {{ source('lakehouse_raw', 'customers') }}

),

renamed as (

    select
        cast(customer_id as varchar)                 as customer_id,
        nullif(trim(email), '')                      as email,
        nullif(trim(full_name), '')                  as full_name,
        upper(nullif(trim(country_code), ''))        as country_code,
        coalesce(lower(segment), 'unknown')          as segment,
        coalesce(marketing_opt_in, false)            as marketing_opt_in,
        cast(created_at as timestamp)                as signed_up_at,
        cast(updated_at as timestamp)                as source_updated_at,
        cast(deleted_at as timestamp)                as deleted_at

    from source

)

select
    *,
    deleted_at is not null as is_deleted,
    case
        when country_code in ('DE', 'AT', 'CH') then 'dach'
        when country_code in ('GB', 'IE') then 'uk_ie'
        when country_code in ('US', 'CA') then 'north_america'
        else 'rest_of_world'
    end as region
from renamed
`;

SRC.FCT_ORDERS = `{{
  config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    on_schema_change='fail',
    tags=['marts', 'orders', 'tier-1']
  )
}}

-- DE-615: order fact. Grain: one row per order_id, latest state wins.
-- Surrogate keys via dbt_utils so the serving DB and the lakehouse agree on them.

with orders as (

    select * from {{ ref('stg_orders') }}

    {% if is_incremental() %}
    -- Reprocess a trailing window so late updates from the OLTP side land.
    -- Six hours was chosen scientifically: the replica has never been later than five.
    where source_updated_at >= {{ incremental_window('source_updated_at', hours=6) }}
    {% endif %}

),

customers as (

    select customer_id, customer_key
    from {{ ref('dim_customers') }}

),

joined as (

    select
        {{ dbt_utils.generate_surrogate_key(['o.order_id']) }} as order_key,
        o.order_id,
        coalesce(c.customer_key, '{{ var("unknown_customer_key") }}') as customer_key,
        o.product_id,
        o.order_date,
        o.ordered_at,
        o.status,
        o.currency,
        o.gross_amount_minor,
        o.discount_minor,
        o.tax_minor,
        o.net_amount_minor,
        o.item_count,
        o.status in ('cancelled', 'refunded') as is_reversed,
        o.source_updated_at,
        o.lakehouse_ingested_at,
        {{ dbt.current_timestamp() }} as dbt_loaded_at

    from orders o
    left join customers c on c.customer_id = o.customer_id

),

-- A negative net amount is always a unit bug upstream, never a real order.
-- Clamp it, flag it, let the DQ suite make the noise.
guarded as (

    select
        joined.*,
        net_amount_minor < 0 as has_negative_net
    from joined

)

select * from guarded
`;

SRC.DIM_CUSTOMERS = `{{ config(materialized='table', tags=['marts', 'customers']) }}

-- Customer dimension, type 1. History is a feature request (DE-640), not a bug.

with customers as (

    select * from {{ ref('stg_customers') }}

),

order_facts as (

    select
        customer_id,
        min(order_date) as first_order_date,
        max(order_date) as last_order_date,
        count(*)        as lifetime_orders,
        sum(case when status not in ('cancelled', 'refunded') then net_amount_minor else 0 end) as lifetime_net_minor
    from {{ ref('stg_orders') }}
    group by 1

),

final as (

    select
        {{ dbt_utils.generate_surrogate_key(['c.customer_id']) }} as customer_key,
        c.customer_id,
        c.email,
        c.full_name,
        c.country_code,
        c.region,
        c.segment,
        c.marketing_opt_in,
        c.signed_up_at,
        c.is_deleted,
        f.first_order_date,
        f.last_order_date,
        coalesce(f.lifetime_orders, 0)    as lifetime_orders,
        coalesce(f.lifetime_net_minor, 0) as lifetime_net_minor,
        case
            when f.lifetime_orders is null then 'prospect'
            when f.last_order_date < current_date - interval '180 days' then 'lapsed'
            when f.lifetime_orders >= 10 then 'loyal'
            else 'active'
        end as lifecycle_stage,
        c.source_updated_at,
        {{ dbt.current_timestamp() }} as dbt_loaded_at
    from customers c
    left join order_facts f on f.customer_id = c.customer_id

)

select * from final

union all

-- The "unknown" member. Orders whose customer never made it through CDC
-- join here instead of quietly vanishing from the revenue report.
select
    '{{ var("unknown_customer_key") }}' as customer_key,
    'unknown'                            as customer_id,
    null                                 as email,
    'Unknown customer'                   as full_name,
    null                                 as country_code,
    'rest_of_world'                      as region,
    'unknown'                            as segment,
    false                                as marketing_opt_in,
    null                                 as signed_up_at,
    false                                as is_deleted,
    null                                 as first_order_date,
    null                                 as last_order_date,
    0                                    as lifetime_orders,
    0                                    as lifetime_net_minor,
    'unknown'                            as lifecycle_stage,
    null                                 as source_updated_at,
    {{ dbt.current_timestamp() }}        as dbt_loaded_at
`;

SRC.MARTS_SCHEMA = `version: 2

sources:
  - name: lakehouse_raw
    description: Iceberg raw layer, exposed to the serving warehouse as external tables.
    schema: "{{ var('lakehouse_raw_schema') }}"
    loader: jobs/spark (DE-615)
    freshness:
      warn_after: { count: 2, period: hour }
      error_after: { count: 6, period: hour }
    loaded_at_field: _ingested_at
    tables:
      - name: orders
        description: One row per order version seen by CDC, deduped by orders_incremental.py.
      - name: customers
        description: Customer snapshot, refreshed nightly by customers_snapshot.

models:
  - name: fct_orders
    description: >
      One row per order, latest state wins. Incremental with a six hour
      reprocessing window (DE-615). Amounts are in minor units.
    columns:
      - name: order_key
        description: md5 surrogate of order_id.
        tests:
          - unique
          - not_null
      - name: order_id
        tests:
          - unique
          - not_null
      - name: customer_key
        tests:
          - not_null
          - relationships:
              to: ref('dim_customers')
              field: customer_key
      - name: order_date
        tests:
          - not_null
          - dbt_utils.accepted_range:
              min_value: "'2019-01-01'"
              max_value: "current_date + interval '1 day'"
      - name: status
        tests:
          - accepted_values:
              values: ['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']
      - name: currency
        tests:
          - not_null
      - name: gross_amount_minor
        tests:
          - not_null
          - dbt_utils.accepted_range:
              min_value: 0
              # anything above this has so far always been a unit bug, not a yacht
              max_value: 50000000
      - name: net_amount_minor
        tests:
          - not_null
      - name: has_negative_net
        tests:
          - accepted_values:
              values: [false]
              severity: warn
      - name: source_updated_at
        tests:
          - not_null

  - name: dim_customers
    description: Type 1 customer dimension with lifetime order aggregates and the unknown member.
    columns:
      - name: customer_key
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - unique
          - not_null
      - name: region
        tests:
          - accepted_values:
              values: ['dach', 'uk_ie', 'north_america', 'rest_of_world']
      - name: lifecycle_stage
        tests:
          - accepted_values:
              values: ['prospect', 'active', 'loyal', 'lapsed', 'unknown']
      - name: lifetime_net_minor
        tests:
          - dbt_utils.accepted_range:
              min_value: 0
`;

SRC.INCREMENTAL_WINDOW = `{#
  incremental_window(column, hours)

  Returns a timestamp expression: the max(column) already in this model,
  minus a grace window. Used in the is_incremental() branch of staging and
  marts models so late-arriving updates are reprocessed instead of ignored.

  Usage:
    where updated_at >= {{ incremental_window('updated_at', hours=6) }}

  The subquery is cheap on Postgres (index on the column) and free on
  Iceberg (partition stats). It is not free on the analyst's laptop.
#}
{% macro incremental_window(column, hours=6) -%}
    (
        select coalesce(
            max({{ column }}) - interval '{{ hours }} hours',
            {{ dbt.string_literal("2020-01-01") }}::timestamp
        )
        from {{ this }}
    )
{%- endmacro %}


{#
  reprocess_from(column): opt-in override for backfills.
    dbt run --select fct_orders+ --vars '{"reprocess_from": "2026-08-01"}'
  Renders to "true" when the var is unset so it can sit in any where clause.
#}
{% macro reprocess_from(column) -%}
    {%- set start = var('reprocess_from', none) -%}
    {%- if start is not none -%}
        {{ column }} >= '{{ start }}'::timestamp
    {%- else -%}
        true
    {%- endif -%}
{%- endmacro %}
`;

SRC.DBT_PROJECT = `name: lakehouse_etl
version: 1.9.0
config-version: 2

profile: lakehouse_etl

model-paths: ["models"]
macro-paths: ["macros"]
test-paths: ["tests"]
seed-paths: ["seeds"]
target-path: target
clean-targets: [target, dbt_packages]

require-dbt-version: [">=1.8.0", "<2.0.0"]

vars:
  # md5 of the empty string is what the "unknown" dimension member gets. Poetic.
  unknown_customer_key: d41d8cd98f00b204e9800998ecf8427e
  lakehouse_raw_schema: raw

models:
  lakehouse_etl:
    +materialized: view
    +persist_docs:
      relation: true
      columns: true
    staging:
      +schema: staging
      +tags: [staging]
    marts:
      +schema: marts
      +materialized: table
      +tags: [marts]

tests:
  lakehouse_etl:
    +store_failures: true
    +schema: dq_failures

on-run-end:
  - "{{ log('run finished; the marts are as good as the sources let them be', info=true) }}"
`;

/* ---------- Great Expectations ---------- */

SRC.ORDERS_SUITE = `{
  "expectation_suite_name": "orders_suite",
  "data_asset_type": "Dataset",
  "meta": {
    "great_expectations_version": "0.18.12",
    "owner": "data-quality",
    "ticket": "DE-615",
    "notes": "Runs against marts.fct_orders after each orders_pipeline run. Thresholds are reviewed quarterly and adjusted whenever they page someone twice."
  },
  "expectations": [
    {
      "expectation_type": "expect_table_row_count_to_be_between",
      "kwargs": { "min_value": 1000, "max_value": 250000000 },
      "meta": { "severity": "critical" }
    },
    {
      "expectation_type": "expect_table_columns_to_match_set",
      "kwargs": {
        "column_set": [
          "order_key", "order_id", "customer_key", "product_id", "order_date", "ordered_at",
          "status", "currency", "gross_amount_minor", "discount_minor", "tax_minor",
          "net_amount_minor", "item_count", "is_reversed", "source_updated_at",
          "lakehouse_ingested_at", "dbt_loaded_at", "has_negative_net"
        ],
        "exact_match": false
      },
      "meta": { "severity": "critical" }
    },
    {
      "expectation_type": "expect_column_values_to_be_unique",
      "kwargs": { "column": "order_id" },
      "meta": { "severity": "critical" }
    },
    {
      "expectation_type": "expect_column_values_to_not_be_null",
      "kwargs": { "column": "customer_key" },
      "meta": { "severity": "critical" }
    },
    {
      "expectation_type": "expect_column_values_to_be_in_set",
      "kwargs": {
        "column": "status",
        "value_set": ["placed", "paid", "shipped", "delivered", "cancelled", "refunded"]
      },
      "meta": { "severity": "critical" }
    },
    {
      "expectation_type": "expect_column_values_to_be_between",
      "kwargs": { "column": "gross_amount_minor", "min_value": 0, "max_value": 50000000, "mostly": 0.9999 },
      "meta": {
        "severity": "warning",
        "notes": "mostly < 1 because one customer really did buy four hundred office chairs"
      }
    },
    {
      "expectation_type": "expect_column_values_to_be_between",
      "kwargs": { "column": "item_count", "min_value": 1, "max_value": 500 },
      "meta": { "severity": "warning" }
    },
    {
      "expectation_type": "expect_column_values_to_match_regex",
      "kwargs": { "column": "currency", "regex": "^[A-Z]{3}$" },
      "meta": { "severity": "warning" }
    },
    {
      "expectation_type": "expect_column_pair_values_A_to_be_greater_than_B",
      "kwargs": { "column_A": "gross_amount_minor", "column_B": "discount_minor", "or_equal": true, "mostly": 0.999 },
      "meta": { "severity": "warning", "notes": "a discount larger than the order is a coupon stacking bug, not generosity" }
    },
    {
      "expectation_type": "expect_column_max_to_be_between",
      "kwargs": {
        "column": "order_date",
        "min_value": { "$PARAMETER": "now() - timedelta(days=2)" },
        "max_value": { "$PARAMETER": "now() + timedelta(days=1)" }
      },
      "meta": { "severity": "critical", "notes": "freshness: if the newest order is two days old, the pipeline is asleep" }
    },
    {
      "expectation_type": "expect_column_proportion_of_unique_values_to_be_between",
      "kwargs": { "column": "customer_key", "min_value": 0.05, "max_value": 0.95 },
      "meta": { "severity": "warning", "notes": "guards against the unknown member swallowing every order" }
    },
    {
      "expectation_type": "expect_column_values_to_be_in_set",
      "kwargs": { "column": "has_negative_net", "value_set": [false], "mostly": 0.9995 },
      "meta": { "severity": "warning" }
    }
  ]
}
`;

/* ---------- configs ---------- */

SRC.PIPELINE_YML = `# lakehouse-etl pipeline configuration.
# Change values here, not in the code. The code will find out eventually.

environments:
  local:
    jdbc_url: jdbc:postgresql://localhost:5432/analytics
    iceberg_catalog_uri: http://localhost:8181
    spark_master: local[4]
    dbt_target: dev
  staging:
    jdbc_url: jdbc:postgresql://warehouse-replica.staging.internal.corp:5432/analytics
    iceberg_catalog_uri: http://iceberg-rest.staging.internal.corp:8181
    spark_master: k8s://https://k8s.staging.internal.corp:6443
    dbt_target: staging
  prod:
    jdbc_url: jdbc:postgresql://warehouse-replica:5432/analytics
    iceberg_catalog_uri: http://iceberg-rest.internal.corp:8181
    spark_master: k8s://https://k8s.internal.corp:6443
    dbt_target: prod

jobs:
  orders_incremental:
    ticket: DE-615
    schedule: "@hourly"
    source_table: public.orders
    target_table: lakehouse.raw.orders
    keys: [order_id]
    order_by: updated_at
    late_arrival_grace_hours: 6
    schema: orders/v3
    spark:
      executor_instances: 8
      executor_memory: 6g
      shuffle_partitions: 200
    alerts:
      channel: "#data-pipeline-alerts"
      page_on_failure: true
  customers_snapshot:
    ticket: DE-602
    schedule: "0 1 * * *"
    source_table: public.customers
    target_table: lakehouse.raw.customers
    keys: [customer_id]
    mode: full_refresh
    schema: customers/v2
    spark:
      executor_instances: 4
      executor_memory: 4g
      shuffle_partitions: 64
    alerts:
      channel: "#data-pipeline-alerts"
      page_on_failure: false

watermarks:
  table: lakehouse.meta.watermarks
  # never advance a watermark past now() minus this; the replica occasionally
  # reports timestamps from a few seconds into the future and we let it
  clock_skew_seconds: 120

data_quality:
  results_table: marts.dq_results
  suites:
    orders_suite:
      checkpoint: orders_checkpoint
      quarantine_threshold: 3

retention:
  iceberg_snapshot_days: 7
  iceberg_retain_last: 20
  airflow_log_days: 30
`;

/* ---------- tests ---------- */

SRC.TEST_DEDUPE = `"""Tests for jobs.spark.dedupe (DE-615)."""
import pytest
from pyspark.sql import SparkSession

from jobs.spark.dedupe import assert_unique, count_duplicates, dedupe_latest, drop_tombstones


@pytest.fixture(scope="session")
def spark():
    # local[1] keeps the suite deterministic and the laptop fan quiet
    session = (
        SparkSession.builder.master("local[1]")
        .appName("test_dedupe")
        .config("spark.ui.enabled", "false")
        .getOrCreate()
    )
    yield session
    session.stop()


@pytest.fixture
def orders(spark):
    rows = [
        ("o-1", "placed", "2026-09-01T10:00:00", 1),
        ("o-1", "paid", "2026-09-01T10:05:00", 2),
        ("o-2", "placed", "2026-09-01T11:00:00", 3),
        ("o-2", "cancelled", "2026-09-01T11:00:00", 4),  # same timestamp, later status
        ("o-3", "shipped", "2026-09-02T09:00:00", 5),
        ("o-3", "shipped", "2026-09-02T09:00:00", 6),  # identical, higher sequence
    ]
    return spark.createDataFrame(rows, "order_id string, status string, updated_at string, _cdc_sequence int")


def test_keeps_one_row_per_key(orders):
    result = dedupe_latest(orders, keys=["order_id"]).collect()
    assert sorted(r.order_id for r in result) == ["o-1", "o-2", "o-3"]


def test_prefers_newest_updated_at(orders):
    result = {r.order_id: r.status for r in dedupe_latest(orders, keys=["order_id"]).collect()}
    assert result["o-1"] == "paid"


def test_breaks_timestamp_ties_by_status_rank(orders):
    result = {r.order_id: r.status for r in dedupe_latest(orders, keys=["order_id"]).collect()}
    assert result["o-2"] == "cancelled"


def test_breaks_full_ties_by_sequence(orders):
    result = {r.order_id: r._cdc_sequence for r in dedupe_latest(orders, keys=["order_id"]).collect()}
    assert result["o-3"] == 6


def test_count_duplicates(orders):
    assert count_duplicates(orders, ["order_id"]) == 3


def test_rejects_missing_keys(orders):
    with pytest.raises(ValueError, match="not in dataframe"):
        dedupe_latest(orders, keys=["order_id", "warehouse_id"])


def test_drop_tombstones_after_dedupe(spark):
    rows = [("o-9", "d", "2026-09-01T10:00:00"), ("o-9", "u", "2026-09-01T10:30:00")]
    df = spark.createDataFrame(rows, "order_id string, _cdc_op string, updated_at string")
    survivors = drop_tombstones(dedupe_latest(df, keys=["order_id"], status_col=None)).collect()
    assert len(survivors) == 1
    assert survivors[0]._cdc_op == "u"


def test_assert_unique_raises_with_count(orders):
    with pytest.raises(AssertionError, match="3 duplicate rows"):
        assert_unique(orders, ["order_id"])
`;

SRC.TEST_INCREMENTAL = `"""Tests for the DE-615 incremental orders job and the Iceberg writer.

Spark is mocked wherever we can get away with it. Where we cannot, the
session is local[1] and the tests are honest about being slow.
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from pyspark.sql import SparkSession

from jobs.spark import orders_incremental as job
from jobs.spark.writers.iceberg_writer import IcebergWriter, MergeSpec, MergeStats


@pytest.fixture(scope="session")
def spark():
    session = (
        SparkSession.builder.master("local[1]")
        .appName("test_incremental")
        .config("spark.ui.enabled", "false")
        .getOrCreate()
    )
    yield session
    session.stop()


@pytest.fixture
def writer():
    return IcebergWriter(spark=MagicMock(), table="lakehouse.raw.orders")


def _spark_with_watermark(rows):
    spark = MagicMock()
    chain = spark.table.return_value.filter.return_value.orderBy.return_value.limit.return_value
    chain.collect.return_value = rows
    return spark


# --- MergeSpec / SQL generation -------------------------------------------

def test_merge_sql_joins_on_all_keys(writer):
    spec = MergeSpec(keys=["order_id", "warehouse_id"])
    sql = writer._merge_sql("_stg_orders", spec, ["order_id", "warehouse_id", "status"])
    assert "ON tgt.order_id = src.order_id AND tgt.warehouse_id = src.warehouse_id" in sql


def test_merge_sql_excludes_keys_and_ingested_at_from_update(writer):
    spec = MergeSpec(keys=["order_id"])
    sql = writer._merge_sql("_stg_orders", spec, ["order_id", "status", "_ingested_at"])
    update_clause = sql.split("UPDATE SET ")[1].split("\\n")[0]
    assert update_clause == "tgt.status = src.status"


def test_merge_sql_adds_delete_branch_when_requested(writer):
    spec = MergeSpec(keys=["order_id"], delete_when="src._cdc_op = 'd'")
    sql = writer._merge_sql("_stg_orders", spec, ["order_id", "_cdc_op"])
    assert "WHEN MATCHED AND src._cdc_op = 'd' THEN DELETE" in sql


def test_merge_sql_has_no_delete_branch_by_default(writer):
    sql = writer._merge_sql("_stg_orders", MergeSpec(keys=["order_id"]), ["order_id", "status"])
    assert "DELETE" not in sql


def test_update_condition_is_rendered(writer):
    spec = MergeSpec(keys=["order_id"], update_when="src.updated_at > tgt.updated_at")
    sql = writer._merge_sql("_stg_orders", spec, ["order_id", "updated_at"])
    assert "WHEN MATCHED AND src.updated_at > tgt.updated_at THEN UPDATE SET" in sql


# --- watermarks -----------------------------------------------------------

def test_first_run_starts_from_epoch_floor():
    spark = _spark_with_watermark([])
    assert job.read_watermark(spark, "orders_incremental") == datetime(2020, 1, 1, tzinfo=timezone.utc)


def test_watermark_is_rewound_by_grace_period():
    stored = datetime(2026, 9, 7, 8, 0, tzinfo=timezone.utc)
    spark = _spark_with_watermark([{"watermark": stored}])
    assert job.read_watermark(spark, "orders_incremental") == stored - job.LATE_ARRIVAL_GRACE


def test_advance_watermark_refuses_none(writer, caplog):
    writer.advance_watermark("lakehouse.meta.watermarks", "orders_incremental", None)
    writer.spark.sql.assert_not_called()
    assert "refusing to advance" in caplog.text


# --- transform ------------------------------------------------------------

@pytest.mark.slow
def test_transform_adds_lineage_columns(spark):
    registry = MagicMock()
    registry.conform.side_effect = lambda df, _schema: df
    src = spark.createDataFrame(
        [("o-1", "paid", "2026-09-07 08:00:00", "2026-09-07 08:05:00")],
        "order_id string, status string, created_at string, updated_at string",
    )
    out = job.transform(src, registry)
    assert {"order_date", "_ingested_at", "_source"} <= set(out.columns)
    assert out.first()["_source"] == job.SOURCE_TABLE


def test_merge_stats_defaults_are_zero():
    stats = MergeStats()
    assert (stats.inserted, stats.updated, stats.deleted) == (0, 0, 0)
    assert stats.snapshot_id is None
`;

/* ---------- build & packaging ---------- */

SRC.MAKEFILE = `# lakehouse-etl — common entry points.
# "make watch" is what you want 90% of the time. "make backfill" is what you
# want 10% of the time and regret 5%.

.PHONY: watch airflow spark-local dbt-run dbt-test dq test lint ddl backfill clean

ENV ?= local
AIRFLOW_HOME ?= $(PWD)/.airflow
DBT_DIR = dbt
ICEBERG_PKG = org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.5.2

watch:
	watchmedo auto-restart --patterns="*.py;*.sql;*.yml" --recursive -d dags -d jobs -d dbt -- make airflow

airflow:
	AIRFLOW_HOME=$(AIRFLOW_HOME) AIRFLOW__CORE__DAGS_FOLDER=$(PWD)/dags airflow standalone

spark-local:
	spark-submit --master local[4] --packages $(ICEBERG_PKG) \\
		jobs/spark/orders_incremental.py --env $(ENV)

dbt-run:
	cd $(DBT_DIR) && dbt deps && dbt run --target $(ENV)

dbt-test:
	cd $(DBT_DIR) && dbt test --target $(ENV)

dq:
	great_expectations checkpoint run orders_checkpoint

test:
	python -m pytest -q tests

lint:
	ruff check dags jobs tests && mypy jobs dags

ddl:
	psql "$(WAREHOUSE_DSN)" -v ON_ERROR_STOP=1 -f warehouse/ddl/0004_marts.sql

backfill:
	airflow dags backfill orders_pipeline --start-date $(FROM) --end-date $(TO) --reset-dagruns -y

clean:
	rm -rf $(DBT_DIR)/target $(DBT_DIR)/dbt_packages logs/*.log
`;

SRC.DOCKERFILE = `# lakehouse-etl runtime image: Airflow + PySpark + dbt in one container.
# Yes, it is large. So is the data.
FROM registry.internal.corp/base/airflow:2.9.3-python3.11

USER root
RUN apt-get update \\
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless procps \\
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
USER airflow

WORKDIR /opt/airflow
COPY requirements.txt pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.txt

COPY dags/ dags/
COPY jobs/ jobs/
COPY dbt/ dbt/
COPY configs/ configs/
COPY great_expectations/ great_expectations/

# dbt deps at build time so a flaky package mirror cannot fail a 03:00 run
RUN cd dbt && dbt deps --profiles-dir .

ENV AIRFLOW__CORE__DAGS_FOLDER=/opt/airflow/dags \\
    AIRFLOW__CORE__LOAD_EXAMPLES=false \\
    LAKEHOUSE_ENV=prod

CMD ["airflow", "scheduler"]
`;

SRC.REQUIREMENTS = `# Pinned for the runtime image. Upgrade in a PR, not in prod.
apache-airflow==2.9.3
apache-airflow-providers-apache-spark==4.8.1
apache-airflow-providers-postgres==5.11.1
pyspark==3.5.1
pyiceberg==0.7.0
dbt-core==1.8.5
dbt-postgres==1.8.2
great-expectations==0.18.12
pendulum==3.0.0
requests==2.32.3
pyarrow==16.1.0
pyyaml==6.0.1
psycopg2-binary==2.9.9

# dev
pytest==8.3.2
pytest-cov==5.0.0
ruff==0.5.6
mypy==1.11.1
watchdog==4.0.1
`;

SRC.PYPROJECT = `[project]
name = "lakehouse-etl"
version = "1.9.0"
description = "Airflow DAGs, PySpark jobs and dbt models for the analytics lakehouse"
requires-python = ">=3.11"
readme = "README.md"

[tool.setuptools.packages.find]
include = ["dags*", "jobs*"]

[tool.ruff]
line-length = 88
target-version = "py311"
src = ["dags", "jobs", "tests"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
# E501 stays on. The long lines are Spark configs, and they are long on purpose.
ignore = ["B008"]

[tool.ruff.lint.isort]
known-first-party = ["dags", "jobs"]

[tool.mypy]
python_version = "3.11"
strict = true
warn_return_any = true
ignore_missing_imports = true
exclude = ["tests/", "dbt/", "great_expectations/"]

[[tool.mypy.overrides]]
module = "pyspark.*"
ignore_errors = true

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers -p no:cacheprovider"
filterwarnings = ["ignore::DeprecationWarning:pyspark.*"]
markers = ["slow: needs a local Spark session"]

[tool.coverage.run]
source = ["jobs", "dags"]
omit = ["*/__init__.py"]
`;

SRC.RUNBOOK = `# lakehouse-etl runbook

On-call notes for the orders pipeline (DE-615) and the DQ DAG. Read this
before restarting anything. Especially before restarting anything twice.

## Pages you will get

| Alert | Where | First thing to check |
|---|---|---|
| orders_pipeline.load_orders_incremental failed | #data-pipeline-alerts | Spark driver log in the Airflow task, then the Spark UI on :4040 |
| orders_pipeline missed SLA | #data-pipeline-alerts | replica lag (check_replica_lag XCom "replica_lag_seconds") |
| dq_checks quarantine_partition | #data-oncall | marts.dq_results, newest row for orders_suite |

## Replica lag

The DAG short-circuits when the replica is more than ten minutes behind.
That is not a failure. Do nothing; the next hourly run picks it up. If it
short-circuits three times in a row, the replica is probably vacuuming
something it should have vacuumed last week. Ping #dba.

## Schema drift

SchemaDrift in the Spark log means a source column changed type in a way
configs/schemas/orders/<version>.json does not allow.

1. Confirm the change with the owning team (usually orders-platform).
2. Add a new schema version file, e.g. configs/schemas/orders/v4.json.
3. Bump "schema" in configs/pipeline.yml and in orders_incremental.py.
4. Re-run the failed task. Do not clear the downstream dbt tasks by hand;
   they are wired to rerun.

## Backfills

Backfills replay the incremental job for a date range and then run dbt
with the reprocess_from var so the marts pick up the window:

    make backfill FROM=2026-08-01 TO=2026-08-03
    cd dbt && dbt run --select fct_orders+ --vars '{"reprocess_from": "2026-08-01"}'

Backfills longer than seven days need a heads-up in #data-platform,
because the Spark job will hold the executor pool and the nightly
customers_snapshot job is polite but not patient.

## Rolling back a bad load

Iceberg keeps snapshots for seven days (configs/pipeline.yml, retention).
Find the snapshot before the bad run and roll back:

    SELECT snapshot_id, committed_at, summary
    FROM lakehouse.raw.orders.snapshots ORDER BY committed_at DESC LIMIT 5;

    CALL lakehouse.system.rollback_to_snapshot('raw.orders', <snapshot_id>);

Then set the watermark in lakehouse.meta.watermarks to the committed_at of
that snapshot minus the grace window, and re-run. The marts rebuild on the
next dbt run because everything downstream is keyed on source_updated_at.

## Things that look broken but are not

- The Spark UI on :4040 disappears when the job finishes. It is supposed to.
- dbt reports "0 rows affected" on the staging models at 02:00. The
  replica vacuums at 02:00. See "Replica lag".
- The Jupyter kernel on :8888 belongs to whoever left it running. It is
  not part of the pipeline, however much its CPU graph suggests otherwise.
- Great Expectations prints a banner about telemetry on every run. It has
  been disabled in great_expectations.yml. It prints the banner anyway.
`;

SRC.README = `# lakehouse-etl

ETL monorepo for the analytics platform: Airflow DAGs orchestrating PySpark
jobs that land data into Iceberg tables, dbt models for the marts layer and
Great Expectations suites that tell us, politely, when the marts are wrong.

## Layout

- dags/                 Airflow DAGs (orders_pipeline, dq_checks) and Slack callbacks
- jobs/spark/           PySpark jobs: incremental loads, dedupe, schema registry, Iceberg writer
- dbt/                  staging + marts models, macros, project config
- great_expectations/   expectation suites and checkpoints
- warehouse/ddl/        DDL for the Postgres serving copy of the marts
- configs/              pipeline.yml and versioned schemas
- docs/runbook.md       what to do when it pages you

## Local development

    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env
    make watch          # airflow standalone on :8080, restarts on file changes
    make spark-local    # run the orders job against your local replica
    make dbt-run        # build staging + marts into the dev schema
    make test           # pytest; the Spark tests take a minute

The Airflow UI lives on :8080, the Spark UI on :4040 while a job runs, and
dbt docs on :8081 after make dbt-docs. Jupyter on :8888 is yours to manage.

## Conventions

- One ticket per branch, ticket id in the branch name and the commit subject.
- Amounts are integers in minor units everywhere past staging.
- Schema changes go through configs/schemas and a new version file, never
  through a cast in a model. See the runbook, Schema drift.
- Every marts model has tests in schema.yml. A model without tests is a rumour.

## Deployment

Merges to main build registry.internal.corp/data/lakehouse-etl and roll the
airflow-scheduler deployment in the data-prod namespace. DAG changes are live
within a minute; job changes need the image tag bumped in LAKEHOUSE_IMAGE_TAG.
`;

PROFILES.register({
  id: 'dataeng',
  label: 'Data engineering',
  stack: 'Airflow · PySpark · dbt',
  desc: 'Lakehouse ETL monorepo: Airflow DAGs, PySpark jobs into Iceberg, dbt marts, data-quality checks.',
  project: 'lakehouse-etl',
  version: '1.9.0',
  branch: 'feature/DE-615-incremental-orders',
  remote: 'gitlab.internal.corp:data/lakehouse-etl',
  image: 'registry.internal.corp/data/lakehouse-etl',
  deployName: 'airflow-scheduler',
  namespace: 'data-prod',
  dbLine: 'postgres://warehouse-replica:5432/analytics',
  migrateLines: [],
  primaryLang: 'py',
  checker: 'pyright',
  checkFiles: 84,
  termproc: 'python — lakehouse-etl',
  hmrPath: null,
  shell: { user: 'dev', host: 'data-wb-03', pkg: 'pip' },
  ports: [
    [8080, 'Airflow webserver', 'gunicorn'],
    [4040, 'Spark UI', 'java'],
    [8081, 'dbt docs', 'python'],
    [8888, 'Jupyter', 'python'],
  ],
  scripts: [
    ['watch', 'watchmedo auto-restart --patterns="*.py;*.sql;*.yml" --recursive -d dags -d jobs -d dbt -- make airflow'],
    ['spark-local', 'spark-submit --master local[4] jobs/spark/orders_incremental.py --env local'],
    ['dbt-run', 'cd dbt && dbt deps && dbt run --target local'],
    ['dbt-test', 'cd dbt && dbt test --target local'],
    ['dq', 'great_expectations checkpoint run orders_checkpoint'],
    ['test', 'python -m pytest -q tests'],
  ],
  branches: [
    'main',
    'develop',
    'feature/DE-615-incremental-orders',
    'feature/DE-602-customers-snapshot',
    'feature/DE-640-scd2-customers',
    'hotfix/DE-611-dq-suite-timeout',
    'chore/DE-590-airflow-2.9-upgrade',
  ],
  commits: [
    ['7c2e91a', 'feat(orders): merge-into writer with watermark bookkeeping (DE-615)', 'Ingrid Halvorsen', '3 hours ago'],
    ['b04d7f3', 'feat(dags): short-circuit orders_pipeline on replica lag', 'Tomasz Wierzbicki', '6 hours ago'],
    ['e91a2c8', 'test(dedupe): tie-break by status rank then cdc sequence', 'Ingrid Halvorsen', '8 hours ago'],
    ['3fa6b1d', 'fix(dbt): stg_orders discount null handling', 'Priya Raman', 'yesterday'],
    ['a17c05e', 'chore(ge): raise gross_amount ceiling after the office chair incident', 'Marcus Oyelaran', 'yesterday'],
    ['5d8e3b9', 'feat(dq): quarantine branch when >= 3 expectations fail', 'Priya Raman', '2 days ago'],
    ['c2f04a7', 'docs(runbook): rollback via iceberg snapshots', 'Tomasz Wierzbicki', '2 days ago'],
    ['91be6d2', 'refactor(schema_registry): explicit widening allowlist', 'Ingrid Halvorsen', '3 days ago'],
    ['0ac9e44', 'ci: run dbt test against ephemeral schema per MR', 'Marcus Oyelaran', '4 days ago'],
    ['f6d12b0', 'chore: bump airflow to 2.9.3, pyspark to 3.5.1', 'Tomasz Wierzbicki', '5 days ago'],
  ],
  lintFiles: [
    ['dags/orders_pipeline_dag.py', '9:22   "datetime.datetime" imported but unused', 'F401'],
    ['dags/utils/slack_alerts.py', '29:5   Local variable "resp" is assigned to but never used', 'F841'],
    ['jobs/spark/dedupe.py', '31:89  Line too long (91 > 88)', 'E501'],
    ['jobs/spark/schema_registry.py', '55:16  Returning Any from function declared to return "StructType"', 'no-any-return'],
  ],
  suites: [
    ['tests/test_dedupe.py', 6, 9],
    ['tests/test_incremental.py', 8, 12],
  ],
  jobs: ['airflow', 'spark', 'dbtrun', 'dbttest', 'greatexpectations', 'pytest', 'ruff', 'mypy', 'pipinstall', 'gitfetch', 'docker', 'dataset'],
  bootLines: [
    '<span class="mag">$</span> source .venv/bin/activate',
    '<span class="mag">$</span> make watch',
    '<span class="dim">&gt; airflow standalone</span>',
    '<span class="dim">standalone | Starting Airflow Standalone</span>',
    '<span class="dim">standalone | Checking database is initialized</span>',
    '<span class="dim">scheduler  | DagBag: 14 DAGs loaded from /opt/airflow/dags in 2.31s</span>',
    '<span class="info">webserver  | Listening at: http://0.0.0.0:8080</span>',
    '<span class="dim">watchdog: observing dags/, jobs/, dbt/models/</span>',
    '  <span class="dim">watching for file changes...</span>',
  ],
  debug: {
    conf: 'Python: jobs/spark/orders_incremental.py',
    vars: [
      ['since', 'datetime(2026, 9, 7, 2, 0, tzinfo=UTC)'],
      ['row_count', '48213'],
      ['spec.keys', "['order_id']"],
      ['stats.inserted', '31904'],
      ['stats.updated', '16309'],
    ],
    watch: [
      ['staged.rdd.getNumPartitions()', '200'],
      ['new_watermark', 'datetime(2026, 9, 7, 8, 41, 2)'],
      ['time.monotonic() - started', '184.3'],
    ],
    stack: [
      'run  orders_incremental.py:94',
      'IcebergWriter.merge  iceberg_writer.py:51',
      '<module>  orders_incremental.py:117',
    ],
  },
  files: () => [
    ['jobs/spark/orders_incremental.py', genLargePythonModule(SRC.ORDERS_JOB, 'OrdersIncrementalJob', 'incremental load', ['validate_batch', 'normalize_rows', 'resolve_watermark', 'stage_partition', 'merge_into_target', 'publish_metrics', 'reconcile_counts'], 1100), true],
    ['warehouse/ddl/0004_marts.sql', genLargeSql(SRC.MARTS_DDL, 'marts', ['fct_orders', 'dim_customers', 'dim_products', 'fct_sessions', 'agg_daily_revenue', 'dq_results', 'pipeline_runs', 'snapshot_manifest'], 600), true],
    ['dags/orders_pipeline_dag.py', SRC.ORDERS_DAG, true],
    ['dags/dq_checks_dag.py', SRC.DQ_DAG],
    ['dags/utils/slack_alerts.py', SRC.SLACK_ALERTS],
    ['jobs/spark/dedupe.py', SRC.DEDUPE, true],
    ['jobs/spark/schema_registry.py', SRC.SCHEMA_REGISTRY],
    ['jobs/spark/writers/iceberg_writer.py', SRC.ICEBERG_WRITER, true],
    ['dbt/models/staging/stg_orders.sql', SRC.STG_ORDERS],
    ['dbt/models/staging/stg_customers.sql', SRC.STG_CUSTOMERS],
    ['dbt/models/marts/fct_orders.sql', SRC.FCT_ORDERS, true],
    ['dbt/models/marts/dim_customers.sql', SRC.DIM_CUSTOMERS],
    ['dbt/models/marts/schema.yml', SRC.MARTS_SCHEMA],
    ['dbt/macros/incremental_window.sql', SRC.INCREMENTAL_WINDOW],
    ['dbt/dbt_project.yml', SRC.DBT_PROJECT],
    ['great_expectations/expectations/orders_suite.json', SRC.ORDERS_SUITE],
    ['configs/pipeline.yml', SRC.PIPELINE_YML],
    ['tests/test_dedupe.py', SRC.TEST_DEDUPE],
    ['tests/test_incremental.py', SRC.TEST_INCREMENTAL],
    ['Makefile', SRC.MAKEFILE],
    ['Dockerfile', SRC.DOCKERFILE],
    ['requirements.txt', SRC.REQUIREMENTS],
    ['pyproject.toml', SRC.PYPROJECT],
    ['docs/runbook.md', SRC.RUNBOOK],
    ['.env.example', genEnv([['LAKEHOUSE_ENV', 'local'], ['WAREHOUSE_DSN', 'postgres://warehouse-replica:5432/analytics'], ['ICEBERG_REST_URI', 'http://localhost:8181'], ['AIRFLOW__CORE__FERNET_KEY', 'changeme'], ['SLACK_WEBHOOK_DATA_ALERTS', 'https://hooks.example/localdev']])],
    ['README.md', SRC.README],
  ],
  tree: () => [
    d('.venv', [d('lib', []), d('bin', [])]),
    d('configs', [fnode('configs/pipeline.yml')], true),
    d('dags', [
      d('utils', [fnode('dags/utils/slack_alerts.py')], true),
      fnode('dags/orders_pipeline_dag.py'),
      fnode('dags/dq_checks_dag.py'),
    ], true),
    d('dbt', [
      d('macros', [fnode('dbt/macros/incremental_window.sql')], true),
      d('models', [
        d('marts', [
          fnode('dbt/models/marts/dim_customers.sql'),
          fnode('dbt/models/marts/fct_orders.sql'),
          fnode('dbt/models/marts/schema.yml'),
        ], true),
        d('staging', [
          fnode('dbt/models/staging/stg_customers.sql'),
          fnode('dbt/models/staging/stg_orders.sql'),
        ], true),
      ], true),
      d('target', []),
      fnode('dbt/dbt_project.yml'),
    ], true),
    d('docs', [fnode('docs/runbook.md')]),
    d('great_expectations', [d('expectations', [fnode('great_expectations/expectations/orders_suite.json')], true)], true),
    d('jobs', [
      d('spark', [
        d('writers', [fnode('jobs/spark/writers/iceberg_writer.py')], true),
        fnode('jobs/spark/dedupe.py'),
        fnode('jobs/spark/orders_incremental.py'),
        fnode('jobs/spark/schema_registry.py'),
      ], true),
    ], true),
    d('logs', []),
    d('tests', [fnode('tests/test_dedupe.py'), fnode('tests/test_incremental.py')], true),
    d('warehouse', [d('ddl', [fnode('warehouse/ddl/0004_marts.sql')], true)], true),
    fnode('.env.example'), fnode('Dockerfile'), fnode('Makefile'), fnode('pyproject.toml'),
    fnode('README.md'), fnode('requirements.txt'),
  ],
});
})();
