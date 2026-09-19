"""Local, atomic maintenance work orders derived from detector evidence."""
from __future__ import annotations

import sqlite3
import threading
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from backend.detector import utc_now


class OrderConflict(ValueError):
    pass


class OrderStore:
    def __init__(self, database: Path | str):
        self.database = Path(database)
        self._init_lock = threading.Lock()
        self._initialized = False

    @contextmanager
    def _connect(self):
        with self._init_lock:
            if not self._initialized:
                self.database.parent.mkdir(parents=True, exist_ok=True)
                with closing(sqlite3.connect(self.database, timeout=15)) as connection, connection:
                    connection.execute("PRAGMA journal_mode=WAL")
                    connection.execute("""CREATE TABLE IF NOT EXISTS work_orders (
                        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, train_id TEXT NOT NULL,
                        component TEXT NOT NULL, issue TEXT NOT NULL, priority TEXT NOT NULL,
                        action TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','in_progress','completed')),
                        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
                    connection.execute("""CREATE UNIQUE INDEX IF NOT EXISTS active_component_order
                        ON work_orders(dataset_id, train_id, component) WHERE status != 'completed'""")
                self._initialized = True
        connection = sqlite3.connect(self.database, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def list(self, dataset_id: str | None = None) -> list[dict]:
        with self._connect() as connection:
            if dataset_id:
                rows = connection.execute("SELECT * FROM work_orders WHERE dataset_id = ? ORDER BY created_at DESC", (dataset_id,)).fetchall()
            else:
                rows = connection.execute("SELECT * FROM work_orders ORDER BY created_at DESC").fetchall()
            return [dict(row) for row in rows]

    def create(self, detail: dict) -> dict:
        if detail["status"] not in ("warning", "critical"):
            raise OrderConflict("A maintenance order requires a warning or critical advisory with measured evidence. Unknown/healthy observations remain monitoring or data-review tasks.")
        explanation = detail["explanation"]
        now = utc_now()
        fields = (detail["dataset_id"], detail["train_id"], detail["component"])
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("""SELECT * FROM work_orders WHERE dataset_id=? AND train_id=?
                AND component=? AND status != 'completed'""", fields).fetchone()
            if existing:
                return dict(existing)
            record = {"id": uuid.uuid4().hex, "dataset_id": fields[0], "train_id": fields[1], "component": fields[2],
                      "issue": explanation["possible_cause"], "priority": explanation["priority"],
                      "action": " ".join(explanation["actions"]) + f" Evidence timestamp: {detail['evidence_time']}. " + explanation["timeframe"],
                      "status": "open", "created_at": now, "updated_at": now}
            columns = tuple(record)
            connection.execute(f"INSERT INTO work_orders ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", tuple(record.values()))
            return record

    def transition(self, order_id: str, status: str) -> dict:
        if status not in ("open", "in_progress", "completed"):
            raise ValueError("Invalid work-order status.")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM work_orders WHERE id=?", (order_id,)).fetchone()
            if row is None:
                raise KeyError("Work order not found.")
            record = dict(row)
            if record["status"] == status:
                return record
            allowed = {"open": {"in_progress", "completed"}, "in_progress": {"completed"}, "completed": set()}
            if status not in allowed[record["status"]]:
                raise OrderConflict("Work orders advance from open to in progress to completed. Completed records cannot be reopened; create a new order if evidence still needs attention.")
            now = utc_now()
            connection.execute("UPDATE work_orders SET status=?, updated_at=? WHERE id=?", (status, now, order_id))
            record.update(status=status, updated_at=now)
            return record
