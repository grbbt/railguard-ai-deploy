"""Train PS3 models on organiser Train inputs and persist measured validation."""
from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.ps3.service import SUBSYSTEMS  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subsystems', nargs='+', choices=list(SUBSYSTEMS), default=list(SUBSYSTEMS))
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data/ps3/PS3/02_Datasets')
    parser.add_argument('--artifacts-dir', type=Path, default=ROOT / 'data/ps3_artifacts')
    args = parser.parse_args()
    for subsystem in args.subsystems:
        module = importlib.import_module(f'backend.ps3.{subsystem}')
        directory = args.data_dir / SUBSYSTEMS[subsystem]['folder']
        if not directory.is_dir():
            raise SystemExit(f'{directory} is missing. Run scripts/fetch_ps3.py first.')
        print(f'Training {subsystem} from labelled training data only...', flush=True)
        metadata = module.train(directory, args.artifacts_dir / subsystem)
        validation = metadata.get('validation', {})
        print(json.dumps({'subsystem': subsystem, 'model': metadata.get('model_name'),
                          'metric': validation.get('metric'), 'local_validation_score': validation.get('score'),
                          'method': validation.get('method')}, ensure_ascii=False), flush=True)
    print('Saved models are ready for frozen inference. Local validation is not official hidden-test performance.', flush=True)


if __name__ == '__main__':
    main()
