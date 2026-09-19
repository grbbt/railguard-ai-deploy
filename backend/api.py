"""Loopback FastAPI interface used by every RailGuard screen."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
import re

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from backend.detector import DatasetStore
from backend.orders import OrderConflict, OrderStore
from backend.network import network_data, train_positions
from backend.ps3.service import PS3Service
from backend.ps3.api import router as ps3_router
from backend.ps3.limits import UploadBodyLimit

VERSION = "0.1.0"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
LOGGER = logging.getLogger("railguard")


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: str = Field(min_length=1, max_length=100)
    train_id: str = Field(min_length=1, max_length=300)
    component: str = Field(min_length=1, max_length=300)


class OrderTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = Field(pattern="^(open|in_progress|completed)$")


def create_app(store: DatasetStore | None = None, orders_path: Path | str | None = None, ps3_service: PS3Service | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        try:
            yield
        finally:
            application.state.ps3.close()

    app = FastAPI(title="RailGuard local telemetry API", version=VERSION, lifespan=lifespan)
    app.state.datasets = store or DatasetStore()
    app.state.orders = OrderStore(orders_path or Path(__file__).resolve().parents[1] / "data" / "runtime" / "work_orders.sqlite3")
    app.state.ps3 = ps3_service or PS3Service()
    app.include_router(ps3_router(app.state.ps3))
    app.add_middleware(UploadBodyLimit)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                       allow_methods=["GET", "POST", "PATCH"], allow_headers=["Content-Type"])

    @app.exception_handler(KeyError)
    async def missing_handler(request, exc):
        return JSONResponse(status_code=404, content={"detail": str(exc.args[0])})

    @app.exception_handler(OrderConflict)
    async def conflict_handler(request, exc):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(ValueError)
    async def value_handler(request, exc):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request, exc):
        fields = sorted({str(error["loc"][-1]) for error in exc.errors()})
        return JSONResponse(status_code=422, content={"detail": "Invalid or missing request fields: " + ", ".join(fields) + "."})

    @app.exception_handler(Exception)
    async def failure_handler(request, exc):
        LOGGER.exception("Local API operation failed", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "The local service could not complete this operation. Check the backend log and retry."})

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": VERSION}

    @app.get("/api/dashboard")
    def dashboard(dataset: str = "demo"):
        return app.state.datasets.dashboard(dataset)

    @app.get("/api/network")
    def mrt_network():
        return network_data()

    @app.get("/api/network/positions")
    def mrt_positions(dataset_id: str = "demo"):
        return train_positions(app.state.datasets, dataset_id)

    @app.get("/api/analysis/{dataset_id}/{train_id}/{component}")
    def analysis(dataset_id: str, train_id: str, component: str):
        return app.state.datasets.detail(dataset_id, train_id, component)

    @app.get("/api/analysis")
    def analysis_by_query(dataset_id: str, train_id: str, component: str):
        # Query parameters preserve '/' inside uploaded identifiers, which path
        # segments cannot represent even when the frontend percent-encodes them.
        return app.state.datasets.detail(dataset_id, train_id, component)

    @app.post("/api/datasets")
    async def upload(file: UploadFile = File(...)):
        try:
            if not file.filename or not file.filename.lower().endswith(".csv"):
                raise HTTPException(status_code=415, detail="Upload a .csv file containing timestamped sensor telemetry.")
            raw = bytearray()
            while chunk := await file.read(1024 * 1024):
                raw.extend(chunk)
                if len(raw) > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="CSV uploads are limited to 20 MiB. Split the source file explicitly; no rows were processed or silently truncated.")
            return await run_in_threadpool(app.state.datasets.ingest, bytes(raw), Path(file.filename).name, "uploaded")
        finally:
            await file.close()

    @app.get("/api/datasets/{dataset_id}/export")
    def export(dataset_id: str):
        raw, name = app.state.datasets.export(dataset_id)
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", name)[:100]
        if not safe_name.lower().endswith(".csv"):
            safe_name += ".csv"
        return Response(content=raw, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{safe_name}"'})

    @app.get("/api/orders")
    def orders(dataset_id: str | None = None):
        if dataset_id == "demo":
            dataset_id = app.state.datasets.dashboard("demo")["dataset"]["id"]
        return {"orders": app.state.orders.list(dataset_id)}

    @app.post("/api/orders")
    def create_order(body: OrderCreate):
        detail = app.state.datasets.detail(body.dataset_id, body.train_id, body.component)
        return app.state.orders.create(detail)

    @app.patch("/api/orders/{order_id}")
    def transition_order(order_id: str, body: OrderTransition):
        return app.state.orders.transition(order_id, body.status)

    return app


app = create_app()
