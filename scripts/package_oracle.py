"""Build a bounded deployment archive from an explicit source/data allowlist.

No network, credential files, model unpickling, Train data, saved runs or caches
are needed. Only this checkout's four active model/metadata pairs are packaged.
The default bundle supports uploads; --include-test-data adds the pinned public
Test inputs. Run the separate deployment model check before trusting artifacts.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "railguard"
MANIFEST_NAME = "DEPLOYMENT_MANIFEST.json"
RELEASE_COMMIT = "16526c02579c7f37e54eaaa42a4cc6d4ceb19994"
SUBSYSTEMS = ("door", "acv", "rail", "shm")
MAX_FILES = 2000
MAX_FILE_BYTES = 256 * 1024**2
MAX_TOTAL_BYTES = 3 * 1024**3
BLOCK_SIZE = 1024**2

# Exact deployment/configuration names keep future credential/config files out.
DEPLOY_FILES = (
    "compose.yaml", "backend.Dockerfile", "backend.Dockerfile.dockerignore",
    "frontend.Dockerfile", "frontend.Dockerfile.dockerignore", "Caddyfile",
    "caddy-entrypoint.sh", ".env.example", "common.sh", "start.sh", "verify.sh", "backup.sh",
    "README.md", "model-reference.json",
)
DOC_FILES = (
    "UNIFIED_WORKSPACE.md", "INVESTIGATION_AGENT.md", "AI_SECURITY.md",
    "RESULT_SUMMARIES.md", "SUBMISSION_HOSTING_PLAN.md", "PS3_IMPLEMENTATION.md",
    "PS3_IMPLEMENTATION_CONTRACT.md", "PS3_RELEASE_REVIEW.md", "ACV_MODEL_REVIEW.md",
    "NETWORK_DATA.md", "ROLLING_STOCK.md", "UI_DESIGN.md", "API_CONTRACT.md",
    "IMPLEMENTATION.md", "ORACLE_DEPLOYMENT.md",
)
REFERENCE_FILES = (
    "PS3/01_Problem_Statement_3_Specifications.md",
    "PS3/03_References/Door/Door_Subsystem_Info_Kit.md",
    "PS3/03_References/Door/Door Data Headers.md",
    "PS3/03_References/ACV/ACV_Subsystem_Info_Kit.md",
    "PS3/03_References/Rail_Corrugation/Rail_Corrugation_Info_Kit.md",
    "PS3/03_References/SHM/SHM_Info_Kit.md",
)
FIXED_FILES = (
    "README.md", "requirements.txt", "requirements-lock.txt",
    "frontend/package.json", "frontend/package-lock.json", "frontend/next.config.ts",
    "frontend/next-env.d.ts", "frontend/tsconfig.json", "frontend/eslint.config.mjs",
    "data/network/singapore-mrt.json", "data/metadata.json", "data/README.md",
    "scripts/package_oracle.py", "scripts/check_deployment_models.py", "scripts/train_ps3.py",
    *(f"docs/{name}" for name in DOC_FILES),
    *(f"deploy/oracle/{name}" for name in DEPLOY_FILES),
    *(f"data/ps3/{name}" for name in REFERENCE_FILES),
    *(f"data/ps3_artifacts/{name}/{file}" for name in SUBSYSTEMS
      for file in ("model.joblib", "metadata.json")),
)
TEST_FILES = (
    "PS3/02_Datasets/Door/Test.csv",
    "PS3/02_Datasets/ACV/Test/acv_test_case.xlsx",
    *(f"PS3/02_Datasets/Rail_Corrugation/Test/Test{i}.csv" for i in range(1, 69)),
    *(f"PS3/02_Datasets/SHM/Test/test{i:02d}.csv" for i in range(1, 17)),
)
SOURCE_TREES = {
    "backend": frozenset({".py"}),
    "frontend/src": frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".svg", ".ico"}),
    "frontend/public": frozenset({".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2"}),
}
SKIP_DIRECTORIES = frozenset({"__pycache__", "node_modules", "runtime", "uploads", "private", "history", "secrets"})
SENSITIVE_STEM = re.compile(r"(?:^|[._-])(?:secret|secrets|credential|credentials|id_rsa|id_ed25519)(?:$|[._-])", re.I)
SECRET_CONTENT = re.compile(rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}")


class PackageError(ValueError):
    """A selected input does not satisfy the deployment archive boundary."""


def safe_name(name: str) -> str:
    """Require a portable, unambiguous POSIX archive member name."""
    if (not isinstance(name, str) or not name or "\\" in name or ":" in name
            or any(ord(char) < 32 or ord(char) == 127 or char in '<>"|?*' for char in name)
            or PurePosixPath(name).is_absolute()
            or any(part in {"", ".", ".."} or part.endswith((".", " "))
                   or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.I)
                   for part in name.split("/"))):
        raise PackageError("Unsafe archive path")
    return name


def checked_path(root: Path, name: str, *, directory: bool = False) -> Path:
    """Check every component before resolving/reading; never follow links."""
    safe_name(name)
    path = root
    for part in PurePosixPath(name).parts:
        path = path / part
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise PackageError(f"Links are not allowed in selected input: {name}")
    try:
        info = path.stat()
    except FileNotFoundError as exc:
        raise PackageError(f"Required input is missing: {name}") from exc
    if not path.resolve().is_relative_to(root):
        raise PackageError(f"Selected input escapes the project: {name}")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise PackageError(f"Expected a directory: {name}")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
        raise PackageError(f"Expected a regular, unlinked file: {name}")
    elif info.st_size > MAX_FILE_BYTES:
        raise PackageError(f"Selected file exceeds the size limit: {name}")
    return path


def selected_names(root: Path, include_test_data: bool) -> list[str]:
    names = list(FIXED_FILES)
    for relative, extensions in SOURCE_TREES.items():
        base = root / relative
        if relative == "frontend/public" and not base.exists():
            continue  # The archive supplies the empty directory needed by Docker.
        checked_path(root, relative, directory=True)
        count = 0
        for current, directories, files in os.walk(base, followlinks=False):
            count += len(directories) + len(files)
            if count > MAX_FILES * 4:
                raise PackageError(f"Source tree exceeds the entry limit: {relative}")
            directories[:] = sorted(name for name in directories
                                    if not name.startswith(".") and name.casefold() not in SKIP_DIRECTORIES)
            for name in directories:
                checked_path(root, (Path(current) / name).relative_to(root).as_posix(), directory=True)
            for name in sorted(files):
                if name.startswith(".") or SENSITIVE_STEM.search(name) or Path(name).suffix not in extensions:
                    continue
                if ".test." in name:
                    continue
                names.append((Path(current) / name).relative_to(root).as_posix())
    if include_test_data:
        names.extend(f"data/ps3/{name}" for name in TEST_FILES)
    if len(names) > MAX_FILES:
        raise PackageError("Bundle exceeds the file count limit")
    seen = set()
    for name in names:
        key = safe_name(name).casefold()
        if key in seen:
            raise PackageError(f"Duplicate archive path: {name}")
        seen.add(key)
        checked_path(root, name)
    return sorted(names)


def test_release_entries(root: Path) -> dict:
    path = checked_path(root, "data/ps3/repository-tree.json")
    if path.stat().st_size > 8 * 1024**2:
        raise PackageError("Release catalog exceeds the size limit")
    catalog = json.loads(path.read_text(encoding="utf-8-sig"))
    if catalog.get("sha") != RELEASE_COMMIT or catalog.get("truncated"):
        raise PackageError("Expected the complete pinned public release catalog")
    records = catalog.get("tree")
    if not isinstance(records, list) or len(records) > 10000:
        raise PackageError("Invalid release catalog")
    entries, seen = {}, set()
    for record in records:
        name = safe_name(record.get("path"))
        if name.casefold() in seen:
            raise PackageError("Duplicate release catalog path")
        seen.add(name.casefold())
        if name in TEST_FILES:
            if (record.get("type") != "blob" or not re.fullmatch(r"[0-9a-f]{40}", record.get("sha", ""))
                    or type(record.get("size")) is not int or not 0 <= record["size"] <= MAX_FILE_BYTES):
                raise PackageError("Invalid public Test catalog record")
            entries[f"data/ps3/{name}"] = record
    if len(entries) != len(TEST_FILES):
        raise PackageError("Pinned catalog does not contain every expected Test input")
    return entries


def file_digests(path: Path, *, check_secrets: bool = False) -> tuple[int, str, str]:
    size = path.stat().st_size
    sha = hashlib.sha256()
    git = hashlib.sha1(f"blob {size}\0".encode())
    read_size = 0
    overlap = b""
    with path.open("rb") as handle:
        while block := handle.read(BLOCK_SIZE):
            read_size += len(block)
            if read_size > MAX_FILE_BYTES:
                raise PackageError("Selected file exceeds the size limit")
            if check_secrets and SECRET_CONTENT.search(overlap + block):
                raise PackageError("Credential-like content detected in an allowlisted text file; bundle not created")
            overlap = block[-256:]
            sha.update(block)
            git.update(block)
    if read_size != size:
        raise PackageError("Input changed while being inspected; retry with a stable checkout")
    return size, sha.hexdigest(), git.hexdigest()


def inventory(root: Path, include_test_data: bool = False) -> dict:
    root = root.resolve()
    names = selected_names(root, include_test_data)
    release = test_release_entries(root) if include_test_data else {}
    records = []
    total = 0
    for name in names:
        path = checked_path(root, name)
        text_input = path.suffix.lower() not in {".joblib", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2"}
        size, sha, git = file_digests(path, check_secrets=text_input)
        if name in release and (size != release[name]["size"] or git != release[name]["sha"]):
            raise PackageError(f"Public Test input differs from its pinned release blob: {name}")
        total += size
        if total > MAX_TOTAL_BYTES:
            raise PackageError("Bundle exceeds the total size limit")
        records.append({"path": name, "bytes": size, "sha256": sha})
    hashes = {record["path"]: record["sha256"] for record in records}
    for subsystem in SUBSYSTEMS:
        base = f"data/ps3_artifacts/{subsystem}"
        metadata = json.loads(checked_path(root, f"{base}/metadata.json").read_text(encoding="utf-8"))
        if metadata.get("subsystem") != subsystem or metadata.get("model_sha256") != hashes[f"{base}/model.joblib"]:
            raise PackageError(f"Active {subsystem} model does not match its metadata")
    return {"schema_version": 1, "archive_prefix": PREFIX, "release_commit": RELEASE_COMMIT,
            "includes_official_test_data": include_test_data, "file_count": len(records),
            "total_bytes": total, "files": records}


def tar_info(name: str, size: int = 0, *, directory: bool = False) -> tarfile.TarInfo:
    member = tarfile.TarInfo(safe_name(name))
    member.size = size
    member.mode = 0o755 if directory or name.endswith(".sh") else 0o644
    member.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    member.mtime = 0
    return member


class HashingReader:
    def __init__(self, handle):
        self.handle = handle
        self.sha = hashlib.sha256()

    def read(self, size=-1):
        data = self.handle.read(size)
        self.sha.update(data)
        return data


def build_bundle(root: Path = ROOT, *, include_test_data: bool = False,
                 output: Path | None = None) -> tuple[Path, Path, dict]:
    root = root.resolve()
    manifest = inventory(root, include_test_data)
    output = Path(os.path.abspath(output or root / "output/deploy/railguard-oracle.tar.gz"))
    expected_dir = root / "output/deploy"
    if output.parent != expected_dir or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz", output.name):
        raise PackageError("Output must be a .tar.gz file directly in this project's output/deploy directory")
    for name in ("output", "output/deploy"):
        path = root / name
        if path.exists() or path.is_symlink():
            checked_path(root, name, directory=True)
        else:
            path.mkdir()
    sidecar = output.with_name(output.name.removesuffix(".tar.gz") + ".manifest.json")
    checksum = output.with_name(output.name + ".sha256")
    for path in (output, sidecar, checksum):
        if path.exists() or path.is_symlink():
            checked_path(root, path.relative_to(root).as_posix())
            raise PackageError("Output already exists; choose a new --output filename")
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    partial = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".bundle-", suffix=".tmp", dir=expected_dir, delete=False) as raw:
            partial = Path(raw.name)
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6) as zipped:
                with tarfile.open(mode="w|", fileobj=zipped, format=tarfile.PAX_FORMAT) as archive:
                    for directory in (PREFIX, f"{PREFIX}/frontend/public", f"{PREFIX}/data/ps3"):
                        archive.addfile(tar_info(directory, directory=True))
                    for record in manifest["files"]:
                        path = checked_path(root, record["path"])
                        if path.stat().st_size != record["bytes"]:
                            raise PackageError("Input changed after inventory; retry with a stable checkout")
                        with path.open("rb") as source:
                            reader = HashingReader(source)
                            archive.addfile(tar_info(f"{PREFIX}/{record['path']}", record["bytes"]), reader)
                            if reader.sha.hexdigest() != record["sha256"] or source.read(1):
                                raise PackageError("Input changed after inventory; retry with a stable checkout")
                    archive.addfile(tar_info(f"{PREFIX}/{MANIFEST_NAME}", len(manifest_bytes)), io.BytesIO(manifest_bytes))
        # Link-free temporary output is renamed only after every source hash agrees.
        partial.rename(output)
        partial = None
        archive_hash = hashlib.sha256()
        with output.open("rb") as handle:
            while block := handle.read(BLOCK_SIZE):
                archive_hash.update(block)
        sidecar_manifest = {**manifest, "archive": {"name": output.name, "bytes": output.stat().st_size,
                                                  "sha256": archive_hash.hexdigest()}}
        with sidecar.open("xb") as handle:
            handle.write((json.dumps(sidecar_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        with checksum.open("x", encoding="ascii", newline="\n") as handle:
            handle.write(f"{archive_hash.hexdigest()}  {output.name}\n")
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)
    return output, sidecar, manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-test-data", action="store_true", help="Include all 86 pinned public Test inputs (about 1.28 GB before compression)")
    parser.add_argument("--output", type=Path, help="New .tar.gz filename within output/deploy; existing archives are never overwritten")
    args = parser.parse_args()
    try:
        archive, sidecar, manifest = build_bundle(include_test_data=args.include_test_data, output=args.output)
    except (PackageError, OSError, ValueError, TypeError) as exc:
        parser.exit(1, f"Package failed: {exc}\n")
    print(json.dumps({"archive": archive.relative_to(ROOT).as_posix(),
                      "manifest": sidecar.relative_to(ROOT).as_posix(),
                      "checksum": archive.relative_to(ROOT).as_posix() + ".sha256",
                      "files": manifest["file_count"], "source_bytes": manifest["total_bytes"],
                      "archive_bytes": archive.stat().st_size,
                      "includes_official_test_data": args.include_test_data}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
