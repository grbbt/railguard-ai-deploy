# Synthetic browser QA fixtures

These inputs contain no operational train data.

- `browser_partial.csv`: 160 rows, two custom sensors, `SET/A` and `SET-B`, and deliberate recent missing readings for SET-B. The Ground Truth field is an excluded label. NumPy default RNG seed 8 was used.
- `browser_invalid.csv`: invalid timestamps for validation-error checks.
- `browser_insufficient.csv`: two rows to check an unavailable model/condition state.

The main reproducible scenario generator is `python -m backend.synthetic --output data`.
