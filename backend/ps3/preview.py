"""Bounded source-value previews that never draw across omitted data gaps."""
from __future__ import annotations

import numpy as np


def sampled_trace_points(x, y, *, break_before=None, max_points: int = 400) -> list[dict]:
    """Keep at most 400 source positions, inserting nulls at broken connections.

    ``break_before[i]`` denotes an acquisition gap between source rows i-1 and i.
    Missing/nonfinite observations anywhere between retained rows also break the
    line. Null markers use the next real source x; no coordinate is interpolated.
    The output has at most 2 * min(max_points, 400) - 1 entries.
    """
    xs, ys = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    if xs.ndim != 1 or ys.ndim != 1 or xs.shape != ys.shape:
        raise ValueError("Trace x and y must be one-dimensional arrays of equal length.")
    if not isinstance(max_points, int) or isinstance(max_points, bool) or max_points < 1:
        raise ValueError("Trace sample limit must be a positive integer.")
    breaks = np.zeros(len(xs), dtype=bool) if break_before is None else np.asarray(break_before, dtype=bool)
    if breaks.shape != xs.shape:
        raise ValueError("Trace acquisition-gap mask must match the source length.")
    if not len(xs):
        return []
    good = np.isfinite(xs) & np.isfinite(ys)
    missing_count = np.cumsum(~good)
    gap_count = np.cumsum(breaks)
    selected = np.unique(np.linspace(0, len(xs) - 1, min(max_points, 400, len(xs)), dtype=int))
    result = []
    previous = None
    for index in selected:
        if not np.isfinite(xs[index]):
            continue
        if previous is not None and good[previous] and good[index]:
            disconnected = missing_count[index] > missing_count[previous] or gap_count[index] > gap_count[previous]
            if disconnected:
                result.append({"x": float(xs[index]), "y": None})
        result.append({"x": float(xs[index]), "y": float(ys[index]) if good[index] else None})
        previous = index
    return result
