# ACV training-only exploratory audit

This analysis used the six released **Train** workbooks, their supplied labels, and the existing training-only feature caches. The official Test workbook was not opened or used. Production code and model artifacts were not modified by this analysis.

## Why the current ranker misses two first choices

- **Case 04:** a distinct 483-column source schema has usable cabin/target/cooling evidence for only cars 01–04. Cars 05–08 have no numeric cabin or target values. The labelled car 01 spends approximately 9.34% of valid cooling observations above target and 13.45% above its peers; competing car 04 spends 26.00% above target and 32.94% above peers. The generic warm-residual feature family therefore points more strongly toward car 04. Both share zero median residual and a peer-gap 90th percentile of 1 raw source unit. The ranking cannot establish a refrigerant leak, and source-specific pressure/fault channels from this one case cannot establish a supervised cross-case relationship.
- **Case 05:** the labelled car 04 has the largest above-target fraction (9.51%) and above-peer fraction (42.30%), while the median/q90 features tie across most cars. The original eight-feature model ranks car 02 first and car 04 second. A smaller feature set can preserve the direct cooling-performance evidence without unrelated spread/warming terms determining the order.

## Bounded comparisons

All learned candidates used the original within-case pairwise logistic procedure, C=0.3, no intercept, and preprocessing fitted on training cases only. No hyperparameter search was run.

| Feature variant | Whole-case LOCO top-1 | LOCO rank-decay | Leave-two-cases-out top-1 |
| --- | --- | --- | --- |
| Original eight features | 4/6 | 0.95833 | 21/30 |
| Within-case ranks for all three fractions | 4/6 | 0.93750 | 21/30 |
| Remove warming fraction | 4/6 | 0.95833 | 21/30 |
| Relative fractions, remove warming | 4/6 | 0.95833 | 22/30 |
| **Above-peer and above-target fractions only** | **5/6** | **0.97917** | **25/30** |
| Within-case ranks of those two fractions | 5/6 | 0.97917 | 25/30 |

The two-feature versions rank the faulty car first in cases 01, 02, 03, 05 and 06, and second in case 04. The 30 leave-two-out predictions reuse the same six cases and are **correlated observations, not 30 independent cases**.

Full rankings and scores for every trial appear in `feature_comparison.json`. The reproducible exploration script is `.cache/acv-improvement/research.py` from the project root. The running-mode inventory is recorded separately in `running_modes.json`.

## Recommendation and limits

Add a single additional candidate using raw **above-peer fraction** and **above-target fraction**. This is a physically interpretable reduction from eight features to two, and avoids needing a new sensor channel or file-specific rule. Retain the original candidates and perform nested whole-case selection before deciding what to publish. Preserve the missing-car and unknown-condition behavior.

These candidate ideas were informed by inspecting errors on all six training cases. Consequently even a nested rerun is a **retrospective audit of this bounded candidate-selection procedure**, not an untouched final evaluation of the full development process. Six acquisition cases remain too few to assert dependable deployment accuracy or infer calibrated failure probabilities. Case 04 remains unresolved by these generic summaries; the uncertainty must remain visible.
