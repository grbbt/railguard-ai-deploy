"""Exercise the public gateway's token validation without Docker or credentials."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
GIT_BASH = Path("C:/Program Files/Git/bin/bash.exe")
SHELL = str(GIT_BASH) if os.name == "nt" and GIT_BASH.is_file() else shutil.which("sh")
pytestmark = pytest.mark.skipif(not SHELL, reason="A POSIX shell is needed for gateway validation")
# A syntactically valid fixture, never a real judge credential or usable login.
HASH = "$2b$14$" + "a" * 53


def run_guard(**changes):
    env = {"PATH": os.environ.get("PATH", ""), "DOMAIN": "judge.railguard.test",
           "JUDGE_USER": "judge", "JUDGE_PASSWORD_HASH": HASH}
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    env.update(changes)
    return subprocess.run([SHELL, str(ROOT / "deploy/oracle/caddy-entrypoint.sh"), "true"],
                          env=env, capture_output=True, text=True, timeout=10, check=False)


def test_config_accepts_independent_safe_tokens():
    assert run_guard().returncode == 0


@pytest.mark.parametrize("changes", [
    {"DOMAIN": ""}, {"DOMAIN": "replace-with-your-domain.example.com"},
    {"DOMAIN": "example.com"}, {"DOMAIN": "http://site.example.edu"},
    {"DOMAIN": "site.example.edu/api"}, {"DOMAIN": "site.example.edu\n:80"},
    {"DOMAIN": "site.example.edu { respond OK }"},
    {"JUDGE_USER": ""}, {"JUDGE_USER": "replace-with-judge-user"},
    {"JUDGE_USER": "judge\nadmin"}, {"JUDGE_USER": "judge otheruser"},
    {"JUDGE_PASSWORD_HASH": ""}, {"JUDGE_PASSWORD_HASH": "a-plain-password"},
    {"JUDGE_PASSWORD_HASH": HASH.replace("$", "$$")},
    {"JUDGE_PASSWORD_HASH": HASH + "\n"},
])
def test_config_refuses_defaults_injection_and_plain_passwords(changes):
    result = run_guard(**changes)
    assert result.returncode != 0
    assert "Refusing to start:" in result.stderr
    assert HASH not in result.stderr


def test_shell_sources_use_unix_line_endings_and_parse():
    for path in sorted((ROOT / "deploy/oracle").glob("*.sh")):
        assert b"\r" not in path.read_bytes(), path.name
        parsed = subprocess.run([SHELL, "-n", str(path)], capture_output=True, text=True, timeout=10)
        assert parsed.returncode == 0, parsed.stderr
