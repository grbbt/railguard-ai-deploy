# Synthetic telemetry fixtures

All measurements, names, operating conditions, and scenarios in this directory are generated demonstration data. They are not railway operator records or verified fault evidence. No model performance, diagnostic accuracy, maintenance outcome, or physical failure probability is implied by these files.

Run `python -m backend.synthetic --output data` from the project root to regenerate them. The default seed is 42. The default 9,216 records comprise eight synthetic trains, four components, and 288 five-minute observations per train/component, beginning at `2026-09-01T00:00:00Z`. The last observation is `2026-09-01T23:55:00Z`. The fixed seed, timestamps, and stable CSV formatting make regeneration reproducible.

| File | Purpose |
| --- | --- |
| `railguard_synthetic_mixed.csv` | Three substantial sustained changes and two smaller gradual changes across five train/component pairs. |
| `railguard_synthetic_healthy.csv` | Same underlying generated fleet without injected changes. A detector may still produce false positives. |
| `railguard_synthetic_missing.csv` | Mixed scenario plus reproducible missing readings; the final 12 door observations for RG-102 have neither applicable sensor. |
| `railguard_synthetic_quoted.csv` | Identical mixed readings with all fields quoted to exercise proper CSV parsing. |
| `metadata.json` | Generator provenance, sensor units, exact injection schedule, missing-data definition, and file checksums. |

The first 40% of unique timestamps form a clean reference interval. Injections start after 60% of the series, within monitoring, and remain through the final timestamp. Their exact synthetic start times are evaluation metadata. A model's detected onset can differ and must not be presented as a known physical fault onset.

The long-form schema gives each row one train and one component. Bogies have vibration RMS and bearing temperature; doors have door current and cycle duration; brakes have cylinder pressure and temperature; motors have traction current and temperature. Other component sensors are intentionally blank, because those measurements do not apply to that row. Those structural blanks must be distinguished from missing applicable measurements. Speed and ambient temperature are shared operating context.

These are illustrative five-minute feature aggregates, not raw waveforms or instantaneous actuator signals. Modest speed, ambient temperature, train-to-train offsets, and an unobserved operating-load cycle influence relevant features. Several benign operating cycles occur in both the reference and monitoring periods. The distributions and offsets are chosen for a useful demonstration, not calibrated from a real train fleet.

`injected_anomaly` is 1 only during a planted change. `scenario` names the synthetic condition. Both columns are **evaluation annotations only** and must be excluded from detector inputs. Neither is a verified fault label, so they do not justify supervised fault-classification claims. The generator never fills an absent observed measurement with a normal value. The missing fixture records gaps as empty CSV fields, for preprocessing to handle separately from what the interface displays.
