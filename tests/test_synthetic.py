"""Validate the synthetic demo contract without claiming detection performance."""

import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd

from backend.synthetic import COMPONENT_SENSORS, COLUMNS, INJECTIONS, START_UTC, generate_dataset, generate_datasets


class SyntheticDatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mixed = generate_dataset()
        cls.healthy = generate_dataset(scenario="healthy")

    def test_schema_counts_and_applicable_sensors(self):
        frame = self.mixed
        self.assertEqual(list(frame.columns), COLUMNS)
        self.assertEqual(len(frame), 8 * 4 * 288)
        self.assertEqual(frame.train_id.nunique(), 8)
        self.assertEqual(frame.groupby(["train_id", "component"]).size().unique().tolist(), [288])
        self.assertFalse(frame.duplicated(["timestamp", "train_id", "component"]).any())
        all_sensors = {s for sensors in COMPONENT_SENSORS.values() for s in sensors}
        for component, sensors in COMPONENT_SENSORS.items():
            subset = frame[frame.component == component]
            self.assertTrue(subset[list(sensors)].notna().all().all())
            self.assertTrue(subset[list(all_sensors - set(sensors))].isna().all().all())

    def test_repeatable_seed_and_parameter_effect(self):
        pd.testing.assert_frame_equal(self.mixed, generate_dataset())
        self.assertFalse(self.mixed.vibration_mm_s.equals(generate_dataset(seed=43).vibration_mm_s))

    def test_fixed_utc_timestamps_every_five_minutes(self):
        ticks = pd.DatetimeIndex(pd.to_datetime(self.mixed.timestamp.unique(), utc=True))
        self.assertEqual(ticks[0], pd.Timestamp(START_UTC))
        self.assertEqual(len(ticks), 288)
        self.assertEqual(ticks.to_series().diff().dropna().unique().tolist(), [pd.Timedelta(minutes=5)])

    def test_reference_clean_and_changes_only_in_monitoring(self):
        ticks = self.mixed.timestamp.unique()
        reference = self.mixed[self.mixed.timestamp.isin(ticks[:int(288 * 0.4)])]
        self.assertEqual(int(reference.injected_anomaly.sum()), 0)
        self.assertEqual(self.mixed[self.mixed.timestamp.isin(ticks[:int(288 * 0.6)])].injected_anomaly.sum(), 0)
        labelled = self.mixed[self.mixed.injected_anomaly == 1]
        expected_pairs = {(x["train_id"], x["component"]) for x in INJECTIONS}
        self.assertEqual(set(zip(labelled.train_id, labelled.component)), expected_pairs)
        self.assertEqual(sum(x["kind"] == "sustained" for x in INJECTIONS), 3)
        self.assertEqual(sum(x["kind"] == "drift" for x in INJECTIONS), 2)
        self.assertTrue(labelled.scenario.str.startswith("synthetic_").all())
        self.assertEqual(self.mixed.attrs["source"], "synthetic")

    def test_healthy_contains_no_injected_labels_and_untouched_values_match(self):
        self.assertEqual(int(self.healthy.injected_anomaly.sum()), 0)
        self.assertEqual(set(self.healthy.scenario), {"synthetic_nominal"})
        untouched = self.mixed.injected_anomaly == 0
        pd.testing.assert_frame_equal(self.mixed.loc[untouched], self.healthy.loc[untouched], check_flags=False)

    def test_missing_retains_observations_and_real_gaps(self):
        missing = generate_dataset(scenario="missing")
        self.assertEqual(len(missing), len(self.mixed))
        self.assertTrue(missing.injected_anomaly.equals(self.mixed.injected_anomaly))
        for sensors in COMPONENT_SENSORS.values():
            for sensor in sensors:
                self.assertGreater(missing[sensor].isna().sum(), self.mixed[sensor].isna().sum())
                existing = missing[sensor].notna()
                pd.testing.assert_series_equal(missing.loc[existing, sensor], self.mixed.loc[existing, sensor])
        target = missing[(missing.train_id == "RG-102") & (missing.component == "doors")].tail(12)
        self.assertTrue(target[list(COMPONENT_SENSORS["doors"])].isna().all().all())

    def test_files_quote_roundtrip_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = generate_datasets(Path(directory), periods=48)
            self.assertEqual(metadata["source"], "synthetic")
            self.assertIn("not a confirmed fault", metadata["label_definition"])
            self.assertIn("injected_anomaly", metadata["exclude_from_model"])
            mixed = pd.read_csv(Path(directory) / metadata["files"]["mixed"]["filename"])
            quoted = pd.read_csv(Path(directory) / metadata["files"]["quoted"]["filename"])
            pd.testing.assert_frame_equal(mixed, quoted)
            disk = json.loads((Path(directory) / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(disk["files"], metadata["files"])
            repeated = generate_datasets(Path(directory), periods=48)
            self.assertEqual(metadata["files"], repeated["files"])

    def test_bad_parameters_are_rejected(self):
        for parameters in ({"scenario": "real"}, {"periods": 0}, {"periods": True}, {"seed": -1}):
            with self.subTest(parameters=parameters), self.assertRaises(ValueError):
                generate_dataset(**parameters)


if __name__ == "__main__":
    unittest.main()
