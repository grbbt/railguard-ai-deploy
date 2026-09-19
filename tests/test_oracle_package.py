"""Exercise packaging boundaries with generated files, never the user's secrets/data."""
import hashlib
import json
import os
from pathlib import Path
import tarfile

import pytest

from scripts import package_oracle as package


def put(root, name, content=b"allowed source\n"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    for name in package.FIXED_FILES:
        put(root, name)
    put(root, "backend/api.py", b"print('fixture')\n")
    put(root, "frontend/src/app/page.tsx", b"export default function Page() { return null; }\n")
    for subsystem in package.SUBSYSTEMS:
        base = f"data/ps3_artifacts/{subsystem}"
        model = put(root, f"{base}/model.joblib", f"opaque test fixture: {subsystem}".encode())
        put(root, f"{base}/metadata.json", json.dumps({"subsystem": subsystem,
            "model_sha256": hashlib.sha256(model.read_bytes()).hexdigest()}).encode())
    return root


def add_test_data(root):
    entries = []
    for index, name in enumerate(package.TEST_FILES):
        content = f"official sample {index}\n".encode()
        put(root, f"data/ps3/{name}", content)
        entries.append({"path": name, "type": "blob", "size": len(content),
                        "sha": hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()})
    put(root, "data/ps3/repository-tree.json", json.dumps({"sha": package.RELEASE_COMMIT,
        "truncated": False, "tree": entries}).encode())


def test_minimal_bundle_has_only_active_models_and_verified_inventory(project):
    archive, sidecar, manifest = package.build_bundle(project)
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        assert all(member.isfile() or member.isdir() for member in members)
        assert len({member.name.casefold() for member in members}) == len(members)
        assert bundle.getmember("railguard/frontend/public").isdir()
        assert bundle.getmember("railguard/data/ps3").isdir()
        embedded = json.load(bundle.extractfile(f"railguard/{package.MANIFEST_NAME}"))
        assert embedded == manifest
        assert manifest["file_count"] == len(manifest["files"])
        assert manifest["total_bytes"] == sum(row["bytes"] for row in manifest["files"])
        for row in manifest["files"]:
            member = bundle.getmember(f"railguard/{row['path']}")
            content = bundle.extractfile(member).read()
            assert member.mtime == 0 and member.uid == 0 and member.gid == 0
            assert len(content) == row["bytes"]
            assert hashlib.sha256(content).hexdigest() == row["sha256"]
        artifacts = [member.name for member in members if "/ps3_artifacts/" in member.name]
        assert len(artifacts) == 8
        assert sum(name.endswith("model.joblib") for name in artifacts) == 4
    external = json.loads(sidecar.read_text())
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert external.pop("archive") == {"name": archive.name, "bytes": archive.stat().st_size, "sha256": archive_hash}
    assert external == manifest
    assert archive.with_name(archive.name + ".sha256").read_text() == f"{archive_hash}  {archive.name}\n"
    assert str(project) not in sidecar.read_text()


def test_private_credentials_histories_candidates_and_unexpected_files_are_never_read(project, monkeypatch):
    excluded = [
        ".env", ".env.local", ".ssh/id_rsa", "deploy/oracle/.env", "deploy/oracle/private.pem",
        "deploy/oracle/credentials.json", "backend/.env", "backend/credentials.py", "backend/private/secret.py",
        "frontend/src/.env.local", "frontend/public/id_ed25519", "frontend/node_modules/key.js",
        "frontend/.next/server/page.js", "backend/__pycache__/api.pyc", "data/runtime/ps3_jobs/private/job.json",
        "data/runtime/work_orders.sqlite3", "data/ps3_artifacts/rail/feature_cache/cache.joblib",
        "data/ps3_artifacts/rail/candidate.joblib", "data/ps3_artifacts/acv/validation_predictions.json",
        "data/ps3/PS3/02_Datasets/Door/Train.csv", "data/ps3/PS3/02_Datasets/Rail_Corrugation/Train/a.csv",
        "data/ps3/PS3/02_Datasets/Door/Test.csv", "docs/private.md", "docs/screenshots/private.png",
        "outputs/personal/report.md", "output/previous.tar.gz", "frontend/src/random.txt",
    ]
    forbidden = {put(project, name, b"DO NOT READ OR EXPORT") for name in excluded}
    original = Path.open

    def guarded(path, *args, **kwargs):
        assert path not in forbidden, f"Read excluded input: {path.relative_to(project)}"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    archive, _, manifest = package.build_bundle(project)
    assert not {row["path"] for row in manifest["files"]}.intersection(excluded)
    with tarfile.open(archive) as bundle:
        assert all(b"DO NOT READ OR EXPORT" not in bundle.extractfile(member).read()
                   for member in bundle.getmembers() if member.isfile())


def test_explicit_test_data_includes_only_exact_release_inputs(project):
    add_test_data(project)
    put(project, "data/ps3/PS3/02_Datasets/SHM/Test/personal.csv", b"private upload")
    manifest = package.inventory(project, include_test_data=True)
    names = {row["path"] for row in manifest["files"]}
    expected = {f"data/ps3/{name}" for name in package.TEST_FILES}
    assert len(expected) == 86
    assert expected.issubset(names)
    assert not any("personal" in name or "repository-tree.json" in name or "/Train" in name for name in names)
    assert manifest["includes_official_test_data"] is True


@pytest.mark.parametrize("failure", ["changed_blob", "missing_blob", "wrong_commit", "truncated", "duplicate", "unsafe", "missing_entry"])
def test_invalid_or_modified_test_release_is_rejected(project, failure):
    add_test_data(project)
    path = project / "data/ps3/repository-tree.json"
    catalog = json.loads(path.read_text())
    sample = project / "data/ps3" / package.TEST_FILES[0]
    if failure == "changed_blob":
        sample.write_bytes(b"changed public data")
    elif failure == "missing_blob":
        sample.unlink()
    elif failure == "wrong_commit":
        catalog["sha"] = "0" * 40
    elif failure == "truncated":
        catalog["truncated"] = True
    elif failure == "duplicate":
        catalog["tree"].append(catalog["tree"][0])
    elif failure == "unsafe":
        catalog["tree"].append({"path": "../.env"})
    else:
        catalog["tree"].pop()
    path.write_text(json.dumps(catalog))
    with pytest.raises(package.PackageError):
        package.inventory(project, include_test_data=True)


@pytest.mark.parametrize("name", ["../.env", "/etc/passwd", "C:/key", "a\\..\\key", "a//b", "./a", "a/../b", "a/", "a\x00b", "a\nb", "a./b", "a /b", "nul.py", "COM1/key", "a?b"])
def test_unsafe_archive_paths_rejected(name):
    with pytest.raises(package.PackageError, match="Unsafe archive path"):
        package.safe_name(name)


def test_duplicate_selected_paths_rejected(project, monkeypatch):
    monkeypatch.setattr(package, "FIXED_FILES", (*package.FIXED_FILES, "README.md"))
    with pytest.raises(package.PackageError, match="Duplicate archive path"):
        package.inventory(project)


@pytest.mark.parametrize("kind", ["file", "directory", "allowed_target", "output_directory"])
def test_links_are_rejected_before_target_is_read(project, kind):
    outside = put(project.parent, "outside/private.txt", b"not exported")
    if kind == "file":
        link, target, directory = project / "backend/leak.py", outside, False
    elif kind == "directory":
        link, target, directory = project / "backend/leak", outside.parent, True
    elif kind == "allowed_target":
        link, target, directory = project / "backend/other.py", project / "backend/api.py", False
    else:
        (project / "output").mkdir()
        link, target, directory = project / "output/deploy", outside.parent, True
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError:
        pytest.skip("Creating symlinks is not permitted on this host")
    with pytest.raises(package.PackageError, match="Links are not allowed"):
        package.build_bundle(project)


@pytest.mark.parametrize("detector", ["is_symlink", "is_junction"])
def test_link_guards_also_run_on_hosts_without_symlink_privilege(project, monkeypatch, detector):
    original = getattr(Path, detector, lambda self: False)
    selected = project / "backend/api.py"
    monkeypatch.setattr(Path, detector, lambda self: self == selected or original(self), raising=False)
    with pytest.raises(package.PackageError, match="Links are not allowed"):
        package.inventory(project)


def test_hardlinked_source_is_rejected(project):
    original = project / "backend/api.py"
    os.link(original, project / "backend/linked.py")
    with pytest.raises(package.PackageError, match="regular, unlinked file"):
        package.inventory(project)


def test_model_hash_mismatch_fails_without_deserialization(project):
    put(project, "data/ps3_artifacts/rail/model.joblib", b"replacement model")
    with pytest.raises(package.PackageError, match="Active rail model does not match"):
        package.inventory(project)


@pytest.mark.parametrize("content", [b"-----BEGIN OPENSSH PRIVATE KEY-----", b"OPENAI_API_KEY=sk-proj-" + b"a" * 32])
def test_accidental_credential_in_allowlisted_text_stops_bundle(project, content):
    put(project, "deploy/oracle/.env.example", content)
    with pytest.raises(package.PackageError, match="Credential-like content"):
        package.build_bundle(project)
    assert not (project / "output/deploy/railguard-oracle.tar.gz").exists()


def test_file_count_and_size_limits(project, monkeypatch):
    monkeypatch.setattr(package, "MAX_FILE_BYTES", 1)
    with pytest.raises(package.PackageError, match="size limit"):
        package.inventory(project)
    monkeypatch.setattr(package, "MAX_FILE_BYTES", 256 * 1024**2)
    monkeypatch.setattr(package, "MAX_TOTAL_BYTES", 1)
    with pytest.raises(package.PackageError, match="total size limit"):
        package.inventory(project)
    monkeypatch.setattr(package, "MAX_FILES", 1)
    with pytest.raises(package.PackageError, match="file count limit"):
        package.inventory(project)


def test_existing_output_is_not_overwritten_and_output_stays_in_ignored_directory(project):
    archive, _, _ = package.build_bundle(project)
    original = archive.read_bytes()
    with pytest.raises(package.PackageError, match="already exists"):
        package.build_bundle(project)
    assert archive.read_bytes() == original
    with pytest.raises(package.PackageError, match="output/deploy"):
        package.build_bundle(project, output=project / "unsafe.tar.gz")


def test_archives_are_reproducible_and_shell_files_executable(project):
    first, _, _ = package.build_bundle(project)
    second, _, _ = package.build_bundle(project, output=project / "output/deploy/second.tar.gz")
    assert first.read_bytes() == second.read_bytes()
    with tarfile.open(first) as bundle:
        assert bundle.getmember("railguard/deploy/oracle/start.sh").mode == 0o755
        assert bundle.getmember("railguard/deploy/oracle/.env.example").mode == 0o644


def test_changed_source_after_inventory_never_publishes_archive(project, monkeypatch):
    original = package.inventory

    def changing(*args, **kwargs):
        manifest = original(*args, **kwargs)
        put(project, "backend/api.py", b"a changed file\n")
        return manifest

    monkeypatch.setattr(package, "inventory", changing)
    with pytest.raises(package.PackageError, match="Input changed"):
        package.build_bundle(project)
    assert not list((project / "output/deploy").iterdir())
