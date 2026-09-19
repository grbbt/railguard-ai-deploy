"""Deployment must reject changed artifacts, inputs and predictions."""
import copy

import pytest

from scripts.check_deployment_models import compare_reference, compare_rows


def test_classification_parity_preserves_order_and_labels():
    rows = [{"file_id": "Test1.csv", "prediction": "Side I"}]
    compare_rows(rows, copy.deepcopy(rows), "rail")
    with pytest.raises(ValueError, match="differs"):
        compare_rows(rows, [{"file_id": "Test1.csv", "prediction": "Normal"}], "rail")
    with pytest.raises(ValueError, match="row count"):
        compare_rows(rows, [], "rail")


def test_regression_tolerates_roundoff_but_rejects_changed_or_nonfinite_results():
    rows = [{"file_id": "test01.csv", "prediction": 0.0123456789}]
    compare_rows(rows, [{"file_id": "test01.csv", "prediction": 0.01234567890001}], "shm")
    for invalid in (0.03, float("nan"), float("inf"), True, "0.0123456789"):
        with pytest.raises(ValueError, match="regression"):
            compare_rows(rows, [{"file_id": "test01.csv", "prediction": invalid}], "shm")


@pytest.mark.parametrize("key", ["model_sha256", "metadata_sha256", "sample", "input_sha256"])
def test_reference_binds_model_provenance_and_exact_source(key):
    record = {"model_sha256": "a" * 64, "metadata_sha256": "b" * 64,
              "sample": "Door/Test.csv", "input_sha256": "c" * 64,
              "prediction_rows": [{"prediction": "Normal"}]}
    changed = copy.deepcopy(record)
    changed[key] = "changed"
    with pytest.raises(ValueError, match=key):
        compare_reference(record, changed, "door")
