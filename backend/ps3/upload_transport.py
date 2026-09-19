"""Bounded, lossless multipart transport for original PS3 recordings.

Gzip is negotiated per CSV part; it is never an archive import. The caller owns
batch cleanup and starts inference only after every original has been saved.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import BinaryIO, Sequence
import zlib

from backend.ps3.service import safe_filename


@dataclass(frozen=True)
class UploadLimits:
    file_bytes: int = 64 * 1024**2
    batch_bytes: int = 1500 * 1024**2
    compressed_file_bytes: int = 64 * 1024**2
    chunk_bytes: int = 64 * 1024

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in
               (self.file_bytes, self.batch_bytes, self.compressed_file_bytes, self.chunk_bytes)):
            raise ValueError('Upload byte limits must be positive integers.')


DEFAULT_LIMITS = UploadLimits()
LIMIT_DETAIL = 'Limits are 64 MiB per file and 1,500 MiB per batch. No partial predictions were created.'


class UploadLimitError(ValueError):
    """The original or compressed transport exceeds its bounded byte allowance."""


def parse_upload_metadata(file_encodings: str | None, wire_names: Sequence[str],
                          extension: str) -> tuple[list[str], list[str]]:
    """Validate all negotiation and original filenames before creating inputs.

The .gz wire suffix deliberately makes old servers reject a compressed part
instead of accidentally treating it as CSV when a deployment has mixed workers.
"""
    if not 1 <= len(wire_names) <= 100:
        raise ValueError('Choose between one and 100 source files.')
    if file_encodings is None:
        encodings = ['identity'] * len(wire_names)
    else:
        if not isinstance(file_encodings, str) or len(file_encodings) > 2048:
            raise ValueError('file_encodings must be a JSON array aligned with the uploaded files.')
        try:
            encodings = json.loads(file_encodings)
        except (ValueError, RecursionError) as exc:
            raise ValueError('file_encodings must be a JSON array aligned with the uploaded files.') from exc
        if (not isinstance(encodings, list) or len(encodings) != len(wire_names)
                or any(not isinstance(value, str) or value not in {'identity', 'gzip'} for value in encodings)):
            raise ValueError('Provide exactly one identity or gzip encoding for each uploaded file.')
    names = []
    for wire_name, encoding in zip(wire_names, encodings):
        if encoding == 'gzip':
            if extension != '.csv' or not wire_name.endswith('.gz') or not wire_name[:-3].lower().endswith('.csv'):
                raise ValueError('Gzip transport requires a CSV source named original.csv.gz.')
            # Only this terminal transport suffix is removed. Gzip headers never
            # choose a filename, and the normal source-path checks still apply.
            name = wire_name[:-3]
        else:
            name = wire_name
        names.append(safe_filename(name, extension))
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('Each uploaded source must have a distinct filename.')
    return names, encodings


def save_uploads(sources: Sequence[BinaryIO], names: Sequence[str], encodings: Sequence[str],
                 inputs: Path, *, limits: UploadLimits = DEFAULT_LIMITS) -> list[Path]:
    """Stream spooled parts to originals with bounded decompression in a worker.

Both wire bytes and expanded bytes are bounded. Only one gzip member is accepted;
CRC, end marker and absence of trailing bytes must all pass before inference.
"""
    if not 1 <= len(sources) <= 100 or len(sources) != len(names) or len(names) != len(encodings):
        raise ValueError('Upload sources, names and encodings must align.')
    for name, encoding in zip(names, encodings):
        if encoding not in {'identity', 'gzip'}:
            raise ValueError('Unsupported upload encoding.')
        extension = '.xlsx' if name.lower().endswith('.xlsx') else '.csv'
        safe_filename(name, extension)
        if encoding == 'gzip' and extension != '.csv':
            raise ValueError('Gzip transport is supported only for CSV sources.')
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError('Each uploaded source must have a distinct filename.')
    paths = []
    total = wire_total = 0
    for source, name, encoding in zip(sources, names, encodings):
        path = inputs / name
        size = wire_size = 0
        decoder = zlib.decompressobj(wbits=31) if encoding == 'gzip' else None
        source.seek(0)
        with path.open('xb') as target:
            while chunk := source.read(limits.chunk_bytes):
                wire_size += len(chunk)
                wire_total += len(chunk)
                wire_limit = limits.compressed_file_bytes if decoder is not None else limits.file_bytes
                if wire_size > wire_limit or wire_total > limits.batch_bytes:
                    raise UploadLimitError(LIMIT_DETAIL)
                if decoder is None:
                    if size + len(chunk) > limits.file_bytes or total + len(chunk) > limits.batch_bytes:
                        raise UploadLimitError(LIMIT_DETAIL)
                    target.write(chunk)
                    size += len(chunk)
                    total += len(chunk)
                    continue
                if decoder.eof:
                    raise ValueError(f'{name} has trailing or concatenated gzip data.')
                pending = chunk
                while True:
                    # The extra byte establishes an over-limit input without
                    # allocating or writing its remaining expanded contents.
                    allowance = min(limits.chunk_bytes, limits.file_bytes - size + 1,
                                    limits.batch_bytes - total + 1)
                    try:
                        expanded = decoder.decompress(pending, max_length=allowance)
                    except zlib.error as exc:
                        raise ValueError(f'{name} is not a valid, complete gzip recording.') from exc
                    if size + len(expanded) > limits.file_bytes or total + len(expanded) > limits.batch_bytes:
                        raise UploadLimitError(LIMIT_DETAIL)
                    target.write(expanded)
                    size += len(expanded)
                    total += len(expanded)
                    if decoder.unused_data:
                        raise ValueError(f'{name} has trailing or concatenated gzip data.')
                    pending = decoder.unconsumed_tail
                    if pending:
                        continue
                    if len(expanded) == allowance and not decoder.eof:
                        # Drain any buffered output with the same bounded call.
                        pending = b''
                        continue
                    break
            if decoder is not None and not decoder.eof:
                raise ValueError(f'{name} is truncated or is not a complete gzip recording.')
            if size == 0:
                raise ValueError(f'{name} is empty.')
        paths.append(path)
    return paths
