"""Exercise multi-workbook ACV uploads with actual parsing and frozen inference.

These small generated workbooks test application behavior, not railway model
accuracy. No released training or Test recordings are used here.
"""
from datetime import datetime, timedelta, timezone
import csv
import hashlib
import io
import json
import time
import zipfile

from fastapi.testclient import TestClient
import joblib
from openpyxl import Workbook
import pytest

from backend.api import create_app
from backend.ps3 import acv
from backend.ps3.service import PS3Service


def workbook_bytes(hot_car="01", unavailable=()):
    workbook = Workbook()
    sheet = workbook.active
    fields = ["Indoor Average Temperature", "ACV Control Temperature (Cooling)",
              "ACV Running Mode", "ACV Setting Mode", "ACV Information Valid"]
    sheet.append(["Time"] + [f"Car {car:02} - {field}" for car in range(1, 9) for field in fields])
    for sample in range(8):
        row = [datetime(2023, 1, 1) + timedelta(seconds=sample * 30)]
        for car in range(1, 9):
            identity = f"{car:02}"
            row.extend([None] * len(fields) if identity in unavailable else
                       [24 + (4 if identity == hot_car else car / 20) + sample / 100,
                        24, "Full Cooling", "Centralized Control", "Valid"])
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


@pytest.fixture
def acv_client(tmp_path):
    artifacts = tmp_path / "models" / "acv"
    artifacts.mkdir(parents=True)
    # A deterministic frozen reference model isolates batch behavior from model
    # selection while retaining the production loader and feature extraction.
    joblib.dump(acv._fit(acv.BASELINE, [], {}), artifacts / "model.joblib")
    model_hash = hashlib.sha256((artifacts / "model.joblib").read_bytes()).hexdigest()
    metadata = {
        "subsystem": "acv", "artifact_version": acv.VERSION,
        "model_name": acv.BASELINE, "feature_names": acv.FEATURES,
        "model_sha256": model_hash, "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_files": 1, "training_rows": 8,
        "validation": {"metric": "Synthetic fixture only", "score": None,
                       "method": "No model accuracy claim", "candidates": [],
                       "limitations": ["Generated test fixture, not measured model performance."]},
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    service = PS3Service(tmp_path / "data", tmp_path / "models", tmp_path / "jobs")
    app = create_app(orders_path=tmp_path / "orders.sqlite3", ps3_service=service)
    with TestClient(app) as client:
        yield client, service, model_hash


def completed_job(client, job_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/ps3/jobs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"completed", "failed"}:
            return job
        time.sleep(.01)
    raise AssertionError("ACV fixture batch did not finish")


def test_acv_batch_preserves_independent_case_rankings_and_exports(acv_client):
    client, _, model_hash = acv_client
    sources = [("case_a.xlsx", workbook_bytes("02")),
               ("case_b.xlsx", workbook_bytes("07")),
               ("case_partial.xlsx", workbook_bytes("03", unavailable=("05", "06", "07", "08")))]
    response = client.post("/api/ps3/jobs", data={"subsystem": "acv"},
                           files=[("files", (name, content)) for name, content in sources])
    assert response.status_code == 202
    job = completed_job(client, response.json()["id"])
    assert job["status"] == "completed"
    assert job["progress"]["completed"] == job["progress"]["total"] == 3
    assert job["model_sha256"] == model_hash
    assert [report["file_id"] for report in job["reports"]] == [name for name, _ in sources]
    assert [report["prediction_rows"][0]["ranked_cars"].split("|")[0]
            for report in job["reports"]] == ["02", "07", "03"]
    for report, (_, content) in zip(job["reports"], sources):
        assert report["input_sha256"] == hashlib.sha256(content).hexdigest()
        assert report["prediction_rows"][0]["file_id"] == report["file_id"]
    partial = job["reports"][2]
    assert {entity["id"] for entity in partial["entities"] if entity["status"] == "unavailable"} == {"05", "06", "07", "08"}
    assert partial["prediction_rows"][0]["ranked_cars"].endswith("05|06|07|08")
    downloaded = client.get(f"/api/ps3/jobs/{job['id']}/csv")
    assert downloaded.status_code == 200
    assert list(csv.DictReader(io.StringIO(downloaded.text))) == [report["prediction_rows"][0] for report in job["reports"]]
    exported = client.post("/api/ps3/export", json={"job_ids": [job["id"]]})
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert archive.namelist() == ["acv_predictions.csv"]
        assert archive.read("acv_predictions.csv") == downloaded.content


def test_acv_bad_second_workbook_blocks_partial_batch_export(acv_client):
    client, _, _ = acv_client
    response = client.post("/api/ps3/jobs", data={"subsystem": "acv"}, files=[
        ("files", ("good.xlsx", workbook_bytes())),
        ("files", ("broken.xlsx", b"This is not an Excel workbook")),
    ])
    assert response.status_code == 202
    job = completed_job(client, response.json()["id"])
    assert job["status"] == "failed"
    assert job["progress"]["completed"] == 1
    assert job["reports"] == []
    assert "workbook" in job["error"].lower()
    assert client.get(f"/api/ps3/jobs/{job['id']}/csv").status_code == 422
    assert client.post("/api/ps3/export", json={"job_ids": [job["id"]]}).status_code == 422


def test_acv_case_insensitive_duplicate_upload_names_rejected_before_job(acv_client):
    client, service, _ = acv_client
    content = workbook_bytes()
    response = client.post("/api/ps3/jobs", data={"subsystem": "acv"}, files=[
        ("files", ("same.xlsx", content)), ("files", ("SAME.xlsx", content)),
    ])
    assert response.status_code == 422
    assert "distinct filename" in response.json()["detail"]
    assert not list(service.jobs_dir.glob("*/job.json"))


def test_acv_combined_jobs_export_all_distinct_cases(acv_client):
    client, _, _ = acv_client
    jobs = []
    for name, hot in [("first.xlsx", "01"), ("second.xlsx", "06")]:
        response = client.post("/api/ps3/jobs", data={"subsystem": "acv"},
                               files=[("files", (name, workbook_bytes(hot)))])
        assert response.status_code == 202
        job = completed_job(client, response.json()["id"])
        assert job["status"] == "completed"
        jobs.append(job)
    exported = client.post("/api/ps3/export", json={"job_ids": [job["id"] for job in jobs]})
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        rows = list(csv.DictReader(io.StringIO(archive.read("acv_predictions.csv").decode())))
    assert [row["file_id"] for row in rows] == ["first.xlsx", "second.xlsx"]
    assert [row["ranked_cars"].split("|")[0] for row in rows] == ["01", "06"]
